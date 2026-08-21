import { censoredGaussianLogLikelihood } from "./likelihood.js";
import { optimizeBounded } from "./optimizers.js";
import { parseParameterName } from "./parameter-space.js";
import { computeResiduals } from "./residuals.js";

const DEFAULT_MAX_PARAMETERS = 8;
const HARD_MAX_PARAMETERS = 12;
const PARAMETER_POLICIES = new Set(["scientific", "generic_test_adapter"]);

function fail(code, message, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  throw error;
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_NUMBER", `${name} must be a finite number.`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function roleOf(observation) {
  return String(
    observation?.role ??
      observation?.dataRole ??
      observation?.split ??
      observation?.partition ??
      "",
  )
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
}

function assertTrainingObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("INVALID_OBSERVATIONS", "observations must be a non-empty array.");
  }
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      fail("INVALID_OBSERVATION", `observations[${index}] must be an object.`);
    }
    const role = roleOf(observation);
    if (role.includes("validation") || role === "test" || role === "holdout") {
      fail(
        "VALIDATION_DATA_IN_FIT",
        `observations[${index}] is validation evidence and cannot be used for fitting.`,
      );
    }
    if (role !== "training" && role !== "train" && role !== "training_calibration") {
      fail(
        "TRAINING_ROLE_REQUIRED",
        `observations[${index}] must be explicitly marked as training data.`,
      );
    }
  });
}

function parameterPolicy(options) {
  const policy = options.parameterPolicy ?? "scientific";
  if (!PARAMETER_POLICIES.has(policy)) {
    fail(
      "INVALID_PARAMETER_POLICY",
      "parameterPolicy must be scientific or generic_test_adapter.",
    );
  }
  return policy;
}

function scientificParameterContext(options) {
  const source = options.parameterContext ?? options.scientificParameterContext ?? {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("INVALID_PARAMETER_CONTEXT", "parameterContext must be an object.");
  }
  return {
    initialStateSeriesIds:
      source.initialStateSeriesIds
      ?? source.declaredInitialStates
      ?? options.initialStateSeriesIds
      ?? options.declaredInitialStates
      ?? Object.keys(options.initialStates ?? options.resolvedModel?.initialStates ?? {}),
    drugIds:
      source.drugIds
      ?? options.drugIds
      ?? Object.keys(options.resolvedModel?.parameters?.drugs ?? {}),
  };
}

function parameterNames(options) {
  const whitelist = options.parameterWhitelist ?? options.whitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) {
    fail("PARAMETER_WHITELIST_REQUIRED", "A non-empty parameterWhitelist must be supplied explicitly.");
  }
  if (new Set(whitelist).size !== whitelist.length) {
    fail("DUPLICATE_PARAMETER", "parameterWhitelist cannot contain duplicate names.");
  }
  whitelist.forEach((name, index) => {
    if (typeof name !== "string" || name.trim() === "") {
      fail("INVALID_PARAMETER_NAME", `parameterWhitelist[${index}] must be a non-empty string.`);
    }
  });
  if (parameterPolicy(options) === "scientific") {
    const context = scientificParameterContext(options);
    whitelist.forEach((name) => parseParameterName(name, context));
  }
  const configuredMaximum = options.maxParameters ?? DEFAULT_MAX_PARAMETERS;
  if (!Number.isInteger(configuredMaximum) || configuredMaximum <= 0) {
    fail("INVALID_PARAMETER_LIMIT", "maxParameters must be a positive integer.");
  }
  if (configuredMaximum > HARD_MAX_PARAMETERS) {
    fail(
      "HARD_PARAMETER_LIMIT_EXCEEDED",
      `maxParameters cannot exceed the hard limit of ${HARD_MAX_PARAMETERS}.`,
    );
  }
  if (whitelist.length > configuredMaximum) {
    fail(
      "PARAMETER_LIMIT_EXCEEDED",
      `Cannot fit ${whitelist.length} parameters; configured maximum is ${configuredMaximum}.`,
    );
  }
  return [...whitelist];
}

function normalizeBounds(bounds, names) {
  if (!bounds || typeof bounds !== "object") {
    fail("PARAMETER_BOUNDS_REQUIRED", "Explicit bounds are required for every whitelisted parameter.");
  }
  const result = {};
  for (const name of names) {
    const bound = bounds[name];
    const lower = Array.isArray(bound) ? bound[0] : bound?.lower ?? bound?.min;
    const upper = Array.isArray(bound) ? bound[1] : bound?.upper ?? bound?.max;
    if (
      typeof lower !== "number" ||
      !Number.isFinite(lower) ||
      typeof upper !== "number" ||
      !Number.isFinite(upper) ||
      lower >= upper
    ) {
      fail("INVALID_PARAMETER_BOUNDS", `bounds.${name} must specify finite lower < upper.`);
    }
    result[name] = [lower, upper];
  }
  return result;
}

