import { sampleDistribution, validateDistribution } from "./distributions.js";
import { quantileR7 } from "./monte-carlo.js";
import { applyParameterOverrides } from "./parameter-space.js";
import { createSubstream, deriveSeed, normalizeSeed, RNG_ALGORITHM } from "./random.js";

export const SOBOL_LIMITS = Object.freeze({
  maximumBootstrapReplicates: 2000,
  maximumBootstrapSquaredDifferences: 100_000_000,
});

function fail(code, message, path = null, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  error.path = path;
  throw error;
}

function plainObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("INVALID_SOBOL_OPTIONS", `${path} must be a plain object.`, path);
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function outputVector(value, names) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { names: names ?? ["value"], values: [value] };
  }
  if (Array.isArray(value) && value.length > 0) {
    const values = value.map((child, index) => {
      if (typeof child !== "number" || !Number.isFinite(child)) {
        fail("INVALID_EVALUATOR_RESULT", `Evaluator output[${index}] must be finite.`);
      }
      return child;
    });
    const outputNames = names ?? values.map((_, index) => String(index));
    if (outputNames.length !== values.length) fail("INVALID_OUTPUT_NAMES", "outputNames length mismatch.");
    return { names: outputNames, values };
  }
  if (value && typeof value === "object") {
    const outputNames = names ?? Object.keys(value).sort();
    if (outputNames.length === 0) fail("INVALID_EVALUATOR_RESULT", "Evaluator output cannot be empty.");
    return {
      names: outputNames,
      values: outputNames.map((name) => {
        const child = value[name];
        if (typeof child !== "number" || !Number.isFinite(child)) {
          fail("INVALID_EVALUATOR_RESULT", `Evaluator output.${name} must be finite.`);
        }
        return child;
      }),
    };
  }
  fail("INVALID_EVALUATOR_RESULT", "Evaluator output must contain finite numeric values.");
}

function evaluate(evaluator, parameters, options, context, outputNames) {
  const frozenParameters = freeze({ ...parameters });
  const snapshot = options.resolvedModel
    ? applyParameterOverrides(options.resolvedModel, frozenParameters, {
        initialStateSeriesIds: options.initialStateSeriesIds ?? options.declaredInitialStates,
      })
    : undefined;
  const raw = evaluator(
    frozenParameters,
    freeze({ ...context, ...(snapshot ? { resolvedModel: snapshot, snapshot } : {}) }),
  );
  if (raw && typeof raw.then === "function") {
    fail("ASYNC_EVALUATOR_NOT_SUPPORTED", "Sobol sensitivity requires a synchronous evaluator.");
  }
  return outputVector(raw, outputNames);
}

function varianceSample(values) {
  let mean = 0;
  let m2 = 0;
  for (let index = 0; index < values.length; index += 1) {
    const delta = values[index] - mean;
    mean += delta / (index + 1);
    m2 += delta * (values[index] - mean);
  }
  return values.length > 1 ? m2 / (values.length - 1) : 0;
}

function bootstrapOptions(options, seed) {
  const replicates = options.bootstrapReplicates ?? 200;
  const confidenceLevel = options.confidenceLevel ?? 0.95;
  const precisionTolerance = options.precisionTolerance ?? 0.2;
  if (!Number.isSafeInteger(replicates) || replicates < 0 || replicates === 1 || replicates > SOBOL_LIMITS.maximumBootstrapReplicates) {
    fail("INVALID_SOBOL_BOOTSTRAP_OPTIONS", `bootstrapReplicates must be 0 (disabled) or an integer from 2 to ${SOBOL_LIMITS.maximumBootstrapReplicates}.`);
  }
  if (typeof confidenceLevel !== "number" || !Number.isFinite(confidenceLevel) || confidenceLevel <= 0 || confidenceLevel >= 1) {
    fail("INVALID_SOBOL_BOOTSTRAP_OPTIONS", "confidenceLevel must be in (0, 1).");
  }
  if (typeof precisionTolerance !== "number" || !Number.isFinite(precisionTolerance) || precisionTolerance <= 0) {
    fail("INVALID_SOBOL_BOOTSTRAP_OPTIONS", "precisionTolerance must be a positive finite full interval width.");
  }
  return {
    method: "paired_row_percentile",
    resamplingUnit: "paired_rows_A_B_A_Bi",
    quantileMethod: "R7",
    seed: normalizeSeed(options.bootstrapSeed ?? deriveSeed(seed, "sobol", "bootstrap")),
    replicates,
    confidenceLevel,
    precisionTolerance,
    minimumTailSamples: 5,
    interpretation: "Monte Carlo sampling uncertainty conditional on independent input distributions and the evaluator; not model or data uncertainty. Percentile coverage is approximate.",
  };
}

