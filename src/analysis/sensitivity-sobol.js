import { sampleDistribution, validateDistribution } from "./distributions.js";
import { applyParameterOverrides } from "./parameter-space.js";
import { createSubstream, normalizeSeed, RNG_ALGORITHM } from "./random.js";

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

/** Sobol–Jansen first-order and total-order indices for independent inputs. */
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
    const b = evaluate(evaluator, matrixB[row], options, { matrix: "B", row }, outputNames);
    outputsA.push(a.values);
    outputsB.push(b.values);
  }

  const variances = outputNames.map((_, outputIndex) =>
    varianceSample([
      ...outputsA.map((values) => values[outputIndex]),
      ...outputsB.map((values) => values[outputIndex]),
    ]),
  );
  variances.forEach((variance, index) => {
    if (!(variance > 0) || !Number.isFinite(variance)) {
      fail("ZERO_OUTPUT_VARIANCE", `Output ${outputNames[index]} has zero or invalid variance.`);
    }
  });

  const byParameter = {};
  for (const name of names) {
    const firstNumerators = outputNames.map(() => 0);
    const totalNumerators = outputNames.map(() => 0);
    for (let row = 0; row < sampleCount; row += 1) {
      const hybrid = { ...matrixA[row], [name]: matrixB[row][name] };
      const output = evaluate(
        evaluator,
        hybrid,
        options,
        { matrix: "A_Bi", row, parameter: name },
        outputNames,
      );
      outputNames.forEach((_, outputIndex) => {
        const a = outputsA[row][outputIndex];
        const b = outputsB[row][outputIndex];
        const hybridValue = output.values[outputIndex];
        totalNumerators[outputIndex] += (a - hybridValue) ** 2;
        firstNumerators[outputIndex] += (b - hybridValue) ** 2;
      });
    }
    const outputs = {};
    outputNames.forEach((outputName, outputIndex) => {
      const denominator = 2 * sampleCount * variances[outputIndex];
      const totalOrder = totalNumerators[outputIndex] / denominator;
      const firstOrder = 1 - firstNumerators[outputIndex] / denominator;
      outputs[outputName] = freeze({
        firstOrder,
        totalOrder,
        first: firstOrder,
        total: totalOrder,
        S1: firstOrder,
        ST: totalOrder,
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
