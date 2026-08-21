import { sampleDistribution, validateDistribution } from "./distributions.js";
import { applyParameterOverrides } from "./parameter-space.js";
import { createSubstream, normalizeSeed, RNG_ALGORITHM } from "./random.js";

export const MONTE_CARLO_LIMITS = Object.freeze({
  warningSamples: 20_000,
  blockSamples: 50_000,
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
    fail("INVALID_MONTE_CARLO_OPTIONS", `${path} must be a plain object.`, path);
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

function clone(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
  }
  return value;
}

function serializeError(error) {
  if (error instanceof Error) {
    return freeze({
      name: error.name,
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.path !== undefined ? { path: error.path } : {}),
    });
  }
  return freeze({ name: "Error", message: String(error) });
}

function normalizeSampleCount(options) {
  const count = options.sampleCount ?? options.samples ?? options.n;
  if (!Number.isSafeInteger(count) || count <= 0) {
    fail("INVALID_SAMPLE_COUNT", "sampleCount must be a positive safe integer.", "sampleCount");
  }
  if (count > MONTE_CARLO_LIMITS.blockSamples) {
    fail(
      "MONTE_CARLO_BLOCK_LIMIT",
      `Monte Carlo sample count exceeds the hard limit of ${MONTE_CARLO_LIMITS.blockSamples}.`,
      "sampleCount",
      RangeError,
    );
  }
  return count;
}

function normalizeDistributions(options) {
  const supplied = options.parameterDistributions ?? options.distributions ?? options.parameters;
  plainObject(supplied, "parameterDistributions");
  const names = Object.keys(supplied).sort();
  if (names.length === 0) {
    fail("EMPTY_DISTRIBUTIONS", "At least one parameter distribution is required.");
  }
  return freeze({
    names,
    specifications: Object.fromEntries(
      names.map((name) => [name, validateDistribution(supplied[name], `parameterDistributions.${name}`)]),
    ),
  });
}

function outputVector(value, outputNames) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_EVALUATOR_RESULT", "Evaluator output must be finite.");
    return { names: outputNames ?? ["value"], values: [value], original: value };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) fail("INVALID_EVALUATOR_RESULT", "Evaluator output array cannot be empty.");
    const values = value.map((child, index) => {
      if (typeof child !== "number" || !Number.isFinite(child)) {
        fail("INVALID_EVALUATOR_RESULT", `Evaluator output[${index}] must be finite.`);
      }
      return child;
    });
    const names = outputNames ?? values.map((_, index) => String(index));
    if (names.length !== values.length) {
      fail("INVALID_OUTPUT_NAMES", "outputNames length must match evaluator output length.");
    }
    return { names, values, original: value };
  }
  if (value && typeof value === "object") {
    const names = outputNames ?? Object.keys(value).sort();
    if (names.length === 0) fail("INVALID_EVALUATOR_RESULT", "Evaluator output object cannot be empty.");
    const values = names.map((name) => {
      const child = value[name];
      if (typeof child !== "number" || !Number.isFinite(child)) {
        fail("INVALID_EVALUATOR_RESULT", `Evaluator output.${name} must be finite.`);
      }
      return child;
    });
    return { names, values, original: value };
  }
  fail(
    "INVALID_EVALUATOR_RESULT",
    "Evaluator output must be a finite number, finite-number array, or finite-number object.",
  );
}

function createAccumulator() {
  return { count: 0, mean: 0, m2: 0, values: [] };
}

function updateAccumulator(accumulator, value) {
  accumulator.count += 1;
  const delta = value - accumulator.mean;
  accumulator.mean += delta / accumulator.count;
  accumulator.m2 += delta * (value - accumulator.mean);
  accumulator.values.push(value);
}

/** R type-7 sample quantile (the default used by R and NumPy's linear method). */
export function quantileR7(sortedValues, probability) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) {
    fail("INVALID_QUANTILE_SAMPLE", "quantileR7 requires a non-empty sorted array.");
  }
  if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
    fail("INVALID_QUANTILE_PROBABILITY", "Quantile probabilities must be within [0, 1].");
  }
  if (sortedValues.length === 1) return sortedValues[0];
  const index = (sortedValues.length - 1) * probability;
  const lower = Math.floor(index);
  const fraction = index - lower;
  const upper = Math.min(sortedValues.length - 1, lower + 1);
  return sortedValues[lower] + fraction * (sortedValues[upper] - sortedValues[lower]);
}

export const r7Quantile = quantileR7;

function summariesFrom(accumulators, probabilities) {
  const summaries = {};
  for (const [name, accumulator] of Object.entries(accumulators)) {
    const sorted = [...accumulator.values].sort((left, right) => left - right);
    const quantiles = {};
    for (const probability of probabilities) {
      quantiles[String(probability)] = quantileR7(sorted, probability);
    }
    summaries[name] = freeze({
      count: accumulator.count,
      mean: accumulator.mean,
      variance: accumulator.count > 1 ? accumulator.m2 / (accumulator.count - 1) : 0,
      standardDeviation:
        accumulator.count > 1 ? Math.sqrt(accumulator.m2 / (accumulator.count - 1)) : 0,
      quantiles: freeze(quantiles),
      minimum: sorted[0],
      maximum: sorted.at(-1),
    });
  }
  return summaries;
}