function validateBootstrapWork(replicates, sampleCount, parameterCount, outputCount = 1) {
  // Jansen accumulates two squared differences per replicate/row/parameter/output.
  const squaredDifferences = 2 * replicates * sampleCount * parameterCount * outputCount;
  if (squaredDifferences > SOBOL_LIMITS.maximumBootstrapSquaredDifferences) {
    fail(
      "SOBOL_BOOTSTRAP_WORK_LIMIT",
      `Sobol bootstrap requires ${squaredDifferences} scalar squared differences, above the limit of ${SOBOL_LIMITS.maximumBootstrapSquaredDifferences}.`,
      "bootstrapReplicates",
      RangeError,
    );
  }
}

function pooledVariances(outputsA, outputsB, rows, outputNames) {
  return outputNames.map((_, outputIndex) => varianceSample([
    ...rows.map((row) => outputsA[row][outputIndex]),
    ...rows.map((row) => outputsB[row][outputIndex]),
  ]));
}

function jansenIndices(outputsA, outputsB, mixed, rows, outputIndex, variance) {
  let firstNumerator = 0;
  let totalNumerator = 0;
  for (const row of rows) {
    // A_Bi keeps A's other coordinates and replaces coordinate i with B's.
    totalNumerator += (outputsA[row][outputIndex] - mixed[row][outputIndex]) ** 2;
    firstNumerator += (outputsB[row][outputIndex] - mixed[row][outputIndex]) ** 2;
  }
  const denominator = 2 * rows.length * variance;
  return {
    firstOrder: 1 - firstNumerator / denominator,
    totalOrder: totalNumerator / denominator,
  };
}

function bootstrapIndices(config, outputsA, outputsB, mixed, rows, names, outputNames) {
  const samples = Object.fromEntries(names.map((name) => [name,
    outputNames.map(() => ({ firstOrder: [], totalOrder: [] })),
  ]));
  for (let replicate = 0; replicate < config.replicates; replicate += 1) {
    const random = createSubstream(config.seed, "sobol", "bootstrap", replicate);
    // One shared row selection preserves A/B/hybrid dependence across every index/output.
    const selected = rows.map(() => Math.floor(random.next() * rows.length));
    const variances = pooledVariances(outputsA, outputsB, selected, outputNames);
    for (const name of names) {
      outputNames.forEach((_, outputIndex) => {
        if (!(variances[outputIndex] > 0) || !Number.isFinite(variances[outputIndex])) return;
        const estimate = jansenIndices(outputsA, outputsB, mixed[name], selected, outputIndex, variances[outputIndex]);
        if (!Number.isFinite(estimate.firstOrder) || !Number.isFinite(estimate.totalOrder)) return;
        samples[name][outputIndex].firstOrder.push(estimate.firstOrder);
        samples[name][outputIndex].totalOrder.push(estimate.totalOrder);
      });
    }
  }
  return samples;
}