function normalizeInitial(initialParameters, names, bounds) {
  if (initialParameters === undefined) return undefined;
  if (!initialParameters || typeof initialParameters !== "object" || Array.isArray(initialParameters)) {
    fail("INVALID_INITIAL_PARAMETERS", "initialParameters must be an object.");
  }
  const result = {};
  for (const name of names) {
    const value = initialParameters[name];
    finite(value, `initialParameters.${name}`);
    if (value < bounds[name][0] || value > bounds[name][1]) {
      fail("INITIAL_PARAMETER_OUT_OF_BOUNDS", `initialParameters.${name} is outside its bounds.`);
    }
    result[name] = value;
  }
  return result;
}

function normalizeFixedParameters(options, names) {
  const source =
    options.fixedParameters ??
    options.baseParameters ??
    options.parameters ??
    options.initialParameters ??
    {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("INVALID_FIXED_PARAMETERS", "fixed/base parameters must be an object.");
  }
  const result = clone(source);
  for (const name of names) delete result[name];
  return result;
}

function measurementKind(observation) {
  return String(
    observation.measurementType ??
      observation.measurement ??
      observation.observable ??
      observation.scale ??
      observation.unit ??
      "log10_cfu",
  )
    .trim()
    .toLowerCase();
}

function isOpticalDensity(observation) {
  const kind = measurementKind(observation);
  return kind === "od" || kind.includes("optical_density") || kind.includes("optical density") || /^od\d*/.test(kind);
}

function predictionNumber(value, path) {
  if (typeof value === "number") return finite(value, path);
  if (!value || typeof value !== "object") {
    fail("INVALID_PREDICTION", `${path} must be a number or prediction object.`);
  }
  const selected =
    value.predicted ??
    value.value ??
    value.mean ??
    value.predictedValue ??
    value.predictedLog10 ??
    value.log10Value ??
    value.log10PopulationDensity;
  return finite(selected, path);
}

function createPredictionFunction(options, observations) {
  const predictor = options.predictor ?? options.predict;
  const evaluator = options.evaluator;
  if (typeof predictor !== "function" && typeof evaluator !== "function") {
    fail("PREDICTOR_REQUIRED", "A predictor or evaluator callback is required.");
  }
  const observationModel = options.observationModel;
  if (observations.some(isOpticalDensity) && typeof observationModel !== "function") {
    fail(
      "OD_OBSERVATION_MODEL_REQUIRED",
      "OD observations require an explicit observationModel callback; OD cannot be treated as log10 CFU.",
    );
  }

  return (parameters) => {
    let rawPredictions;
    if (typeof evaluator === "function") {
      rawPredictions = evaluator(parameters, observations);
      if (!Array.isArray(rawPredictions) || rawPredictions.length !== observations.length) {
        fail("INVALID_EVALUATOR_RESULT", "evaluator must return one prediction per observation.");
      }
    } else {
      rawPredictions = observations.map((observation, index) =>
        predictor(parameters, observation, index),
      );
    }
    return rawPredictions.map((rawPrediction, index) => {
      const observation = observations[index];
      if (isOpticalDensity(observation)) {
        return predictionNumber(
          observationModel(rawPrediction, observation, parameters, index),
          `observationModel prediction ${index}`,
        );
      }
      if (typeof observationModel === "function" && options.applyObservationModelToAll === true) {
        return predictionNumber(
          observationModel(rawPrediction, observation, parameters, index),
          `observationModel prediction ${index}`,
        );
      }
      return predictionNumber(rawPrediction, `prediction ${index}`);
    });
  };
}

function censoringType(observation) {
  const descriptor =
    observation.censoring && typeof observation.censoring === "object"
      ? observation.censoring
      : observation;
  const raw =
    (typeof observation.censoring === "string" ? observation.censoring : null) ??
    descriptor.type ??
    observation.censoringType ??
    observation.censorType ??
    "exact";
  const normalized = String(raw).toLowerCase().replaceAll("-", "_");
  if (["none", "uncensored", "observed"].includes(normalized)) return "exact";
  if (["left_censored", "below", "<"].includes(normalized)) return "left";
  if (["right_censored", "above", ">"].includes(normalized)) return "right";
  if (normalized === "interval_censored") return "interval";
  return normalized;
}

function observedValue(observation) {
  const descriptor =
    observation.censoring && typeof observation.censoring === "object"
      ? observation.censoring
      : observation;
  return finite(
    descriptor.value ??
      observation.value ??
      observation.observed ??
      observation.observedValue ??
      observation.log10Value ??
      observation.observedLog10,
    "observed value",
  );
}

