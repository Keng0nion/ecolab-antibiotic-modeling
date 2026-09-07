import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIdentifiability } from "../identifiability.js";

test("identifiability warns for correlated/rank-deficient parameters, bounds and near optima", () => {
  const result = analyzeIdentifiability({
    parameters: { a: 0, b: 0.5 },
    bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a, b }) => [a + b, 2 * (a + b), 3 * (a + b)],
    optima: [
      { parameters: { a: 0, b: 0.5 }, objectiveValue: 1 },
      { parameters: { a: 0.5, b: 0 }, objectiveValue: 1 + 1e-9 },
    ],
    profiles: { parameters: ["a"], points: 5 },
    objective: ({ a, b }) => (a + b - 0.5) ** 2,
  });
  const codes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(codes.has("RANK_DEFICIENT_JACOBIAN"));
  assert.ok(codes.has("HIGH_CONDITION_NUMBER"));
  assert.ok(codes.has("STRONG_PARAMETER_CORRELATION"));
  assert.ok(codes.has("PARAMETER_AT_BOUND"));
  assert.ok(codes.has("MULTIPLE_NEAR_OPTIMA"));
  assert.equal(result.rank, 1);
  assert.equal(result.JtJ.length, 2);
});

test("deprecated profile requests retain slice data without likelihood claims", () => {
  const result = analyzeIdentifiability({
    parameters: { x: 0 },
    bounds: { x: [0, 1] },
    evaluator: () => [1, 1],
    profiles: true,
    objective: () => 5,
  });
  const codes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(codes.has("FLAT_OBJECTIVE_SLICE"));
  assert.ok(codes.has("SLICE_MINIMUM_AT_BOUND"));
  assert.ok(codes.has("DEPRECATED_PROFILES_ALIAS"));
  assert.ok(codes.has("OBJECTIVE_SLICES_NOT_PROFILE_LIKELIHOOD"));
  assert.strictEqual(result.profiles, result.objectiveSlices);
  assert.equal(result.deprecatedAliases.profiles, "objectiveSlices");
  assert.equal(result.objectiveSlices[0].confidenceInterval, null);
  assert.equal(result.objectiveSlices[0].minimumAtBoundary, true);
  assert.equal(result.objectiveSlices[0].open, true);
});

test("objective slices keep nuisance parameters fixed, not reoptimized as a profile likelihood", () => {
  const candidates = [];
  const result = analyzeIdentifiability({
    parameters: { a: 0.5, b: 0.5 },
    bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a, b }) => [a + b, 2 * (a + b)],
    objectiveSlices: { parameters: ["a"], points: 5 },
    objective: (candidate) => {
      candidates.push({ ...candidate });
      return (candidate.a + candidate.b - 1) ** 2;
    },
  });
  assert.equal(candidates.length, 5, "slice option must evaluate the requested grid");
  assert.ok(candidates.every((candidate) => candidate.b === 0.5));
  const slice = result.objectiveSlices[0];
  assert.equal(slice.kind, "objective_slice");
  assert.deepEqual(slice.fixedParameters, { b: 0.5 });
  assert.equal(slice.nuisanceParametersOptimized, false);
  assert.equal(slice.confidenceInterval, null);
  assert.equal(slice.status, "completed");
  assert.equal(slice.minimumAtBoundary, false);
  assert.equal(slice.minimumIndex, 2);
  assert.equal(slice.flat, false, "true nuisance-optimized likelihood would be flat in this example");
  assert.deepEqual(slice.values.map((point) => point.objectiveValue), [0.25, 0.0625, 0, 0.0625, 0.25]);
  assert.equal(result.evaluationCount, result.jacobian.evaluationCount + 5);
  assert.strictEqual(result.profiles, result.objectiveSlices);
});

test("a derivative whitelist does not discard fixed nuisance parameters from slices or evaluations", () => {
  const candidates = [];
  const result = analyzeIdentifiability({
    parameters: { a: 0.5, b: 0.25 }, parameterWhitelist: ["a"],
    bounds: { a: [0, 1] },
    evaluator: ({ a, b = 0 }) => [a + b],
    objectiveSlices: { points: 3 },
    objective: (candidate) => {
      candidates.push({ ...candidate });
      return (candidate.a + (candidate.b ?? 0) - 0.75) ** 2;
    },
  });
  assert.ok(candidates.every((candidate) => candidate.b === 0.25), "unscanned supplied parameters must remain fixed");
  assert.deepEqual(result.jacobian.baseline, [0.75]);
  assert.deepEqual(result.objectiveSlices[0].fixedParameters, { b: 0.25 });
  assert.deepEqual(result.objectiveSlices[0].values.map((point) => point.objectiveValue), [0.25, 0, 0.25]);
});

test("objective slice configuration rejects noninteger grids and invalid parameter selections", () => {
  for (const objectiveSlices of [
    "yes", { points: 3.5 }, { points: NaN }, { points: 2 },
    { maxParameters: -1 }, { maxParameters: 1.5 },
    { parameters: "x" }, { parameters: [] }, { parameters: ["missing"] }, { parameters: ["x", "x"] },
    { flatRelativeTolerance: -1 }, { flatRelativeTolerance: Infinity },
  ]) {
    let calls = 0;
    assert.throws(() => analyzeIdentifiability({
      parameters: { x: 0.5 }, bounds: { x: [0, 1] }, evaluator: ({ x }) => [x],
      objective: ({ x }) => { calls += 1; return x ** 2; }, objectiveSlices,
    }), { code: "INVALID_OBJECTIVE_SLICES" });
    assert.equal(calls, 0);
  }
});