function uncertaintySummary(estimate, samples, config) {
  const validReplicates = samples.firstOrder.length;
  const invalidReplicates = config.replicates - validReplicates;
  const assessed = validReplicates >= 2;
  const alpha = (1 - config.confidenceLevel) / 2;
  const tailSampleCount = validReplicates * alpha;
  const interval = (values) => {
    if (!assessed) return null;
    const sorted = [...values].sort((left, right) => left - right);
    return [quantileR7(sorted, alpha), quantileR7(sorted, 1 - alpha)];
  };
  const firstOrderInterval = interval(samples.firstOrder);
  const totalOrderInterval = interval(samples.totalOrder);
  const intervalWidths = {
    firstOrder: assessed ? firstOrderInterval[1] - firstOrderInterval[0] : null,
    totalOrder: assessed ? totalOrderInterval[1] - totalOrderInterval[0] : null,
  };
  const issues = [];
  if (config.replicates === 0) issues.push("BOOTSTRAP_DISABLED");
  else if (!assessed) issues.push("INSUFFICIENT_VALID_BOOTSTRAP_REPLICATES");
  if (assessed && tailSampleCount < config.minimumTailSamples) issues.push("LOW_BOOTSTRAP_TAIL_COUNT");
  if (invalidReplicates > 0) issues.push("INVALID_BOOTSTRAP_REPLICATES");
  if (estimate.firstOrder < 0 || estimate.firstOrder > 1) issues.push("FIRST_ORDER_OUT_OF_RANGE");
  if (estimate.totalOrder < 0 || estimate.totalOrder > 1) issues.push("TOTAL_ORDER_OUT_OF_RANGE");
  if (estimate.firstOrder > estimate.totalOrder) issues.push("FIRST_ORDER_EXCEEDS_TOTAL_ORDER");
  if (assessed && Math.max(intervalWidths.firstOrder, intervalWidths.totalOrder) > config.precisionTolerance) {
    issues.push("WIDE_BOOTSTRAP_INTERVAL");
  }
  return {
    firstOrderInterval,
    totalOrderInterval,
    firstOrderStandardError: assessed ? Math.sqrt(varianceSample(samples.firstOrder)) : null,
    totalOrderStandardError: assessed ? Math.sqrt(varianceSample(samples.totalOrder)) : null,
    precision: {
      assessed,
      imprecise: config.replicates === 0 ? null : !assessed || issues.length > 0,
      validReplicates,
      invalidReplicates,
      tailSampleCount,
      intervalWidths,
      tolerance: config.precisionTolerance,
      issues,
    },
  };
}

function rejectCorrelation(options) {
  const correlated =
    options.correlated === true ||
    options.independentInputs === false ||
    options.correlation !== undefined ||
    options.correlations !== undefined ||
    options.correlationMatrix !== undefined ||
    options.copula !== undefined;
  if (correlated) {
    fail(
      "CORRELATED_INPUTS_UNSUPPORTED",
      "Sobol–Jansen indices require independent inputs; correlated inputs are explicitly unsupported.",
      "correlation",
    );
  }
}

