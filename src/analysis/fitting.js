import { censoredGaussianLogLikelihood } from "./likelihood.js";
import { analyzeIdentifiability } from "./identifiability.js";
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

function normalizeOptimizationTransforms(source, names, bounds) {
  if (source === undefined) return {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    fail("INVALID_OPTIMIZATION_TRANSFORMS", "optimizationTransforms must be a parameter-keyed object.");
  }
  const result = {};
  for (const [name, transform] of Object.entries(source)) {
    if (!names.includes(name)) {
      fail("UNKNOWN_OPTIMIZATION_TRANSFORM", `optimizationTransforms.${name} is not a fitted parameter.`);
    }
    if (transform !== "log" && transform !== "negative_log") {
      fail("INVALID_OPTIMIZATION_TRANSFORM", `optimizationTransforms.${name} must be log or negative_log.`);
    }
    const [lower, upper] = bounds[name];
    if ((transform === "log" && lower <= 0) || (transform === "negative_log" && upper >= 0)) {
      fail("INVALID_OPTIMIZATION_TRANSFORM_BOUNDS", `bounds.${name} are incompatible with ${transform}.`);
    }
    result[name] = transform;
  }
  return result;
}

function toOptimizationCoordinates(parameters, transforms) {
  return Object.fromEntries(Object.entries(parameters).map(([name, value]) => [
    name,
    transforms[name] === "log" ? Math.log(value)
      : transforms[name] === "negative_log" ? Math.log(-value)
        : value,
  ]));
}

function toModelCoordinates(parameters, transforms) {
  return Object.fromEntries(Object.entries(parameters).map(([name, value]) => [
    name,
    transforms[name] === "log" ? Math.exp(value)
      : transforms[name] === "negative_log" ? -Math.exp(value)
        : value,
  ]));
}