test("objective slice endpoints are never returned as confidence limits", () => {
  for (const objective of [({ x }) => x, ({ x }) => 1 - x, ({ x }) => (x - 0.5) ** 2, () => 7]) {
    const result = analyzeIdentifiability({
      parameters: { x: 0.5 }, bounds: { x: [0, 1] },
      evaluator: ({ x }) => [x, 2 * x], objective,
      objectiveSlices: true,
    });
    assert.ok(result.objectiveSlices?.length, "truthfully named slice results are required");
    assert.equal(result.objectiveSlices[0].confidenceInterval, null);
    assert.match(result.objectiveSlices[0].interpretation, /not.*confidence/i);
    assert.ok(result.warnings.some((warning) => warning.code === "OBJECTIVE_SLICES_NOT_PROFILE_LIKELIHOOD"));
  }
});

test("objectiveSlices takes precedence over the deprecated profiles input", () => {
  let calls = 0;
  const result = analyzeIdentifiability({
    parameters: { x: 0.5 }, bounds: { x: [0, 1] }, evaluator: ({ x }) => [x],
    objective: ({ x }) => { calls += 1; return x ** 2; },
    objectiveSlices: false,
    profiles: true,
  });
  assert.equal(calls, 0);
  assert.deepEqual(result.objectiveSlices, []);
  assert.strictEqual(result.profiles, result.objectiveSlices);
});

test("failed slice evaluations cannot look like a completed flat or open profile", () => {
  const result = analyzeIdentifiability({
    parameters: { x: 0.5 }, bounds: { x: [0, 1] }, evaluator: ({ x }) => [x],
    objectiveSlices: { points: 5 },
    objective: ({ x }) => {
      if (x === 0) throw new Error("invalid domain");
      return x === 0.5 ? 0 : NaN;
    },
  });
  assert.ok(result.objectiveSlices?.length, "failed evaluations still require slice diagnostics");
  const slice = result.objectiveSlices[0];
  assert.equal(slice.status, "partial");
  assert.equal(slice.failedEvaluationCount, 4);
  assert.equal(slice.minimumIndex, 2);
  assert.equal(slice.flat, null, "one finite point cannot establish flatness across the grid");
  assert.ok(slice.values.filter((point) => point.status === "failed").every((point) => point.objectiveValue === null));
  assert.ok(result.warnings.some((warning) => warning.code === "OBJECTIVE_SLICE_EVALUATION_FAILED"));
  const failed = analyzeIdentifiability({
    parameters: { x: 0.5 }, bounds: { x: [0, 1] }, evaluator: ({ x }) => [x],
    objectiveSlices: true, objective: () => Infinity,
  }).objectiveSlices[0];
  assert.equal(failed.status, "failed");
  assert.equal(failed.minimumIndex, null);
  assert.equal(failed.minimumAtBoundary, null);
  assert.equal(failed.open, null);
  assert.equal(failed.flat, null);
  assert.equal(failed.confidenceInterval, null);
});

test("rank deficiency exposes information geometry, not finite parameter covariance", () => {
  const result = analyzeIdentifiability({
    parameters: { a: 0.5, b: 0.5 }, bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a, b }) => [a + b, 2 * (a + b), 3 * (a + b)],
  });
  assert.equal(result.rank, 1);
  assert.equal(result.covarianceApproximation, null);
  assert.equal(result.correlationMatrix, null);
  assert.deepEqual(result.correlations, []);
  assert.equal(result.informationPseudoInverse.length, 2);
  assert.equal(result.covarianceDiagnostics.status, "unavailable_rank_deficient");
  assert.equal(result.covarianceDiagnostics.parameterUncertaintyEstimated, false);
  assert.ok(Math.abs(result.sensitivityCollinearity.pairs[0].cosineSimilarity - 1) < 1e-10);
  assert.ok(result.warnings.some((warning) => warning.code === "RANK_DEFICIENT_JACOBIAN"));
  assert.ok(result.warnings.some((warning) => warning.code === "PARAMETER_COVARIANCE_UNAVAILABLE"));
  const correlationWarning = result.warnings.find((warning) => warning.code === "STRONG_PARAMETER_CORRELATION");
  assert.equal(correlationWarning.source, "normalized_jacobian_columns");
});

test("an insensitive parameter does not receive zero uncertainty from a pseudoinverse", () => {
  const result = analyzeIdentifiability({
    parameters: { a: 0.5, b: 0.5 }, bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a }) => [a, 2 * a],
  });
  assert.equal(result.rank, 1);
  assert.equal(result.covarianceApproximation, null);
  assert.equal(result.informationPseudoInverse[1][1], 0);
  assert.equal(result.covarianceDiagnostics.parameterUncertaintyEstimated, false);
});

test("full-rank inverse information is explicitly unscaled geometry, not calibrated uncertainty", () => {
  const result = analyzeIdentifiability({
    parameters: { a: 0.5, b: 0.5 }, bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a, b }) => [a, b], outputScales: [1, 1],
  });
  assert.equal(result.rank, 2);
  assert.ok(result.covarianceDiagnostics, "inverse information requires a scale/uncertainty disclaimer");
  assert.equal(result.covarianceDiagnostics.status, "unscaled_local_geometry");
  assert.equal(result.covarianceDiagnostics.parameterUncertaintyEstimated, false);
  assert.equal(result.covarianceDiagnostics.coordinate, "normalized_parameter_bound_spans");
  assert.strictEqual(result.covarianceApproximation, result.informationPseudoInverse);
  assert.equal(result.deprecatedAliases.covarianceApproximation, "informationPseudoInverse (full rank only)");
  assert.ok(Math.abs(result.informationPseudoInverse[0][0] - 1) < 1e-10);
  assert.ok(result.warnings.some((warning) => warning.code === "UNSCALED_INFORMATION_NOT_PARAMETER_UNCERTAINTY"));
});
