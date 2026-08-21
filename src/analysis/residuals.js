import { censoredGaussianLogLikelihood } from "./likelihood.js";

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

function normalizeObservation(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    fail("INVALID_OBSERVATION", "observation must be an object.");
  }
  const descriptor =
    observation.censoring && typeof observation.censoring === "object"
      ? observation.censoring
      : observation;
  const rawType =
    (typeof observation.censoring === "string" ? observation.censoring : null) ??
    descriptor.type ??
    observation.censoringType ??
    observation.censorType ??
    "exact";
  const normalized = String(rawType).toLowerCase().replaceAll("-", "_");
  const type =
    normalized === "none" || normalized === "uncensored" || normalized === "observed"
      ? "exact"
      : normalized === "left_censored" || normalized === "below" || normalized === "<"
        ? "left"
        : normalized === "right_censored" || normalized === "above" || normalized === ">"
          ? "right"
          : normalized === "interval_censored"
            ? "interval"
            : normalized;
  const censoringBounds = observation.censoringBounds ?? descriptor.bounds ?? {};
  return {
    type,
    value:
      descriptor.value ??
      observation.value ??
      observation.observed ??
      observation.observedValue ??
      observation.log10Value ??
      observation.observedLog10,
    lower:
      descriptor.lower ??
      descriptor.lowerBound ??
      censoringBounds.lower ??
      observation.lower ??
      observation.lowerBound ??
      observation.interval?.[0] ??
      (type === "right" ? descriptor.limit ?? observation.limit : undefined),
    upper:
      descriptor.upper ??
      descriptor.upperBound ??
      censoringBounds.upper ??
      observation.upper ??
      observation.upperBound ??
      observation.interval?.[1] ??
      (type === "left" ? descriptor.limit ?? observation.limit : undefined),
  };
}

export function residualForObservation(observation, predicted, options = {}) {
  finite(predicted, "predicted");
  const normalized = normalizeObservation(observation);
  const common = {
    observationId: observation.id ?? observation.observationId ?? null,
    independentUnitId: observation.independentUnitId ?? null,
    predicted,
    censoring: normalized.type,
  };

  if (normalized.type === "exact") {
    const observed = finite(normalized.value, "observed");
    return {
      ...common,
      kind: "point",
      observed,
      residual: observed - predicted,
    };
  }

  let lower;
  let upper;
  if (normalized.type === "left") {
    upper = finite(normalized.upper, "upper censoring limit") - predicted;
    lower = -Infinity;
  } else if (normalized.type === "right") {
    lower = finite(normalized.lower, "lower censoring limit") - predicted;
    upper = Infinity;
  } else if (normalized.type === "interval") {
    lower = finite(normalized.lower, "lower censoring limit") - predicted;
    upper = finite(normalized.upper, "upper censoring limit") - predicted;
    if (lower > upper) fail("INVALID_INTERVAL", "Censoring interval must have lower <= upper.");
  } else {
    fail("INVALID_CENSORING_TYPE", `Unsupported censoring type: ${normalized.type}.`);
  }

  const result = {
    ...common,
    kind: "interval",
    residualInterval: { lower, upper },
  };
  if (options.sigma !== undefined) {
    result.logLikelihoodContribution = censoredGaussianLogLikelihood(
      observation,
      predicted,
      options.sigma,
    );
  }
  return result;
}

export function computeResiduals(observations, predictions, options = {}) {
  if (!Array.isArray(observations) || !Array.isArray(predictions)) {
    fail("INVALID_ARRAY", "observations and predictions must be arrays.");
  }
  if (observations.length !== predictions.length) {
    fail("LENGTH_MISMATCH", "observations and predictions must have equal length.");
  }
  return observations.map((observation, index) => {
    const sigma =
      typeof options.sigma === "function"
        ? options.sigma(observation, index)
        : observation.sigma ?? options.sigma;
    return residualForObservation(observation, predictions[index], {
      sigma,
    });
  });
}

export const calculateResidual = residualForObservation;
export const calculateResiduals = computeResiduals;
