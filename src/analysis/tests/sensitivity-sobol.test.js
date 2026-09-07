import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SOBOL_LIMITS, sobolJansenSensitivity } from "../sensitivity-sobol.js";
import { createSubstream, deriveSeed } from "../random.js";

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("Sobol–Jansen approximates canonical Ishigami first and total indices", () => {
  const a = 7;
  const b = 0.1;
  const result = sobolJansenSensitivity({
    seed: 20260821,
    sampleCount: 12_000,
    distributions: {
      x1: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
      x2: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
      x3: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
    },
    evaluator: ({ x1, x2, x3 }) => Math.sin(x1) + a * Math.sin(x2) ** 2 + b * x3 ** 4 * Math.sin(x1),
  });
  close(result.byParameter.x1.firstOrder, 0.3139, 0.045);
  close(result.byParameter.x2.firstOrder, 0.4424, 0.045);
  close(result.byParameter.x3.firstOrder, 0, 0.05);
  close(result.byParameter.x1.totalOrder, 0.5576, 0.05);
  close(result.byParameter.x2.totalOrder, 0.4424, 0.045);
  close(result.byParameter.x3.totalOrder, 0.2437, 0.05);
});

const unitDistributions = {
  x: { type: "uniform", minimum: 0, maximum: 1 },
  y: { type: "uniform", minimum: 0, maximum: 1 },
};

function referenceIndices(a, b, mixed, rows) {
  const pooled = rows.map((row) => a[row]).concat(rows.map((row) => b[row]));
  const mean = pooled.reduce((sum, value) => sum + value, 0) / pooled.length;
  const variance = pooled.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (pooled.length - 1);
  if (!(variance > 0)) return null;
  return {
    firstOrder: 1 - rows.reduce((sum, row) => sum + (b[row] - mixed[row]) ** 2, 0) / (2 * rows.length * variance),
    totalOrder: rows.reduce((sum, row) => sum + (a[row] - mixed[row]) ** 2, 0) / (2 * rows.length * variance),
  };
}

function referenceInterval(values, confidenceLevel) {
  const sorted = [...values].sort((a, b) => a - b);
  return [(1 - confidenceLevel) / 2, (1 + confidenceLevel) / 2].map((probability) => {
    const index = (sorted.length - 1) * probability;
    const lower = Math.floor(index);
    return sorted[lower] + (index - lower) * (sorted[Math.ceil(index)] - sorted[lower]);
  });
}

function referenceStandardError(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
}

test("Sobol preserves A_Bi mixing and bootstraps entire paired rows with a fixed seed", () => {
  const sampleCount = 24;
  const bootstrapReplicates = 80;
  const bootstrapSeed = 9876;
  const confidenceLevel = 0.9;
  const recorded = { A: [], B: [], mixed: { x: [], y: [] } };
  const parameters = { A: [], B: [] };
  let calls = 0;
  const result = sobolJansenSensitivity({
    distributions: unitDistributions,
    sampleCount, seed: 345, bootstrapReplicates, bootstrapSeed, confidenceLevel,
    evaluator: ({ x, y }, context) => {
      calls += 1;
      const value = x + 2 * y + x * y;
      if (context.matrix === "A_Bi") {
        const expected = { ...parameters.A[context.row], [context.parameter]: parameters.B[context.row][context.parameter] };
        assert.deepEqual({ x, y }, expected);
        recorded.mixed[context.parameter][context.row] = value;
      } else {
        parameters[context.matrix][context.row] = { x, y };
        recorded[context.matrix][context.row] = value;
      }
      return { value, affine: 17 - 3 * value };
    },
  });
  assert.equal(calls, sampleCount * 4, "bootstrap must reuse cached evaluations");
  assert.equal(result.evaluationCount, calls);
  assert.ok(result.bootstrap, "paired-row bootstrap metadata is required");
  assert.equal(result.bootstrap.method, "paired_row_percentile");
  assert.equal(result.bootstrap.resamplingUnit, "paired_rows_A_B_A_Bi");
  assert.equal(result.bootstrap.quantileMethod, "R7");
  assert.equal(result.bootstrap.seed, bootstrapSeed);
  assert.equal(result.bootstrap.replicates, bootstrapReplicates);
  assert.equal(result.bootstrap.confidenceLevel, confidenceLevel);

  const rows = Array.from({ length: sampleCount }, (_, index) => index);
  const replicates = Array.from({ length: bootstrapReplicates }, (_, replicate) => {
    const random = createSubstream(bootstrapSeed, "sobol", "bootstrap", replicate);
    return rows.map(() => Math.floor(random.next() * sampleCount));
  });
  for (const name of ["x", "y"]) {
    const point = referenceIndices(recorded.A, recorded.B, recorded.mixed[name], rows);
    const samples = replicates.map((sampled) => referenceIndices(recorded.A, recorded.B, recorded.mixed[name], sampled));
    const output = result.byParameter[name].outputs.value;
    close(output.firstOrder, point.firstOrder, 1e-12);
    close(output.totalOrder, point.totalOrder, 1e-12);
    for (const order of ["firstOrder", "totalOrder"]) {
      const values = samples.map((sample) => sample[order]);
      const expectedInterval = referenceInterval(values, confidenceLevel);
      assert.ok(Array.isArray(output[`${order}Interval`]));
      output[`${order}Interval`].forEach((value, index) => close(value, expectedInterval[index], 1e-12));
      close(output[`${order}StandardError`], referenceStandardError(values), 1e-12);
      result.byParameter[name].outputs.affine[`${order}Interval`].forEach((value, index) => close(value, expectedInterval[index], 1e-12));
    }
    assert.equal(output.precision.assessed, true);
    assert.equal(output.precision.validReplicates, bootstrapReplicates);
    assert.equal(output.precision.invalidReplicates, 0);
  }
});

