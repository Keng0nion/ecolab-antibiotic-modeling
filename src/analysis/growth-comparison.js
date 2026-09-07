import { normalizeObservationDataset } from "./dataset-import.js";
import { calculateMetrics } from "./metrics.js";
import { quantileR7 } from "./monte-carlo.js";
import { differentialEvolution, nelderMead } from "./optimizers.js";
import { createRandom, deriveSeed, RNG_ALGORITHM } from "./random.js";
import { assertNoSplitOverlap } from "./split.js";

const PARAMETER_NAMES = Object.freeze(["baselineOd", "amplitudeOd", "ratePerHour", "timingHours"]);
const MODEL_IDS = Object.freeze(["training_mean", "logistic", "gompertz"]);
const ROLES = ["training", "development", "validation"];
const IMPLEMENTATION = "direct-od-growth-comparison-v1";
const OPTIMIZER_DEFAULTS = Object.freeze({
  restarts: 1,
  populationSize: 24,
  differentialEvolutionMaxEvaluations: 2000,
  nelderMeadMaxEvaluations: 1000,
  tolerance: 1e-7,
  objectiveTolerance: 1e-12,
});

export const GROWTH_COMPARISON_LIMITS = Object.freeze({
  maximumObservations: 10_000,
  maximumTrainingTrajectories: 128,
  maximumBootstrapSamples: 2000,
  maximumRestarts: 5,
  maximumPopulationSize: 256,
  maximumStageEvaluations: 10_000,
  maximumTotalEvaluations: 20_000_000,
});

export class GrowthComparisonError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "GrowthComparisonError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = null) {
  throw new GrowthComparisonError(code, message, path);
}

function record(value, path, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("INVALID_OPTIONS", `${path} must be a plain object.`, path);
  }
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail("UNKNOWN_OPTION", `Unknown ${path}.${key}.`, `${path}.${key}`);
  }
  return value;
}

function number(value, path, lower = -Infinity, upper = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < lower || value > upper) {
    fail("INVALID_NUMBER", `${path} must be finite within [${lower}, ${upper}].`, path);
  }
  return value;
}

function integer(value, path, lower, upper) {
  number(value, path, lower, upper);
  if (!Number.isSafeInteger(value)) fail("INVALID_INTEGER", `${path} must be a safe integer.`, path);
  return value;
}

function idList(value, path) {
  if (!Array.isArray(value)) fail("INVALID_IDS", `${path} must be an array of exact IDs.`, path);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !id.trim() || seen.has(id)) {
      fail("INVALID_IDS", `${path} has an invalid or duplicate ID.`, path);
    }
    seen.add(id);
  }
  return [...seen].sort();
}

function sameIds(actual, expected, path) {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    fail("SPLIT_ID_MISMATCH", `${path} must exactly cover the declared complete trajectories/observations.`, path);
  }
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

function jsonSafe(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]));
  return value;
}

function warn(warnings, code, message, details = {}) {
  warnings.push({ code, severity: "warning", message, ...details });
}

function curve(model, time, parameters) {
  const { baselineOd, amplitudeOd, ratePerHour, timingHours } = parameters;
  const z = ratePerHour * (time - timingHours);
  // The split sigmoid avoids overflow; exp(-exp(-z)) safely saturates at either tail.
  const fraction = model === "logistic"
    ? (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)))
    : Math.exp(-Math.exp(-z));
  return baselineOd + amplitudeOd * fraction;
}

/**
 * Empirical direct OD600 curves, NOT CFU or log-population Zwietering models.
 * logistic: b + A / (1 + exp(-r*(t-c))); gompertz: b + A*exp(-exp(-r*(t-c))).
 * b and A are OD; r > 0 is an empirical shape coefficient (1/h); c is the
 * inflection time (h), not physiological lag. Maximum OD slopes are A*r/4 and
 * A*r/e respectively; r is NOT a specific population growth rate.
 */
export function evaluateOdGrowthCurve(model, timeHours, parameters) {
  if (!MODEL_IDS.slice(1).includes(model)) fail("UNKNOWN_MODEL", "model must be logistic or gompertz.", "model");
  number(timeHours, "timeHours", 0);
  record(parameters, "parameters", PARAMETER_NAMES);
  for (const name of PARAMETER_NAMES) number(parameters[name], `parameters.${name}`);
  if (!(parameters.amplitudeOd > 0) || !(parameters.ratePerHour > 0)) {
    fail("INVALID_PARAMETERS", "amplitudeOd and ratePerHour must be positive.", "parameters");
  }
  return number(curve(model, timeHours, parameters), "predictedOd");
}