function sigmaFor(options, observation, index, parameters) {
  const source = options.sigma ?? options.errorModel;
  let sigma;
  if (typeof source === "function") {
    sigma = source(observation, index, parameters);
  } else if (typeof source === "number") {
    sigma = source;
  } else if (source && typeof source === "object") {
    sigma =
      source.sigma ??
      source.standardDeviation ??
      (source.parameter ? parameters[source.parameter] : undefined);
  }
  if (typeof sigma !== "number" || !Number.isFinite(sigma) || sigma <= 0) {
    fail("INVALID_SIGMA", "Censored Gaussian fitting requires sigma > 0 for every observation.", RangeError);
  }
  return sigma;
}

function normalizeMethod(options) {
  const raw = options.method ?? options.objective ?? options.loss ?? "exact_log10_least_squares";
  const method = String(raw).toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
  if (["least_squares", "log10_least_squares", "exact_log10_least_squares", "sse"].includes(method)) {
    return "exact_log10_least_squares";
  }
  if (["censored_gaussian", "censored_gaussian_likelihood", "gaussian_likelihood", "negative_log_likelihood", "nll"].includes(method)) {
    return "censored_gaussian_likelihood";
  }
  fail("INVALID_FITTING_METHOD", `Unsupported fitting method: ${String(raw)}.`);
}

export function fitParameters(options) {
  if (!options || typeof options !== "object") {
    fail("INVALID_OPTIONS", "fitParameters requires an options object.");
  }
  const observations = options.observations;
  assertTrainingObservations(observations);
  const names = parameterNames(options);
  const bounds = normalizeBounds(options.bounds, names);
  const initialParameters = normalizeInitial(
    options.initialParameters ?? options.start,
    names,
    bounds,
  );
  const fixedParameters = normalizeFixedParameters(options, names);
  const resolveParameters = (fitted) => ({ ...fixedParameters, ...fitted });
  const method = normalizeMethod(options);
  const predictAll = createPredictionFunction(options, observations);

  if (
    method === "exact_log10_least_squares" &&
    observations.some((observation) => censoringType(observation) !== "exact")
  ) {
    fail(
      "CENSORED_DATA_REQUIRE_LIKELIHOOD",
      "Censored observations cannot be assigned fake point residuals; use censored Gaussian likelihood.",
    );
  }

  const objective = (fitted) => {
    const parameters = resolveParameters(fitted);
    const predictions = predictAll(parameters);
    if (method === "exact_log10_least_squares") {
      let sumSquares = 0;
      for (let index = 0; index < observations.length; index += 1) {
        const residual = observedValue(observations[index]) - predictions[index];
        sumSquares += residual * residual;
      }
      return sumSquares;
    }
    let negativeLogLikelihood = 0;
    for (let index = 0; index < observations.length; index += 1) {
      negativeLogLikelihood -= censoredGaussianLogLikelihood(
        observations[index],
        predictions[index],
        sigmaFor(options, observations[index], index, parameters),
      );
    }
    return negativeLogLikelihood;
  };

  const optimization = optimizeBounded({
    objective,
    bounds,
    start: initialParameters,
    seed: options.seed ?? 0,
    restarts: options.restarts ?? 3,
    differentialEvolution: options.differentialEvolution,
    nelderMead: options.nelderMead,
  });
  const fittedParameters = optimization.bestParameters;
  const resolvedParameters = resolveParameters(fittedParameters);
  const predictions = predictAll(resolvedParameters);
  const residuals = computeResiduals(observations, predictions, {
    sigma:
      method === "censored_gaussian_likelihood"
        ? (observation, index) => sigmaFor(options, observation, index, resolvedParameters)
        : undefined,
  });

  return {
    role: "training_calibration",
    fittedOnThisData: true,
    eligibleAsValidationEvidence: false,
    method,
    parameterPolicy: parameterPolicy(options),
    parameterWhitelist: names,
    bounds: clone(bounds),
    fittedParameters: clone(fittedParameters),
    fixedParameters: clone(fixedParameters),
    resolvedParameters: clone(resolvedParameters),
    parameters: clone(resolvedParameters),
    objectiveValue: optimization.bestValue,
    predictions,
    residuals,
    observationCount: observations.length,
    optimization,
    converged: optimization.converged,
  };
}

export const fitModel = fitParameters;
export const fit = fitParameters;
export const DEFAULT_FITTING_PARAMETER_LIMIT = DEFAULT_MAX_PARAMETERS;
export const HARD_FITTING_PARAMETER_LIMIT = HARD_MAX_PARAMETERS;