test("Sobol bootstrap is reproducible, separately seeded, and optional without changing indices", () => {
  const options = {
    distributions: unitDistributions, sampleCount: 128, seed: 123,
    evaluator: ({ x, y }) => x + 2 * y,
  };
  const first = sobolJansenSensitivity(options);
  assert.deepEqual(sobolJansenSensitivity(options), first);
  assert.equal(
    createHash("sha256").update(JSON.stringify(first)).digest("hex"),
    "39580d8075f628f2bc1716f7d4aca8c33de044a962d3340a11a6b89cc301b6f5",
    "default serialized result must match the pre-limit baseline",
  );
  assert.ok(first.bootstrap, "bootstrap is enabled by default");
  assert.equal(first.bootstrap.replicates, 200);
  assert.equal(first.bootstrap.seed, deriveSeed(123, "sobol", "bootstrap"));
  const reseeded = sobolJansenSensitivity({ ...options, bootstrapSeed: 456 });
  const disabled = sobolJansenSensitivity({ ...options, bootstrapReplicates: 0 });
  for (const name of ["x", "y"]) {
    for (const order of ["firstOrder", "totalOrder"]) {
      assert.equal(reseeded.byParameter[name][order], first.byParameter[name][order]);
      assert.equal(disabled.byParameter[name][order], first.byParameter[name][order]);
      assert.notDeepEqual(reseeded.byParameter[name][`${order}Interval`], first.byParameter[name][`${order}Interval`]);
      assert.equal(disabled.byParameter[name][`${order}Interval`], null);
      assert.equal(disabled.byParameter[name][`${order}StandardError`], null);
    }
    assert.equal(disabled.byParameter[name].precision.assessed, false);
    assert.equal(disabled.byParameter[name].precision.imprecise, null);
    assert.ok(disabled.byParameter[name].precision.issues.includes("BOOTSTRAP_DISABLED"));
  }
});

test("Sobol recovers additive variance shares and flags wide intervals without clipping", () => {
  const result = sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 6000, seed: 4567,
    bootstrapReplicates: 100, precisionTolerance: 1e-6,
    evaluator: ({ x, y }) => x + 2 * y,
  });
  for (const [name, share] of [["x", 0.2], ["y", 0.8]]) {
    const output = result.byParameter[name];
    close(output.firstOrder, share, 0.04);
    close(output.totalOrder, share, 0.04);
    assert.ok(Array.isArray(output.firstOrderInterval), "bootstrap interval is required");
    assert.ok(output.firstOrderInterval[1] > output.firstOrderInterval[0]);
    assert.equal(output.precision.imprecise, true);
    assert.ok(output.precision.issues.includes("WIDE_BOOTSTRAP_INTERVAL"));
  }
});