/**
 * Parameter-uncertainty Monte Carlo with sample-indexed substreams. Each
 * parameter draw is keyed by sample index and parameter name, so chunking and
 * iteration order do not change a sample.
 */
export function runMonteCarlo(options) {
  plainObject(options, "options");
  const evaluator = options.evaluator ?? options.evaluate;
  if (typeof evaluator !== "function") {
    fail("EVALUATOR_REQUIRED", "A pure evaluator callback is required.", "evaluator");
  }
  const sampleCount = normalizeSampleCount(options);
  const seed = normalizeSeed(options.seed ?? 0);
  const normalized = normalizeDistributions(options);
  const progress = options.onProgress ?? options.progress;
  if (progress !== undefined && typeof progress !== "function") {
    fail("INVALID_PROGRESS_CALLBACK", "onProgress must be a function.");
  }
  const probabilities = options.quantileProbabilities ?? options.quantiles ?? [0.025, 0.5, 0.975];
  if (!Array.isArray(probabilities) || probabilities.length === 0) {
    fail("INVALID_QUANTILES", "quantileProbabilities must be a non-empty array.");
  }
  probabilities.forEach((probability) => {
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      fail("INVALID_QUANTILE_PROBABILITY", "Quantile probabilities must be within [0, 1].");
    }
  });

  const warnings = [];
  if (sampleCount > MONTE_CARLO_LIMITS.warningSamples) {
    warnings.push(
      freeze({
        code: "MONTE_CARLO_LARGE",
        severity: "warning",
        message: `Monte Carlo uses ${sampleCount} samples, above the ${MONTE_CARLO_LIMITS.warningSamples} warning threshold.`,
        sampleCount,
      }),
    );
  }

  const results = [];
  const failures = [];
  const accumulators = {};
  let outputNames = options.outputNames ? [...options.outputNames] : null;
  let successCount = 0;
  for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
    const parameters = {};
    for (const name of normalized.names) {
      parameters[name] = sampleDistribution(
        normalized.specifications[name],
        createSubstream(seed, "monte-carlo", sampleIndex, name),
      );
    }
    const frozenParameters = freeze(parameters);
    const snapshot = options.resolvedModel
      ? applyParameterOverrides(options.resolvedModel, frozenParameters, {
          initialStateSeriesIds: options.initialStateSeriesIds ?? options.declaredInitialStates,
        })
      : undefined;
    const context = freeze({
      sampleIndex,
      index: sampleIndex,
      seed,
      ...(snapshot ? { resolvedModel: snapshot, snapshot } : {}),
    });
    try {
      const raw = evaluator(frozenParameters, context);
      if (raw && typeof raw.then === "function") {
        fail("ASYNC_EVALUATOR_NOT_SUPPORTED", "runMonteCarlo requires a synchronous evaluator.");
      }
      const output = outputVector(raw, outputNames);
      if (outputNames === null) outputNames = [...output.names];
      if (
        output.names.length !== outputNames.length ||
        output.names.some((name, index) => name !== outputNames[index])
      ) {
        fail("INCONSISTENT_EVALUATOR_OUTPUT", "Evaluator output shape changed between samples.");
      }
      outputNames.forEach((name, index) => {
        if (!accumulators[name]) accumulators[name] = createAccumulator();
        updateAccumulator(accumulators[name], output.values[index]);
      });
      results.push(
        freeze({
          sampleIndex,
          status: "ok",
          parameters: frozenParameters,
          value: clone(raw),
          output: clone(raw),
        }),
      );
      successCount += 1;
    } catch (error) {
      const failure = freeze({
        sampleIndex,
        status: "failed",
        parameters: frozenParameters,
        error: serializeError(error),
      });
      failures.push(failure);
      results.push(failure);
    }
    progress?.(
      freeze({
        completed: sampleIndex + 1,
        total: sampleCount,
        fraction: (sampleIndex + 1) / sampleCount,
        successCount,
        failureCount: failures.length,
      }),
    );
  }

  if (successCount === 0) {
    fail("ALL_MONTE_CARLO_SAMPLES_FAILED", "All Monte Carlo evaluator calls failed.");
  }
  const summaries = freeze(summariesFrom(accumulators, probabilities));
  const intervalName =
    options.propagateObservationError === true || options.observationErrorPropagation === true
      ? "predictive_simulation_interval"
      : "parameter_uncertainty_simulation_interval";
  const scalarSummary = outputNames.length === 1 ? summaries[outputNames[0]] : undefined;

  return freeze({
    kind: "monte_carlo_uncertainty_propagation",
    intervalName,
    intervalType: intervalName,
    seed,
    randomAlgorithm: RNG_ALGORITHM,
    sampleCount,
    successCount,
    failureCount: failures.length,
    failureFraction: failures.length / sampleCount,
    parameterDistributions: normalized.specifications,
    outputNames,
    summaries,
    ...(scalarSummary
      ? {
          mean: scalarSummary.mean,
          variance: scalarSummary.variance,
          standardDeviation: scalarSummary.standardDeviation,
          quantiles: scalarSummary.quantiles,
        }
      : {}),
    warnings,
    failures,
    results,
  });
}

export const monteCarlo = runMonteCarlo;
export const runMonteCarloSimulation = runMonteCarlo;