/** Raw Sobol–Jansen indices with paired-row bootstrap uncertainty for independent inputs. */
export function sobolJansenSensitivity(options) {
  plainObject(options, "options");
  rejectCorrelation(options);
  const evaluator = options.evaluator ?? options.evaluate;
  if (typeof evaluator !== "function") fail("EVALUATOR_REQUIRED", "A pure evaluator callback is required.");
  const supplied = options.parameterDistributions ?? options.distributions ?? options.parameters;
  plainObject(supplied, "parameterDistributions");
  const names = Object.keys(supplied).sort();
  if (names.length === 0) fail("EMPTY_DISTRIBUTIONS", "At least one independent input is required.");
  const distributions = Object.fromEntries(
    names.map((name) => [name, validateDistribution(supplied[name], `parameterDistributions.${name}`)]),
  );
  const sampleCount = options.sampleCount ?? options.samples ?? options.n;
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 2) {
    fail("INVALID_SAMPLE_COUNT", "sampleCount must be an integer >= 2.");
  }
  const maximumEvaluations = options.maxEvaluations ?? 1_000_000;
  const evaluationCount = sampleCount * (names.length + 2);
  if (!Number.isSafeInteger(maximumEvaluations) || maximumEvaluations <= 0) {
    fail("INVALID_EVALUATION_LIMIT", "maxEvaluations must be a positive safe integer.");
  }
  if (evaluationCount > maximumEvaluations) {
    fail(
      "SOBOL_EVALUATION_LIMIT",
      `Sobol design requires ${evaluationCount} evaluations, above maxEvaluations ${maximumEvaluations}.`,
      "sampleCount",
      RangeError,
    );
  }
  const seed = normalizeSeed(options.seed ?? 0);
  const bootstrap = bootstrapOptions(options, seed);
  // Every valid evaluator has at least one output; reject that lower bound before sampling.
  validateBootstrapWork(bootstrap.replicates, sampleCount, names.length);
  const matrixA = [];
  const matrixB = [];
  for (let row = 0; row < sampleCount; row += 1) {
    const a = {};
    const b = {};
    for (const name of names) {
      a[name] = sampleDistribution(distributions[name], createSubstream(seed, "sobol", "A", row, name));
      b[name] = sampleDistribution(distributions[name], createSubstream(seed, "sobol", "B", row, name));
    }
    matrixA.push(a);
    matrixB.push(b);
  }

  let outputNames = options.outputNames ? [...options.outputNames] : null;
  const outputsA = [];
  const outputsB = [];
  for (let row = 0; row < sampleCount; row += 1) {
    const a = evaluate(evaluator, matrixA[row], options, { matrix: "A", row }, outputNames);
    if (outputNames === null) outputNames = [...a.names];
    if (row === 0) validateBootstrapWork(bootstrap.replicates, sampleCount, names.length, outputNames.length);
    const b = evaluate(evaluator, matrixB[row], options, { matrix: "B", row }, outputNames);
    outputsA.push(a.values);
    outputsB.push(b.values);
  }

  const rows = Array.from({ length: sampleCount }, (_, index) => index);
  const variances = pooledVariances(outputsA, outputsB, rows, outputNames);
  variances.forEach((variance, index) => {
    if (!(variance > 0) || !Number.isFinite(variance)) {
      fail("ZERO_OUTPUT_VARIANCE", `Output ${outputNames[index]} has zero or invalid variance.`);
    }
  });

  const mixed = {};
  for (const name of names) {
    mixed[name] = [];
    for (let row = 0; row < sampleCount; row += 1) {
      const hybrid = { ...matrixA[row], [name]: matrixB[row][name] };
      const output = evaluate(
        evaluator,
        hybrid,
        options,
        { matrix: "A_Bi", row, parameter: name },
        outputNames,
      );
      mixed[name].push(output.values);
    }
  }
  const samples = bootstrapIndices(bootstrap, outputsA, outputsB, mixed, rows, names, outputNames);
  const byParameter = {};
  for (const name of names) {
    const outputs = {};
    outputNames.forEach((outputName, outputIndex) => {
      const estimate = jansenIndices(outputsA, outputsB, mixed[name], rows, outputIndex, variances[outputIndex]);
      const { firstOrder, totalOrder } = estimate;
      outputs[outputName] = freeze({
        firstOrder,
        totalOrder,
        first: firstOrder,
        total: totalOrder,
        S1: firstOrder,
        ST: totalOrder,
        ...uncertaintySummary(estimate, samples[name][outputIndex], bootstrap),
      });
    });
    byParameter[name] = freeze({
      parameter: name,
      outputs: freeze(outputs),
      ...(outputNames.length === 1 ? outputs[outputNames[0]] : {}),
    });
  }

  return freeze({
    kind: "sobol_jansen_sensitivity",
    assumption: "independent_inputs_only",
    seed,
    randomAlgorithm: RNG_ALGORITHM,
    sampleCount,
    evaluationCount,
    bootstrap,
    parameterDistributions: freeze(distributions),
    outputNames,
    outputVariances: freeze(Object.fromEntries(outputNames.map((name, index) => [name, variances[index]]))),
    byParameter,
    indices: names.map((name) => byParameter[name]),
  });
}

export const runSobolSensitivity = sobolJansenSensitivity;
export const sobolSensitivity = sobolJansenSensitivity;
export const analyzeSobolSensitivity = sobolJansenSensitivity;