function runtimeHooks(options) {
  const runtime = record(options.runtime ?? {}, "runtime", ["signal", "checkCancelled", "yieldControl"]);
  for (const [path, callback] of [["runtime.checkCancelled", runtime.checkCancelled], ["runtime.yieldControl", runtime.yieldControl], ["onProgress", options.onProgress]]) {
    if (callback !== undefined && typeof callback !== "function") fail("INVALID_CALLBACK", `${path} must be a function.`, path);
  }
  if (runtime.signal !== undefined && (!runtime.signal || typeof runtime.signal.aborted !== "boolean")) {
    fail("INVALID_SIGNAL", "runtime.signal must expose boolean aborted.", "runtime.signal");
  }
  const check = () => {
    if (runtime.signal?.aborted || runtime.checkCancelled?.() === true) {
      fail("ANALYSIS_CANCELLED", "Growth model comparison cancelled.");
    }
  };
  return {
    check,
    async checkpoint() {
      check();
      // Yield macrotasks by default so a Worker can receive its cancel message.
      await (runtime.yieldControl ? runtime.yieldControl() : new Promise((resolve) => setTimeout(resolve, 0)));
      check();
    },
    progress(phase, completed, total) {
      check();
      options.onProgress?.({ phase, completed, total });
      check();
    },
  };
}

function prepareDataset(options) {
  let dataset;
  try {
    dataset = normalizeObservationDataset(options.dataset);
    assertNoSplitOverlap(options.split);
  } catch (error) {
    fail(error.code ?? "INVALID_DATASET", error.message, error.path ?? "dataset");
  }
  const split = options.split;
  if (split.sourceDatasetId !== dataset.metadata.datasetId) fail("SPLIT_DATASET_MISMATCH", "split.sourceDatasetId must match dataset.", "split.sourceDatasetId");
  if (!dataset.observations.length || dataset.observations.length > GROWTH_COMPARISON_LIMITS.maximumObservations) {
    fail("OBSERVATION_LIMIT", "Dataset is empty or exceeds the observation limit.", "dataset.observations");
  }
  const units = new Map();
  const observations = new Map();
  for (const row of dataset.observations) {
    if (!row) fail("SPARSE_OBSERVATIONS", "dataset.observations cannot be sparse.", "dataset.observations");
    if (row.measurementType !== "od600" || row.censoring !== "none") {
      fail("OD600_REQUIRED", "Only uncensored direct OD600 observations are supported.", "dataset.observations");
    }
    if (observations.has(row.observationId)) fail("DUPLICATE_OBSERVATION_ID", "Observation IDs must be unique.");
    observations.set(row.observationId, row);
    if (!units.has(row.independentUnitId)) units.set(row.independentUnitId, []);
    const trajectory = units.get(row.independentUnitId);
    if (trajectory.length && (trajectory[0].role !== row.role || trajectory[0].seriesId !== row.seriesId)) {
      fail("INCOMPLETE_TRAJECTORY_SPLIT", "Each independentUnitId must identify one complete series in one role.");
    }
    if (trajectory.some((other) => other.timeHours === row.timeHours)) fail("DUPLICATE_TRAJECTORY_TIME", "A trajectory must have only one observation at each exact time.");
    trajectory.push(row);
  }
  for (const trajectory of units.values()) trajectory.sort((a, b) => a.timeHours - b.timeHours);
  const roles = {};
  for (const role of ROLES) {
    const independentUnitIds = idList(split.roles[role].independentUnitIds, `split.roles.${role}.independentUnitIds`);
    const observationIds = idList(split.roles[role].observationIds, `split.roles.${role}.observationIds`);
    sameIds(independentUnitIds, [...units].filter(([, rows]) => rows[0].role === role).map(([id]) => id).sort(), `split.roles.${role}.independentUnitIds`);
    sameIds(observationIds, dataset.observations.filter((row) => row.role === role).map((row) => row.observationId).sort(), `split.roles.${role}.observationIds`);
    roles[role] = { independentUnitIds, observationIds };
  }
  const developmentRole = options.developmentRole ?? "development";
  if (!["development", "validation"].includes(developmentRole)) fail("INVALID_DEVELOPMENT_ROLE", "developmentRole must be development or explicit legacy validation.");
  const trainingIds = roles.training.independentUnitIds;
  if (trainingIds.length < 2 || trainingIds.length > GROWTH_COMPARISON_LIMITS.maximumTrainingTrajectories) {
    fail("TRAINING_TRAJECTORY_LIMIT", "At least two training trajectories are required, within the declared limit.");
  }
  const developmentIds = roles[developmentRole].independentUnitIds;
  if (!developmentIds.length) fail("EMPTY_DEVELOPMENT_SPLIT", "The selected development role has no trajectories.");
  return {
    datasetId: dataset.metadata.datasetId, units, trainingIds, developmentIds, developmentRole,
    training: trainingIds.flatMap((id) => units.get(id)),
    development: developmentIds.flatMap((id) => units.get(id)),
    roles,
  };
}