test("Sobol retains negative estimates, totals above one, and first greater than total", () => {
  const result = sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 2, seed: 0,
    bootstrapReplicates: 40,
    evaluator: ({ x }) => x,
  });
  const x = result.byParameter.x;
  const y = result.byParameter.y;
  assert.equal(x.firstOrder, 1);
  assert.equal(y.totalOrder, 0);
  assert.ok(x.totalOrder > 1, "small-sample total must remain unclipped");
  assert.ok(y.firstOrder < 0, "small-sample first must remain unclipped");
  assert.ok(x.precision && y.precision, "raw-estimate diagnostics are required");
  assert.ok(x.precision.issues.includes("TOTAL_ORDER_OUT_OF_RANGE"));
  assert.ok(y.precision.issues.includes("FIRST_ORDER_OUT_OF_RANGE"));
  const reversed = sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 2, seed: 1,
    bootstrapReplicates: 40,
    evaluator: ({ x }) => x,
  }).byParameter.x;
  assert.ok(reversed.firstOrder > reversed.totalOrder);
  assert.ok(reversed.precision.issues.includes("FIRST_ORDER_EXCEEDS_TOTAL_ORDER"));
});

test("Sobol rejects degenerate base variance and reports degenerate bootstrap rows", () => {
  assert.throws(() => sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 8,
    evaluator: () => 5,
  }), { code: "ZERO_OUTPUT_VARIANCE" });
  const result = sobolJansenSensitivity({
    distributions: { x: unitDistributions.x }, sampleCount: 2, seed: 4,
    bootstrapReplicates: 100, bootstrapSeed: 777,
    evaluator: ({ x }) => x < 0.5 ? 0 : 1,
  });
  const output = result.byParameter.x;
  assert.ok(output.precision, "degenerate replicates need explicit diagnostics");
  assert.ok(output.precision.invalidReplicates > 0);
  assert.ok(output.precision.validReplicates > 1);
  assert.equal(output.precision.validReplicates + output.precision.invalidReplicates, 100);
  assert.ok(output.precision.issues.includes("INVALID_BOOTSTRAP_REPLICATES"));
  assert.equal(output.precision.imprecise, true);
  assert.ok(output.firstOrderInterval.every(Number.isFinite));
});

test("Sobol cannot assess intervals with fewer than two valid paired-row replicates", () => {
  const result = sobolJansenSensitivity({
    distributions: { x: unitDistributions.x }, sampleCount: 2, seed: 4,
    bootstrapReplicates: 2, bootstrapSeed: 2,
    evaluator: ({ x }) => x < 0.5 ? 0 : 1,
  });
  const output = result.byParameter.x;
  assert.equal(output.precision.validReplicates, 0);
  assert.equal(output.precision.invalidReplicates, 2);
  assert.equal(output.precision.assessed, false);
  assert.equal(output.precision.imprecise, true);
  assert.ok(output.precision.issues.includes("INSUFFICIENT_VALID_BOOTSTRAP_REPLICATES"));
  assert.equal(output.firstOrderInterval, null);
  assert.equal(output.totalOrderInterval, null);
  assert.equal(output.firstOrderStandardError, null);
  assert.equal(output.totalOrderStandardError, null);
  assert.ok(Number.isFinite(output.firstOrder));
  assert.ok(Number.isFinite(output.totalOrder));
});

test("Sobol flags poorly resolved bootstrap tails even with narrow percentile intervals", () => {
  const result = sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 1000, seed: 1234,
    bootstrapReplicates: 2, bootstrapSeed: 2, precisionTolerance: 100,
    evaluator: ({ x, y }) => x + 2 * y,
  });
  const output = result.byParameter.x;
  assert.equal(output.precision.assessed, true);
  assert.ok(output.precision.issues.includes("LOW_BOOTSTRAP_TAIL_COUNT"));
  assert.equal(output.precision.imprecise, true);
});

test("Sobol validates bootstrap settings before evaluating", () => {
  for (const invalid of [
    { bootstrapReplicates: -1 }, { bootstrapReplicates: 1 }, { bootstrapReplicates: 2.5 },
    { confidenceLevel: 0 }, { confidenceLevel: 1 }, { confidenceLevel: NaN },
    { precisionTolerance: 0 }, { precisionTolerance: Infinity },
  ]) {
    let calls = 0;
    assert.throws(() => sobolJansenSensitivity({
      distributions: unitDistributions, sampleCount: 4, ...invalid,
      evaluator: ({ x }) => { calls += 1; return x; },
    }), { code: "INVALID_SOBOL_BOOTSTRAP_OPTIONS" });
    assert.equal(calls, 0);
  }
});