function transformBounds(bounds, transforms) {
  return Object.fromEntries(Object.entries(bounds).map(([name, [lower, upper]]) => [
    name,
    transforms[name] === "log" ? [Math.log(lower), Math.log(upper)]
      : transforms[name] === "negative_log" ? [Math.log(-upper), Math.log(-lower)]
        : [lower, upper],
  ]));
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

  return (parameters, targetObservations = observations) => {
    let rawPredictions;
    if (typeof evaluator === "function") {
      rawPredictions = evaluator(parameters, targetObservations);
      if (!Array.isArray(rawPredictions) || rawPredictions.length !== targetObservations.length) {
        fail("INVALID_EVALUATOR_RESULT", "evaluator must return one prediction per observation.");
      }
    } else {
      rawPredictions = targetObservations.map((observation, index) =>
        predictor(parameters, observation, index),
      );
    }
    return rawPredictions.map((rawPrediction, index) => {
      const observation = targetObservations[index];
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

function parameterBoundaryDiagnostics(parameters, bounds, names) {
  const parametersAtBound = [];
  for (const name of names) {
    const [lower, upper] = bounds[name];
    const tolerance = Math.max((upper - lower) * 1e-5, Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)) * 8);
    if (parameters[name] <= lower + tolerance) {
      parametersAtBound.push({ parameter: name, side: "lower", value: parameters[name], bound: lower, tolerance });
    }
    if (parameters[name] >= upper - tolerance) {
      parametersAtBound.push({ parameter: name, side: "upper", value: parameters[name], bound: upper, tolerance });
    }
  }
  return { status: "ASSESSED", parametersAtBound };
}

function notIdentifiableResult({ method, parameterPolicy: policy, names, bounds, fixedParameters, observations, exactObservationCount, reason }) {
  const requiredExactObservationCount = names.length + 1;
  return {
    role: "training_calibration",
    fittedOnThisData: true,
    eligibleAsValidationEvidence: false,
    status: "NOT_IDENTIFIABLE",
    method,
    parameterPolicy: policy,
    parameterWhitelist: names,
    bounds: clone(bounds),
    fittedParameters: null,
    fixedParameters: clone(fixedParameters),
    resolvedParameters: null,
    parameters: null,
    objectiveValue: null,
    predictions: null,
    residuals: null,
    observationCount: observations.length,
    optimization: null,
    optimizationCoordinates: null,
    converged: false,
    fitDiagnostics: {
      identifiability: {
        status: "NOT_IDENTIFIABLE",
        method: "uncensored_observation_count",
        exactObservationCount,
        requiredExactObservationCount,
        freeParameterCount: names.length,
        reason,
      },
      convergence: { status: "NOT_RUN", terminationReason: null },
      boundary: { status: "NOT_ASSESSED", parametersAtBound: [] },
      sigmaAtLowerBound: null,
      profileLikelihood: { status: "NOT_ASSESSED", reason: "profile_likelihood_not_run_by_shared_fitter" },
    },
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
  const optimizationTransforms = normalizeOptimizationTransforms(options.optimizationTransforms, names, bounds);
  const optimizationBounds = transformBounds(bounds, optimizationTransforms);
  const optimizationStart = initialParameters
    ? toOptimizationCoordinates(initialParameters, optimizationTransforms)
    : undefined;
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

  const exactObservations = observations.filter((observation) => censoringType(observation) === "exact");
  const requiredExactObservationCount = names.length + 1;
  if (exactObservations.length < requiredExactObservationCount) {
    return notIdentifiableResult({
      method,
      parameterPolicy: parameterPolicy(options),
      names,
      bounds,
      fixedParameters,
      observations,
      exactObservationCount: exactObservations.length,
      reason: "insufficient_uncensored_observations",
    });
  }

  const objective = (coordinates) => {
    const fitted = toModelCoordinates(coordinates, optimizationTransforms);
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
    bounds: optimizationBounds,
    start: optimizationStart,
    seed: options.seed ?? 0,
    restarts: options.restarts ?? 3,
    differentialEvolution: options.differentialEvolution,
    nelderMead: options.nelderMead,
  });
  const optimizerBestParameters = optimization.bestParameters;
  const fittedParameters = toModelCoordinates(optimizerBestParameters, optimizationTransforms);
  optimization.coordinateSpace = Object.keys(optimizationTransforms).length > 0 ? "transformed" : "model";
  optimization.modelSpaceBestParameters = clone(fittedParameters);
  const resolvedParameters = resolveParameters(fittedParameters);
  const predictions = predictAll(resolvedParameters);
  const residuals = computeResiduals(observations, predictions, {
    sigma:
      method === "censored_gaussian_likelihood"
        ? (observation, index) => sigmaFor(options, observation, index, resolvedParameters)
        : undefined,
  });

  const localIdentifiability = method === "exact_log10_least_squares"
    ? analyzeIdentifiability({
      parameters: fittedParameters,
      parameterWhitelist: names,
      bounds,
      observations: exactObservations,
      evaluator: (candidate, exactRows) => predictAll(resolveParameters(candidate), exactRows),
    })
    : null;
  const localRank = localIdentifiability?.rank;
  const parametersAtBound = parameterBoundaryDiagnostics(fittedParameters, bounds, names).parametersAtBound;
  const sigmaParameterName = names.find((name) => /(?:^|\.)(?:errorSigmaLog10|sigma(?:Log10)?|sigmaLog10Residual)$/iu.test(name)) ?? null;
  const sigmaAtLowerBound = sigmaParameterName
    ? parametersAtBound.some((hit) => hit.parameter === sigmaParameterName && hit.side === "lower")
    : null;
  const identifiability = method === "exact_log10_least_squares"
    ? {
      status: localRank === names.length ? "ASSESSED_FULL_RANK_LOCAL" : "NOT_IDENTIFIABLE",
      method: "local_prediction_jacobian",
      exactObservationCount: exactObservations.length,
      requiredExactObservationCount,
      rank: localRank,
      parameterCount: names.length,
      conditionNumber: localIdentifiability.conditionNumber,
      warningCodes: localIdentifiability.warnings.map((warning) => warning.code),
    }
    : {
      status: "NOT_ASSESSED",
      method: "uncensored_observation_count",
      exactObservationCount: exactObservations.length,
      requiredExactObservationCount,
      reason: "likelihood_profile_required_for_parameter_identifiability",
    };
  const fitStatus = localIdentifiability && localRank < names.length
    ? "NOT_IDENTIFIABLE"
    : optimization.converged ? "FIT_COMPLETED" : "FIT_NOT_CONVERGED";
  const diagnostics = {
    identifiability,
    convergence: {
      status: optimization.converged ? "CONVERGED" : "NOT_CONVERGED",
      terminationReason: optimization.terminationReason ?? null,
    },
    boundary: { status: "ASSESSED", parametersAtBound },
    sigmaAtLowerBound,
    profileLikelihood: { status: "NOT_ASSESSED", reason: "profile_likelihood_not_run_by_shared_fitter" },
  };
  if (fitStatus === "NOT_IDENTIFIABLE") {
    return {
      role: "training_calibration",
      fittedOnThisData: true,
      eligibleAsValidationEvidence: false,
      status: fitStatus,
      method,
      parameterPolicy: parameterPolicy(options),
      parameterWhitelist: names,
      bounds: clone(bounds),
      fittedParameters: null,
      fixedParameters: clone(fixedParameters),
      resolvedParameters: null,
      parameters: null,
      objectiveValue: null,
      predictions: null,
      residuals: null,
      observationCount: observations.length,
      optimization: null,
      optimizationCoordinates: null,
      converged: optimization.converged,
      fitDiagnostics: diagnostics,
    };
  }

  return {
    role: "training_calibration",
    fittedOnThisData: true,
    eligibleAsValidationEvidence: false,
    status: fitStatus,
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
    optimizationCoordinates: {
      transforms: clone(optimizationTransforms),
      bounds: clone(optimizationBounds),
      bestParameters: clone(optimizerBestParameters),
    },
    converged: optimization.converged,
    fitDiagnostics: diagnostics,
  };
}

export const fitModel = fitParameters;
export const fit = fitParameters;
export const DEFAULT_FITTING_PARAMETER_LIMIT = DEFAULT_MAX_PARAMETERS;
export const HARD_FITTING_PARAMETER_LIMIT = HARD_MAX_PARAMETERS;
