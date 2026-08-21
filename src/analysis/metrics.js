function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_NUMBER", `${name} must be a finite number.`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function observedValue(observation, index) {
  if (typeof observation === "number") return finite(observation, `observations[${index}]`);
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    fail("INVALID_OBSERVATION", `observations[${index}] must be a number or object.`);
  }
  const censoring = String(
    (typeof observation.censoring === "string" ? observation.censoring : null) ??
      observation.censoring?.type ??
      observation.censoringType ??
      observation.censorType ??
      "exact",
  ).toLowerCase();
  if (!["exact", "none", "uncensored", "observed"].includes(censoring)) {
    fail(
      "CENSORED_METRIC_UNDEFINED",
      "Point metrics cannot be computed by inventing residuals for censored observations.",
    );
  }
  return finite(
    observation.censoring?.value ??
      observation.value ??
      observation.observed ??
      observation.observedValue ??
      observation.log10Value ??
      observation.observedLog10,
    `observations[${index}] value`,
  );
}

function predictionValue(prediction, index, name = "predictions") {
  if (typeof prediction === "number") return finite(prediction, `${name}[${index}]`);
  if (!prediction || typeof prediction !== "object" || Array.isArray(prediction)) {
    fail("INVALID_PREDICTION", `${name}[${index}] must be a number or object.`);
  }
  return finite(
    prediction.predicted ??
      prediction.value ??
      prediction.mean ??
      prediction.predictedValue ??
      prediction.predictedLog10,
    `${name}[${index}] value`,
  );
}

function normalizeArguments(first, second, third) {
  if (Array.isArray(first)) {
    return { observations: first, predictions: second, options: third ?? {} };
  }
  if (!first || typeof first !== "object") {
    fail("INVALID_OPTIONS", "calculateMetrics requires observations and predictions.");
  }
  return {
    observations: first.observations,
    predictions: first.predictions,
    options: first,
  };
}

function unitId(observation, index, options) {
  if (typeof options.independentUnitId === "function") {
    return options.independentUnitId(observation, index);
  }
  const value =
    observation?.independentUnitId ??
    observation?.unitId ??
    options.independentUnitIds?.[index];
  if (typeof value !== "string" || value.trim() === "") {
    fail(
      "INDEPENDENT_UNIT_REQUIRED",
      `observations[${index}] must have an independentUnitId for macro metrics.`,
    );
  }
  return value;
}

function summarizeResiduals(residuals) {
  const count = residuals.length;
  const absolute = residuals.map(Math.abs);
  const sumSquares = residuals.reduce((sum, value) => sum + value * value, 0);
  return {
    count,
    rmse: Math.sqrt(sumSquares / count),
    mae: absolute.reduce((sum, value) => sum + value, 0) / count,
    meanResidual: residuals.reduce((sum, value) => sum + value, 0) / count,
    medianAbsoluteError: median(absolute),
  };
}

function metricSet(observations, predictions, options) {
  const residuals = [];
  const byUnit = new Map();
  for (let index = 0; index < observations.length; index += 1) {
    const residual =
      observedValue(observations[index], index) -
      predictionValue(predictions[index], index);
    residuals.push(residual);
    const id = unitId(observations[index], index, options);
    if (!byUnit.has(id)) byUnit.set(id, []);
    byUnit.get(id).push(residual);
  }
  const perUnit = [...byUnit.entries()].map(([independentUnitId, values]) => ({
    independentUnitId,
    ...summarizeResiduals(values),
  }));
  const pooled = summarizeResiduals(residuals);
  return {
    observationCount: observations.length,
    independentUnitCount: perUnit.length,
    macroRmse:
      perUnit.reduce((sum, unit) => sum + unit.rmse, 0) / perUnit.length,
    pooledRmse: pooled.rmse,
    mae: pooled.mae,
    meanResidual: pooled.meanResidual,
    medianAbsoluteError: pooled.medianAbsoluteError,
    perUnit,
  };
}

function normalizeBaseline(options) {
  const baseline = options.predeclaredBaseline ?? options.baseline;
  if (baseline === undefined && options.baselinePredictions === undefined) return null;
  if (Array.isArray(baseline)) {
    fail(
      "BASELINE_DECLARATION_REQUIRED",
      "Baseline predictions must be wrapped in an explicitly named predeclared baseline.",
    );
  }
  const descriptor = baseline ?? {
    id: options.baselineId,
    predictions: options.baselinePredictions,
  };
  if (!descriptor || typeof descriptor !== "object") {
    fail("INVALID_BASELINE", "baseline must be an object.");
  }
  const id = descriptor.id ?? descriptor.name ?? descriptor.label;
  if (typeof id !== "string" || id.trim() === "") {
    fail("BASELINE_DECLARATION_REQUIRED", "A predeclared baseline must have an id or name.");
  }
  if (descriptor.predeclared === false) {
    fail("BASELINE_NOT_PREDECLARED", "Post-hoc baselines are not valid validation comparisons.");
  }
  return { id, predictions: descriptor.predictions ?? options.baselinePredictions };
}

export function calculateMetrics(first, second, third) {
  const { observations, predictions, options } = normalizeArguments(first, second, third);
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("INVALID_OBSERVATIONS", "observations must be a non-empty array.");
  }
  if (!Array.isArray(predictions) || predictions.length !== observations.length) {
    fail("LENGTH_MISMATCH", "predictions must contain one value per observation.");
  }
  const result = metricSet(observations, predictions, options);
  const baseline = normalizeBaseline(options);
  if (baseline !== null) {
    if (!Array.isArray(baseline.predictions) || baseline.predictions.length !== observations.length) {
      fail("BASELINE_LENGTH_MISMATCH", "baseline predictions must match observations.");
    }
    const baselineMetrics = metricSet(observations, baseline.predictions, options);
    result.baselineComparison = {
      baselineId: baseline.id,
      predeclared: true,
      baselineMetrics,
      delta: {
        macroRmse: result.macroRmse - baselineMetrics.macroRmse,
        pooledRmse: result.pooledRmse - baselineMetrics.pooledRmse,
        mae: result.mae - baselineMetrics.mae,
        meanResidual: result.meanResidual - baselineMetrics.meanResidual,
        medianAbsoluteError:
          result.medianAbsoluteError - baselineMetrics.medianAbsoluteError,
      },
      improvement: {
        macroRmse: baselineMetrics.macroRmse - result.macroRmse,
        pooledRmse: baselineMetrics.pooledRmse - result.pooledRmse,
        mae: baselineMetrics.mae - result.mae,
        medianAbsoluteError:
          baselineMetrics.medianAbsoluteError - result.medianAbsoluteError,
      },
    };
  }
  return result;
}

export const computeMetrics = calculateMetrics;
export const validationMetrics = calculateMetrics;