function configuration(options, trainingIds) {
  const source = record(options.bounds, "bounds", PARAMETER_NAMES);
  const bounds = Object.fromEntries(PARAMETER_NAMES.map((name) => {
    const pair = source[name];
    if (!Array.isArray(pair) || pair.length !== 2) fail("INVALID_BOUNDS", `bounds.${name} requires [lower, upper].`);
    const lower = number(pair[0], `bounds.${name}[0]`);
    const upper = number(pair[1], `bounds.${name}[1]`);
    if (!(lower < upper) || !Number.isFinite(upper - lower)
      || (["amplitudeOd", "ratePerHour"].includes(name) && !(lower > 0))) {
      fail("INVALID_BOUNDS", `bounds.${name} must have finite width, lower < upper and positive amplitude/rate.`);
    }
    return [name, [lower, upper]];
  }));
  if (!Number.isFinite(bounds.baselineOd[1] + bounds.amplitudeOd[1])) fail("INVALID_BOUNDS", "The upper OD asymptote must be finite.");
  const optimizer = { ...OPTIMIZER_DEFAULTS, ...record(options.optimizer ?? {}, "optimizer", Object.keys(OPTIMIZER_DEFAULTS)) };
  integer(optimizer.restarts, "optimizer.restarts", 1, GROWTH_COMPARISON_LIMITS.maximumRestarts);
  integer(optimizer.populationSize, "optimizer.populationSize", 4, GROWTH_COMPARISON_LIMITS.maximumPopulationSize);
  for (const key of ["differentialEvolutionMaxEvaluations", "nelderMeadMaxEvaluations"]) {
    integer(optimizer[key], `optimizer.${key}`, 1, GROWTH_COMPARISON_LIMITS.maximumStageEvaluations);
  }
  number(optimizer.tolerance, "optimizer.tolerance", Number.MIN_VALUE, 1);
  number(optimizer.objectiveTolerance, "optimizer.objectiveTolerance", 0);
  const cv = record(options.crossValidation ?? {}, "crossValidation", ["folds", "tieTolerance"]);
  const foldSource = cv.folds ?? trainingIds.map((id) => [id]);
  if (!Array.isArray(foldSource) || foldSource.length < 2 || foldSource.length > trainingIds.length) {
    fail("INVALID_FOLDS", "Supply at least two folds, partitioning the complete training trajectories.");
  }
  const folds = Array.from(foldSource, (fold, index) => {
    const ids = idList(fold, `crossValidation.folds[${index}]`);
    if (!ids.length || ids.length === trainingIds.length) fail("INVALID_FOLDS", "Folds must hold out nonempty proper subsets of training trajectories.");
    return ids;
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  sameIds(folds.flat().sort(), trainingIds, "crossValidation.folds");
  const bootstrap = { samples: 200, intervalLevel: 0.95, ...record(options.bootstrap ?? {}, "bootstrap", ["samples", "intervalLevel"]) };
  integer(bootstrap.samples, "bootstrap.samples", 0, GROWTH_COMPARISON_LIMITS.maximumBootstrapSamples);
  number(bootstrap.intervalLevel, "bootstrap.intervalLevel", Number.MIN_VALUE, 1 - Number.EPSILON);
  const maximumEvaluationsPerFit = optimizer.restarts * (optimizer.differentialEvolutionMaxEvaluations + optimizer.nelderMeadMaxEvaluations);
  const maximumTotalEvaluations = maximumEvaluationsPerFit * (2 * (folds.length + 1) + bootstrap.samples);
  if (maximumTotalEvaluations > GROWTH_COMPARISON_LIMITS.maximumTotalEvaluations) fail("EVALUATION_LIMIT", "Requested combined CV/fitting/bootstrap budget exceeds the total evaluation limit.");
  return freeze({
    seed: integer(options.seed, "seed", 0, 0xffff_ffff),
    developmentRole: options.developmentRole ?? "development",
    randomAlgorithm: RNG_ALGORITHM,
    seedDerivation: "deriveSeed(root, direct-od-growth-comparison-v1, phase, model, index); restart and stage substreams",
    bounds, optimizer,
    crossValidation: { folds, tieTolerance: number(cv.tieTolerance ?? 1e-10, "crossValidation.tieTolerance", 0) },
    bootstrap,
    objective: "mean_trajectory_mse_od600",
    maximumEvaluationsPerFit, maximumTotalEvaluations,
    optimizerConstants: { mutationFactor: 0.8, crossoverRate: 0.9, initialStep: 0.05 },
  });
}

function phaseSeed(config, phase, model, index = 0) {
  return deriveSeed(config.seed, IMPLEMENTATION, phase, model, index);
}

function meanCurve(trajectories) {
  const byTime = new Map();
  for (const rows of trajectories) for (const row of rows) {
    if (!byTime.has(row.timeHours)) byTime.set(row.timeHours, []);
    byTime.get(row.timeHours).push(row.value);
  }
  return [...byTime].sort(([a], [b]) => a - b).map(([timeHours, values]) => ({
    timeHours,
    meanOd: values.reduce((sum, value) => sum + value / values.length, 0),
    trainingUnitCount: values.length,
  }));
}

function evaluateFit(fit, observations) {
  const lookup = new Map(fit.meanOdByTime?.map(({ timeHours, meanOd }) => [timeHours, meanOd]));
  const missingObservationIds = [];
  const predictions = observations.map((row) => {
    const predicted = fit.model === "training_mean" ? lookup.get(row.timeHours)
      : fit.parameters ? curve(fit.model, row.timeHours, fit.parameters) : undefined;
    if (!Number.isFinite(predicted)) missingObservationIds.push(row.observationId);
    return {
      observationId: row.observationId, independentUnitId: row.independentUnitId,
      timeHours: row.timeHours, observed: row.value,
      predicted: Number.isFinite(predicted) ? predicted : null,
      residual: Number.isFinite(predicted) ? row.value - predicted : null,
    };
  });
  let metrics = missingObservationIds.length ? null : calculateMetrics({ observations, predictions });
  if (metrics && ![metrics.macroRmse, metrics.pooledRmse, metrics.mae, metrics.meanResidual].every(Number.isFinite)) metrics = null;
  return {
    status: metrics ? "available" : "unavailable",
    predictions, metrics, missingObservationIds,
    residualConvention: "observed - predicted",
  };
}

async function fitModel(model, trajectories, config, seed, runtime, warnings, context) {
  const observations = trajectories.flat();
  if (model === "training_mean") {
    const fit = { model, parameters: null, meanOdByTime: meanCurve(trajectories), optimizer: null, converged: true, finite: true };
    return { ...fit, metrics: evaluateFit(fit, observations).metrics };
  }
  const objective = (parameters) => trajectories.reduce((sum, rows) => sum + rows.reduce((mse, row) => {
    const residual = row.value - curve(model, row.timeHours, parameters);
    return mse + residual * residual / rows.length;
  }, 0) / trajectories.length, 0);
  const start = Object.fromEntries(PARAMETER_NAMES.map((name) => [name, config.bounds[name][0] + (config.bounds[name][1] - config.bounds[name][0]) / 2]));
  const runs = [];
  let best = null;
  for (let restart = 0; restart < config.optimizer.restarts; restart += 1) {
    const restartSeed = deriveSeed(seed, "restart", restart);
    const common = { bounds: config.bounds, objective, tolerance: config.optimizer.tolerance, objectiveTolerance: config.optimizer.objectiveTolerance };
    // Shared optimizers catch objective exceptions; cancellation must stay outside.
    await runtime.checkpoint();
    const de = differentialEvolution({
      ...common, seed: deriveSeed(restartSeed, "de"), start: restart === 0 ? start : undefined,
      populationSize: config.optimizer.populationSize,
      maxEvaluations: config.optimizer.differentialEvolutionMaxEvaluations,
      mutationFactor: config.optimizerConstants.mutationFactor, crossoverRate: config.optimizerConstants.crossoverRate,
    });
    await runtime.checkpoint();
    const nm = nelderMead({
      ...common, seed: deriveSeed(restartSeed, "nm"), start: de.bestParameters,
      maxEvaluations: config.optimizer.nelderMeadMaxEvaluations, initialStep: config.optimizerConstants.initialStep,
    });
    runtime.check();
    const chosen = nm.bestValue <= de.bestValue ? nm : de;
    const run = {
      restart, seed: restartSeed, differentialEvolution: de, nelderMead: nm,
      bestParameters: chosen.bestParameters, bestValue: chosen.bestValue,
      converged: chosen.converged, terminationReason: chosen.terminationReason,
      chosenOptimizer: chosen.optimizer, evaluationCount: de.evaluationCount + nm.evaluationCount,
    };
    runs.push(run);
    if (!best || run.bestValue < best.bestValue) best = run;
  }
  const finite = Number.isFinite(best.bestValue);
  const optimizer = jsonSafe({
    optimizer: "bounded_differential_evolution_then_nelder_mead", seed, randomAlgorithm: RNG_ALGORITHM,
    restarts: runs, bestParameters: best.bestParameters, bestValue: best.bestValue,
    converged: finite && best.converged, terminationReason: best.terminationReason,
    evaluationCount: runs.reduce((sum, run) => sum + run.evaluationCount, 0),
  });
  if (!optimizer.converged) warn(warnings, "OPTIMIZER_NOT_CONVERGED", "A bounded fit did not converge; its finite estimate remains provisional.", { context, model, seed });
  if (runs.some((run) => !run.differentialEvolution.converged || !run.nelderMead.converged)) {
    warn(warnings, "OPTIMIZER_STAGE_NOT_CONVERGED", "At least one optimizer stage exhausted its budget or failed; see retained stage diagnostics.", { context, model, seed });
  }
  const fit = { model, parameters: finite ? best.bestParameters : null, meanOdByTime: null, finite, optimizer, converged: optimizer.converged };
  return { ...fit, metrics: evaluateFit(fit, observations).metrics };
}

async function crossValidate(data, config, runtime, warnings) {
  const candidates = {};
  let completed = 0;
  const total = MODEL_IDS.length * config.crossValidation.folds.length;
  runtime.progress("cross_validation", 0, total);
  for (const model of MODEL_IDS) {
    const folds = [];
    for (let index = 0; index < config.crossValidation.folds.length; index += 1) {
      await runtime.checkpoint();
      const heldOutIndependentUnitIds = config.crossValidation.folds[index];
      const trainingIndependentUnitIds = data.trainingIds.filter((id) => !heldOutIndependentUnitIds.includes(id));
      const fit = await fitModel(model, trainingIndependentUnitIds.map((id) => data.units.get(id)), config,
        phaseSeed(config, "cv", model, index), runtime, warnings, `cv:${index}`);
      const evaluation = evaluateFit(fit, heldOutIndependentUnitIds.flatMap((id) => data.units.get(id)));
      folds.push({ index, trainingIndependentUnitIds, heldOutIndependentUnitIds, fit, ...evaluation });
      runtime.progress("cross_validation", ++completed, total);
    }
    const eligible = folds.every((fold) => fold.status === "available");
    const predictions = folds.flatMap((fold) => fold.predictions);
    const metrics = eligible ? calculateMetrics({ observations: predictions, predictions }) : null;
    candidates[model] = { model, eligible, score: metrics?.macroRmse ?? null, metrics, folds };
    if (!eligible) warn(warnings, model === "training_mean" ? "EXACT_TIME_BASELINE_UNAVAILABLE" : "CV_CANDIDATE_UNAVAILABLE",
      "Candidate cannot be scored on every held-out training observation; it is excluded, without partial-row scoring or interpolation.", { context: "cross_validation", model });
  }
  return {
    sourceRole: "training", unit: "whole_trajectory", metric: "macroRmse",
    aggregation: "Arithmetic mean of out-of-fold per-trajectory RMSEs, not an unweighted mean of fold scores.",
    candidates,
  };
}

function selectModel(crossValidation, config) {
  const eligible = MODEL_IDS.filter((id) => crossValidation.candidates[id].eligible);
  if (!eligible.length) fail("NO_ELIGIBLE_MODEL", "No candidate can be scored on all training CV observations.");
  const minimumScore = Math.min(...eligible.map((id) => crossValidation.candidates[id].score));
  const tiedModels = eligible.filter((id) => crossValidation.candidates[id].score <= minimumScore + config.crossValidation.tieTolerance);
  return freeze({
    selectedModel: tiedModels[0], sourceRole: "training", metric: "macroRmse",
    minimumScore, selectedScore: crossValidation.candidates[tiedModels[0]].score,
    tieTolerance: config.crossValidation.tieTolerance, tieOrder: [...MODEL_IDS], tiedModels,
    tiePolicy: "Within absolute tolerance of the global minimum, prefer training_mean, then logistic, then gompertz.",
    frozenBeforeDevelopment: true,
  });
}

function modelDefinitions() {
  const interpretation = "Empirical direct-OD observation-scale adaptation, not CFU or log-population Zwietering physiology. ratePerHour is a shape coefficient, not specific population growth; timingHours is OD inflection time, not physiological lag.";
  return {
    training_mean: {
      id: "training-unit-mean-od-by-exact-source-time", sourceRole: "training", predeclared: true,
      equation: "OD600(t) = arithmetic mean of training-trajectory OD600 values at exact t",
      interpretation: "No interpolation; each contributing trajectory has one value at that time. Coverage counts are retained for irregular supports.",
      cfuConversion: false,
    },
    logistic: {
      equation: "OD600(t) = baselineOd + amplitudeOd / (1 + exp(-ratePerHour * (t - timingHours)))",
      interpretation, cfuConversion: false, parameterNames: [...PARAMETER_NAMES],
      maximumOdSlope: "amplitudeOd * ratePerHour / 4",
      parameterUnits: { baselineOd: "OD600", amplitudeOd: "OD600", ratePerHour: "1/h", timingHours: "h" },
    },
    gompertz: {
      equation: "OD600(t) = baselineOd + amplitudeOd * exp(-exp(-ratePerHour * (t - timingHours)))",
      interpretation, cfuConversion: false, parameterNames: [...PARAMETER_NAMES],
      maximumOdSlope: "amplitudeOd * ratePerHour / e",
      parameterUnits: { baselineOd: "OD600", amplitudeOd: "OD600", ratePerHour: "1/h", timingHours: "h" },
    },
  };
}

function conditionalIntervals(samples, model, times, level) {
  const successful = samples.filter(({ status }) => status === "success");
  const tail = (1 - level) / 2;
  const available = successful.length >= 2;
  const interval = (values) => {
    values.sort((a, b) => a - b);
    return { lower: quantileR7(values, tail), median: quantileR7(values, 0.5), upper: quantileR7(values, 1 - tail) };
  };
  return {
    kind: "exploratory_conditional_percentile_intervals", status: available ? "available" : "unavailable",
    level, quantileMethod: "R7", successfulSampleCount: successful.length,
    expectedTailSamples: successful.length * tail,
    minimumExpectedTailSamples: 5,
    tailResolutionAdequate: successful.length * tail >= 5 - 1e-12,
    precisionAssessed: false,
    conditioning: "Frozen selected model, explicit bounds, observed training trajectories, and converged finite refits only; resampling assumes exchangeable trajectories but their independence is unverified.",
    includesModelSelectionUncertainty: false, includesObservationNoise: false,
    parameterIndependenceAssumed: false,
    predictionInterpretation: "Pointwise fitted-mean OD curve intervals on training times; not simultaneous bands or new-observation prediction intervals.",
    parameters: available && model !== "training_mean" ? Object.fromEntries(PARAMETER_NAMES.map((name) => [name,
      interval(successful.map((sample) => sample.parameters[name])),
    ])) : {},
    predictions: available ? times.map((timeHours) => ({
      timeHours,
      ...interval(successful.map((sample) => model === "training_mean"
        ? sample.meanOdByTime.find((row) => row.timeHours === timeHours).meanOd
        : curve(model, timeHours, sample.parameters))),
    })) : [],
  };
}

async function bootstrapSelected(data, selectedModel, config, runtime, warnings) {
  const times = [...new Set(data.training.map(({ timeHours }) => timeHours))].sort((a, b) => a - b);
  const samples = [];
  const failures = [];
  const bootstrapWarnings = [];
  const count = config.bootstrap.samples;
  if (count < 200) warn(bootstrapWarnings, "LOW_BOOTSTRAP_SAMPLE_COUNT", "Fewer than 200 requested resamples; interval precision is not established (zero disables resampling).");
  runtime.progress("bootstrap", 0, count);
  for (let index = 0; index < count; index += 1) {
    await runtime.checkpoint();
    const seed = phaseSeed(config, "bootstrap", selectedModel, index);
    const resamplingSeed = deriveSeed(seed, "trajectory-draw");
    const optimizerSeed = deriveSeed(seed, "refit");
    const random = createRandom(resamplingSeed);
    const sampledIndependentUnitIds = data.trainingIds.map(() => data.trainingIds[Math.floor(random.next() * data.trainingIds.length)]);
    const trajectories = sampledIndependentUnitIds.map((id) => data.units.get(id));
    const fit = await fitModel(selectedModel, trajectories, config, optimizerSeed, runtime, bootstrapWarnings, `bootstrap:${index}`);
    const missingSupport = selectedModel === "training_mean" && times.some((time) => !fit.meanOdByTime.some((row) => row.timeHours === time));
    const reason = !fit.finite ? "no_finite_fit" : !fit.converged ? "optimizer_not_converged" : missingSupport ? "missing_prediction_support" : null;
    samples.push({
      index, seed, resamplingSeed, optimizerSeed, sampledIndependentUnitIds,
      sampledObservationIds: trajectories.map((rows) => rows.map((row) => row.observationId)),
      status: reason ? "failure" : "success", failureReason: reason,
      parameters: fit.parameters,
      parameterVector: fit.parameters ? PARAMETER_NAMES.map((name) => fit.parameters[name]) : null,
      meanOdByTime: fit.meanOdByTime, optimizer: fit.optimizer, converged: fit.converged,
    });
    if (reason) failures.push({ index, seed, reason });
    runtime.progress("bootstrap", index + 1, count);
  }
  if (failures.length) warn(bootstrapWarnings, "BOOTSTRAP_REFIT_FAILURES", "Failed/nonconverged refits are retained but excluded from conditional intervals; exclusion may bias these exploratory summaries.", { failureCount: failures.length });
  const intervals = conditionalIntervals(samples, selectedModel, times, config.bootstrap.intervalLevel);
  if (count && intervals.status === "unavailable") warn(bootstrapWarnings, "BOOTSTRAP_INTERVALS_UNAVAILABLE", "At least two successful refits with joint prediction support are required.");
  if (count && !intervals.tailResolutionAdequate) warn(bootstrapWarnings, "BOOTSTRAP_TAILS_UNRESOLVED", "Fewer than five expected successful samples per percentile tail; interval endpoints are poorly resolved. Passing this heuristic would still not establish precision or coverage.");
  warnings.push(...bootstrapWarnings);
  return {
    status: count ? "completed" : "disabled", selectedModel, sourceRole: "training",
    resamplingUnit: "whole_training_trajectory", paired: true, independenceAssumption: "unverified",
    parameterNames: selectedModel === "training_mean" ? [] : [...PARAMETER_NAMES],
    requestedSamples: count, successfulSamples: count - failures.length,
    jointSamplesRetained: true, samples, failures, intervals, warnings: bootstrapWarnings,
  };
}

/**
 * Compare empirical OD curves using ONLY complete training trajectories for
 * fitting, CV selection and paired bootstrap. Returns a deeply frozen JSON-safe
 * result. No model selection, bounds, RNG seeds or bootstrap grid uses development.
 *
 * Required options:
 * - dataset: normalized observation-dataset (uncensored od600, finite time >= 0).
 * - split: createDatasetSplit() shape, exact role observation/independent-unit IDs.
 *   Source dataset ID and exact coverage are checked; content hashes belong to the
 *   caller's audited import/replay layer and are not recomputed here.
 * - seed: uint32; bounds: {baselineOd, amplitudeOd, ratePerHour, timingHours}, each
 *   [finite lower, finite upper], positive amplitude/rate lower bounds. No auto bounds.
 * Optional options (defaults are copied into result.configuration):
 * - developmentRole: 'development' (or explicit 'validation' for viewed legacy data).
 * - optimizer: restarts=1, populationSize=24, differentialEvolutionMaxEvaluations=2000,
 *   nelderMeadMaxEvaluations=1000, tolerance=1e-7, objectiveTolerance=1e-12.
 * - crossValidation: {folds?: string[][], tieTolerance?: 1e-10}; folds partition all
 *   training unit IDs exactly once; default leave-one-out, canonicalized by exact ID.
 * - bootstrap: {samples: 200, intervalLevel: 0.95}; samples=0 disables refits.
 * - runtime: {signal?, checkCancelled?: () => void|boolean, yieldControl?: async () => void}.
 *   true/aborted rejects with ANALYSIS_CANCELLED; host-thrown errors propagate unchanged.
 *   Checks/yields are between synchronous bounded optimizer stages, never inside their
 *   exception-catching objectives. Default yield is setTimeout(0); latency <= one stage.
 * - onProgress?: ({phase, completed, total}) => void (not part of replay configuration).
 *
 * Result: {schemaVersion, kind, implementationId, completed, dataset, configuration,
 * models, trainingFits:{training_mean,logistic,gompertz}, crossValidation:{candidates},
 * selection:{selectedModel,...}, development:{selected,baseline,...}, bootstrap, warnings}.
 * Fits retain {parameters,meanOdByTime,optimizer:{restarts:[{differentialEvolution,
 * nelderMead,...}],...},converged,finite,metrics}. Evaluations retain identity-keyed
 * predictions {observed,predicted,residual,...}, macro/pooled/per-unit metrics, missing
 * exact-time IDs and availability. CV folds also retain the full fit and exact IDs.
 * Bootstrap samples retain draw IDs (including multiplicity), observation-ID groups,
 * JOINT parameterVector/parameters (or meanOdByTime for baseline), diagnostics and
 * failures. Intervals exclude failed/nonconverged samples; they are exploratory,
 * conditional on model/bounds and unverified trajectory exchangeability, not clinical
 * evidence, independent parameter distributions, or sensitivity-analysis inputs.
 */
export async function runGrowthModelComparison(options = {}) {
  record(options, "options", ["dataset", "split", "developmentRole", "seed", "bounds", "optimizer", "crossValidation", "bootstrap", "runtime", "onProgress"]);
  const runtime = runtimeHooks(options);
  runtime.check();
  const data = prepareDataset(options);
  const config = configuration(options, data.trainingIds);
  const warnings = [];
  warn(warnings, "OD600_NOT_CFU", "Both curves are empirical direct OD600 models; no CFU conversion or physiological lag/population-rate interpretation.");
  warn(warnings, "DEVELOPMENT_ALREADY_VIEWED", "Development curves were previously viewed and are not untouched or external validation evidence.");
  warn(warnings, "TRAJECTORY_INDEPENDENCE_UNVERIFIED", "Complete-trajectory resampling preserves within-trajectory pairing; between-trajectory independence and exchangeability remain unverified.");
  warn(warnings, "EXPLORATORY_CONDITIONAL_INTERVALS", "Bootstrap intervals condition on a selected model, bounds, training data and successful refits; precision, coverage and identification are not established. Do not mix marginal samples into independent-input sensitivity analyses.");
  if (config.optimizer.differentialEvolutionMaxEvaluations < Math.max(500, 10 * config.optimizer.populationSize)
    || config.optimizer.nelderMeadMaxEvaluations < 500) {
    warn(warnings, "LOW_OPTIMIZER_BUDGET", "Reduced optimizer budget; completion does not establish convergence or a global optimum.");
  }
  const crossValidation = await crossValidate(data, config, runtime, warnings);
  const selection = selectModel(crossValidation, config);
  const trainingFits = {};
  runtime.progress("training_fit", 0, MODEL_IDS.length);
  for (const [index, model] of MODEL_IDS.entries()) {
    trainingFits[model] = await fitModel(model, data.trainingIds.map((id) => data.units.get(id)), config,
      phaseSeed(config, "training", model), runtime, warnings, "training");
    runtime.progress("training_fit", index + 1, MODEL_IDS.length);
  }
  const bootstrap = await bootstrapSelected(data, selection.selectedModel, config, runtime, warnings);
  await runtime.checkpoint();
  runtime.progress("development", 0, 1);
  const selected = evaluateFit(trainingFits[selection.selectedModel], data.development);
  const baseline = evaluateFit(trainingFits.training_mean, data.development);
  if (baseline.status === "unavailable") warn(warnings, "EXACT_TIME_BASELINE_UNAVAILABLE", "Development times absent from the frozen training mean have no prediction; no interpolation or partial-row score is used.", { context: "development", missingObservationIds: baseline.missingObservationIds });
  const development = {
    role: "development_comparison", observationRoleUsed: data.developmentRole,
    previouslyViewed: true, eligibleAsValidationEvidence: false, fittedOnThisData: false,
    parametersAltered: false, optimizerUsed: false, selectedModel: selection.selectedModel,
    independentUnitIds: data.developmentIds, observationIds: data.roles[data.developmentRole].observationIds,
    selected, baseline,
    deltaMacroRmseVsBaseline: selected.metrics && baseline.metrics ? selected.metrics.macroRmse - baseline.metrics.macroRmse : null,
  };
  runtime.progress("development", 1, 1);
  runtime.progress("complete", 1, 1);
  return freeze(jsonSafe({
    schemaVersion: "1.0.0", kind: "od600-growth-model-comparison", implementationId: IMPLEMENTATION, completed: true,
    dataset: { id: data.datasetId, trainingIndependentUnitIds: data.trainingIds, trainingObservationIds: data.roles.training.observationIds },
    configuration: config, models: modelDefinitions(), trainingFits, crossValidation, selection, development, bootstrap, warnings,
  }));
}