test("Sobol exports immutable bootstrap limits separately from result metadata", () => {
  assert.deepEqual(SOBOL_LIMITS, {
    maximumBootstrapReplicates: 2000,
    maximumBootstrapSquaredDifferences: 100_000_000,
  });
  assert.ok(Object.isFrozen(SOBOL_LIMITS));
});

for (const bootstrapReplicates of [2001, Number.MAX_SAFE_INTEGER]) {
  test(`Sobol rejects ${bootstrapReplicates} bootstrap replicates before evaluating`, () => {
    let calls = 0;
    assert.throws(() => sobolJansenSensitivity({
      distributions: unitDistributions, sampleCount: 4, bootstrapReplicates,
      evaluator: () => {
        calls += 1;
        throw new Error("replicate validation must precede evaluator calls");
      },
    }), { code: "INVALID_SOBOL_BOOTSTRAP_OPTIONS" });
    assert.equal(calls, 0);
  });
}

test("Sobol rejects bootstrap work exceeding the scalar lower bound before evaluating", () => {
  let calls = 0;
  assert.throws(() => sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 12_501, bootstrapReplicates: 2000,
    evaluator: () => {
      calls += 1;
      throw new Error("scalar work validation must precede evaluator calls");
    },
  }), { name: "RangeError", code: "SOBOL_BOOTSTRAP_WORK_LIMIT", path: "bootstrapReplicates" });
  assert.equal(calls, 0);
});

for (const outputKind of ["array", "object", "named array"]) {
  test(`Sobol rejects combined bootstrap work after discovering ${outputKind} output width`, () => {
    const outputNames = Array.from({ length: 13 }, (_, index) => `output${index}`);
    let calls = 0;
    assert.throws(() => sobolJansenSensitivity({
      distributions: unitDistributions, sampleCount: 1024, bootstrapReplicates: 2000,
      ...(outputKind === "named array" ? { outputNames } : {}),
      evaluator: ({ x }) => {
        calls += 1;
        // Fail safely on an unguarded implementation instead of running 106,496,000 differences.
        if (calls > 1) throw new Error("output-width validation must precede further evaluations and bootstrap");
        const values = outputNames.map((_, index) => x + index);
        return outputKind === "object"
          ? Object.fromEntries(outputNames.map((name, index) => [name, values[index]]))
          : values;
      },
    }), { name: "RangeError", code: "SOBOL_BOOTSTRAP_WORK_LIMIT", path: "bootstrapReplicates" });
    assert.equal(calls, 1);
  });
}

for (const sampleCount of [1024, 6250]) {
  test(`Sobol allows ${sampleCount} rows, 2000 replicates, two parameters and two outputs`, () => {
    const stop = new Error("stop before bootstrap; only validate the budget boundary");
    let calls = 0;
    // 1024 rows fit comfortably; 6250 rows require exactly 100,000,000 squared differences.
    assert.throws(() => sobolJansenSensitivity({
      distributions: unitDistributions, sampleCount, bootstrapReplicates: 2000,
      evaluator: ({ x, y }) => {
        calls += 1;
        if (calls > 1) throw stop;
        return [x + y, x - y];
      },
    }), (error) => error === stop);
    assert.equal(calls, 2);
  });
}

test("Sobol accepts 2000 replicates without counting cached bootstrap work as evaluator calls", () => {
  let calls = 0;
  const result = sobolJansenSensitivity({
    distributions: unitDistributions, sampleCount: 4, bootstrapReplicates: 2000,
    maxEvaluations: 16, seed: 123,
    evaluator: ({ x, y }) => {
      calls += 1;
      return [x + y, x - y];
    },
  });
  assert.equal(calls, 16);
  assert.equal(result.evaluationCount, calls);
  assert.equal(result.bootstrap.replicates, 2000);
  assert.equal(result.byParameter.x.outputs["0"].precision.validReplicates, 2000);
});

test("Sobol explicitly rejects correlated inputs", () => {
  assert.throws(
    () => sobolJansenSensitivity({
      seed: 1,
      sampleCount: 100,
      correlations: [[1, 0.5], [0.5, 1]],
      distributions: {
        x1: { type: "uniform", minimum: 0, maximum: 1 },
        x2: { type: "uniform", minimum: 0, maximum: 1 },
      },
      evaluator: ({ x1, x2 }) => x1 + x2,
    }),
    { code: "CORRELATED_INPUTS_UNSUPPORTED" },
  );
});
