import { simulatePiecewise } from "../model.js";
import {
  buildResearchPackage,
  createAnalysisManifest,
  generateMethodsSummaryMarkdown,
} from "./analysis-manifest.js";
import { lockAnalysisPlan } from "./analysis-plan.js";
import { assessCapability } from "./capability.js";
import { importObservationDataset } from "./dataset-import.js";
import { assessDatasetQuality } from "./dataset-quality.js";
import { fingerprintJson, sha256HexFallback } from "./fingerprint.js";
import { fitParameters } from "./fitting.js";
import { analyzeIdentifiability } from "./identifiability.js";
import { calculateMetrics } from "./metrics.js";
import { runMonteCarlo } from "./monte-carlo.js";
import { applyParameterOverrides } from "./parameter-space.js";
import { runParameterScan } from "./parameter-scan.js";
import { deriveSeed, RNG_ALGORITHM } from "./random.js";
import {
  ar1DesignEffect,
  estimateVarianceComponents,
  pooledAr1Coefficient,
  randomInterceptAr1ProfileNegativeLogLikelihood,
  refineThresholdCrossing,
} from "./residual-dependence.js";
import { localSensitivity } from "./sensitivity-local.js";
import { morrisSensitivity } from "./sensitivity-morris.js";
import { sobolJansenSensitivity } from "./sensitivity-sobol.js";
import { createDatasetSplit } from "./split.js";
import { validateLockedPlan } from "./validation.js";
import { ANALYSIS_ENGINE_VERSION, ANALYSIS_IMPLEMENTATION_ID } from "./version.js";
import {
  applyOdObservationLayer,
  OD_OBSERVATION_MODEL_EQUATION,
  profileOdObservationLayer,
} from "./od-observation-model.js";

const DATASET_ID = "figshare-bw25113-growth-v1";
const MODEL_ID = "ecolab.single-population.regoes-logistic";
const MODEL_IMPLEMENTATION_ID = "regoes-logistic-piecewise-analytic-v1";
const GROWTH_PARAMETER = "psiMaxLog10PerHour";
const INITIAL_STATE_PARAMETER = "initialStates.pooled.log10PopulationDensity";
const PARAMETER_NAMES = Object.freeze([GROWTH_PARAMETER, INITIAL_STATE_PARAMETER]);
const SCALAR_OUTPUT_TIME_HOURS = 10;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

export const ECOLAB_STAGE4_WORKFLOW_LIMITS = Object.freeze({
  maximumOptimizerRestarts: 5,
  maximumDifferentialEvolutionEvaluations: 10_000,
  maximumNelderMeadEvaluations: 10_000,
  maximumScanPointsPerAxis: 15,
  maximumMonteCarloSamples: 4096,
  maximumReturnedMonteCarloSamples: 256,
  maximumMorrisTrajectories: 64,
  maximumSobolSamples: 1024,
  maximumProfileRootRefinementIterations: 20,
});

export class EcolabResearchWorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "EcolabResearchWorkflowError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path = null, actual = undefined, ErrorType = EcolabResearchWorkflowError) {
  throw new ErrorType(code, message, { path, actual });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value, path) {
  if (!isRecord(value)) fail("INVALID_WORKFLOW_INPUT", `${path} must be a plain object.`, path, value);
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_WORKFLOW_STRING", `${path} must be a non-empty string.`, path, value);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_WORKFLOW_NUMBER", `${path} must be a finite number.`, path, value);
  }
  return value;
}

function uint32(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    fail("INVALID_UINT32_SEED", `${path} must be an unsigned 32-bit integer.`, path, value);
  }
  return value >>> 0;
}

function integerOption(value, fallback, path, minimum, maximum) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    fail(
      "INVALID_WORKFLOW_LIMIT",
      `${path} must be an integer within [${minimum}, ${maximum}].`,
      path,
      result,
    );
  }
  return result;
}

function booleanOption(value, fallback, path) {
  const result = value ?? fallback;
  if (typeof result !== "boolean") {
    fail("INVALID_WORKFLOW_OPTION", `${path} must be a boolean.`, path, result);
  }
  return result;
}

function enumOption(value, fallback, path, allowed) {
  const result = value ?? fallback;
  if (!allowed.includes(result)) {
    fail(
      "INVALID_WORKFLOW_OPTION",
      `${path} must be one of: ${allowed.join(", ")}.`,
      path,
      result,
    );
  }
  return result;
}

function jsonSafe(value) {
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) result[key] = jsonSafe(child);
    }
    return result;
  }
  return String(value);
}

function progressCallback(value) {
  if (value === undefined) return null;
  if (typeof value !== "function") {
    fail("INVALID_PROGRESS_CALLBACK", "onProgress must be a function.", "onProgress", value);
  }
  return value;
}

function emit(progress, phase, completed, total) {
  progress?.({ phase, completed, total });
}

// Synchronous numerical engines catch evaluator exceptions. Cancellation stays
// outside those engines and yields between complete, explicitly bounded phases.
export function researchWorkflowRuntime(options = {}) {
  const runtime = record(options.runtime ?? {}, "runtime");
  for (const key of ["checkCancelled", "yieldControl"]) {
    if (runtime[key] !== undefined && typeof runtime[key] !== "function") fail("INVALID_RUNTIME_CALLBACK", `runtime.${key} must be a function.`);
  }
  if (runtime.signal !== undefined && typeof runtime.signal?.aborted !== "boolean") fail("INVALID_RUNTIME_SIGNAL", "runtime.signal must expose boolean aborted.");
  const callback = progressCallback(options.onProgress);
  const check = () => {
    if (runtime.signal?.aborted || runtime.checkCancelled?.() === true) fail("ANALYSIS_CANCELLED", "Research workflow cancelled.");
  };
  return {
    check,
    progress(event) { check(); callback?.(event); check(); },
    async checkpoint() {
      check();
      if (options.runtime) await (runtime.yieldControl ? runtime.yieldControl() : new Promise((resolve) => setTimeout(resolve, 0)));
      check();
    },
  };
}

function conditionValue(observation, metadataConditions, key) {
  const local = observation?.conditions;
  if (isRecord(local) && local[key] !== undefined && local[key] !== null && local[key] !== "") {
    return local[key];
  }
  return metadataConditions[key];
}

function requireCondition(container, key, path) {
  if (container[key] === undefined || container[key] === null || container[key] === "") {
    fail("MISSING_REQUIRED_CONDITION", `${path}.${key} is required.`, `${path}.${key}`);
  }
  return container[key];
}

function canonicalTimeKey(value) {
  return finite(value, "timeHours").toString();
}

function assertSupportedResolvedModel(resolvedModel) {
  record(resolvedModel, "resolvedModel");
  record(resolvedModel.ref, "resolvedModel.ref");
  record(resolvedModel.parameters, "resolvedModel.parameters");
  if (resolvedModel.ref.id !== MODEL_ID) {
    fail("UNSUPPORTED_MODEL", `resolvedModel.ref.id must be ${MODEL_ID}.`, "resolvedModel.ref.id", resolvedModel.ref.id);
  }
  if (resolvedModel.ref.implementationId !== MODEL_IMPLEMENTATION_ID) {
    fail(
      "UNSUPPORTED_MODEL_IMPLEMENTATION",
      `resolvedModel.ref.implementationId must be ${MODEL_IMPLEMENTATION_ID}.`,
      "resolvedModel.ref.implementationId",
      resolvedModel.ref.implementationId,
    );
  }
  finite(resolvedModel.parameters.psiMaxLog10PerHour, "resolvedModel.parameters.psiMaxLog10PerHour");
  const carryingCapacity = finite(
    resolvedModel.parameters.carryingCapacityLog10CfuPerMl,
    "resolvedModel.parameters.carryingCapacityLog10CfuPerMl",
  );
  if (carryingCapacity <= 3.1) {
    fail(
      "INCOMPATIBLE_CARRYING_CAPACITY",
      "The fixed carrying capacity must exceed the conservative initial-state lower bound.",
      "resolvedModel.parameters.carryingCapacityLog10CfuPerMl",
      carryingCapacity,
    );
  }
  return carryingCapacity;
}

function assertScientificDataset(dataset) {
  record(dataset, "dataset");
  record(dataset.metadata, "dataset.metadata");
  if (dataset.metadata.datasetId !== DATASET_ID) {
    fail(
      "UNSUPPORTED_DATASET",
      `This workflow requires dataset ${DATASET_ID}.`,
      "dataset.metadata.datasetId",
      dataset.metadata.datasetId,
    );
  }
  if (!Array.isArray(dataset.observations) || dataset.observations.length === 0) {
    fail("EMPTY_DATASET", "The dataset must contain observations.", "dataset.observations");
  }
  const metadataConditions = record(dataset.metadata.conditions, "dataset.metadata.conditions");
  for (const key of [
    "organism",
    "strain",
    "medium",
    "temperatureC",
    "treatment",
    "antibioticExposure",
    "plateFormat",
    "plateReader",
    "rawOdBlankCorrection",
  ]) {
    requireCondition(metadataConditions, key, "dataset.metadata.conditions");
  }
  if (String(metadataConditions.treatment).toLowerCase() !== "untreated") {
    fail("TREATMENT_NOT_SUPPORTED", "The bundled Stage 4 workflow requires untreated observations.", "dataset.metadata.conditions.treatment");
  }
  if (metadataConditions.antibioticExposure !== false) {
    fail("ANTIBIOTIC_EXPOSURE_NOT_SUPPORTED", "Antibiotic exposure must be explicitly false.", "dataset.metadata.conditions.antibioticExposure");
  }
  if (!String(metadataConditions.rawOdBlankCorrection).toLowerCase().includes("unblanked")) {
    fail(
      "RAW_OD_SEMANTICS_REQUIRED",
      "The dataset must explicitly document raw, unmodified OD600 source values.",
      "dataset.metadata.conditions.rawOdBlankCorrection",
    );
  }

  const units = new Map();
  const times = new Set();
  dataset.observations.forEach((observation, index) => {
    const path = `dataset.observations[${index}]`;
    record(observation, path);
    if (observation.measurementType !== "od600") {
      fail("NON_OD600_OBSERVATION", "Every observation must retain OD600 measurement semantics.", `${path}.measurementType`, observation.measurementType);
    }
    if (observation.drugId !== "none" || observation.concentrationMgPerL !== 0) {
      fail("DRUG_EXPOSURE_NOT_SUPPORTED", "Every observation must be a constant no-drug condition.", path, {
        drugId: observation.drugId,
        concentrationMgPerL: observation.concentrationMgPerL,
      });
    }
    if (observation.censoring !== "none") {
      fail("CENSORING_NOT_SUPPORTED", "This raw OD600 workflow requires uncensored observations.", `${path}.censoring`, observation.censoring);
    }
    if (observation.role !== "training" && observation.role !== "validation") {
      fail("INCOMPLETE_TRAINING_VALIDATION_ROLES", "Every observation must be assigned to training or validation.", `${path}.role`, observation.role);
    }
    if (!(observation.timeHours > 0)) {
      fail(
        "SOURCE_T0_FORBIDDEN",
        "The bundled source has no t0 observation; t0 records cannot be inserted or fabricated.",
        `${path}.timeHours`,
        observation.timeHours,
      );
    }
    if (!(observation.value >= 0) || !Number.isFinite(observation.value)) {
      fail("INVALID_OD600_VALUE", "OD600 values must be finite and non-negative.", `${path}.value`, observation.value);
    }
    for (const key of ["organism", "strain", "medium", "temperatureC", "treatment", "antibioticExposure"] ) {
      const value = conditionValue(observation, metadataConditions, key);
      if (value === undefined || value === null || value === "") {
        fail("MISSING_REQUIRED_CONDITION", `${path}.conditions.${key} is required.`, `${path}.conditions.${key}`);
      }
    }
    if (String(conditionValue(observation, metadataConditions, "treatment")).toLowerCase() !== "untreated") {
      fail("TREATMENT_NOT_SUPPORTED", "Observation conditions must be untreated.", `${path}.conditions.treatment`);
    }
    if (conditionValue(observation, metadataConditions, "antibioticExposure") !== false) {
      fail("ANTIBIOTIC_EXPOSURE_NOT_SUPPORTED", "Observation antibioticExposure must be false.", `${path}.conditions.antibioticExposure`);
    }
    const unitId = nonEmptyString(observation.independentUnitId, `${path}.independentUnitId`);
    const timeKey = canonicalTimeKey(observation.timeHours);
    times.add(timeKey);
    let unit = units.get(unitId);
    if (!unit) {
      unit = { role: observation.role, timeKeys: new Set() };
      units.set(unitId, unit);
    }
    if (unit.role !== observation.role) {
      fail("INDEPENDENT_UNIT_ROLE_LEAKAGE", `${unitId} appears in both training and validation.`, path, unitId);
    }
    if (unit.timeKeys.has(timeKey)) {
      fail("DUPLICATE_UNIT_TIME", `${unitId} contains duplicate observations at ${observation.timeHours} h.`, path);
    }
    unit.timeKeys.add(timeKey);
  });

  const sourceTimes = [...times].map(Number).sort((left, right) => left - right);
  if (!sourceTimes.includes(SCALAR_OUTPUT_TIME_HOURS)) {
    fail(
      "PREDECLARED_OUTPUT_TIME_MISSING",
      `The predeclared ${SCALAR_OUTPUT_TIME_HOURS} h sensitivity output must be an exact source time.`,
      "dataset.observations",
    );
  }
  const expectedTimes = sourceTimes.map(canonicalTimeKey);
  let trainingUnitCount = 0;
  let validationUnitCount = 0;
  for (const [unitId, unit] of units) {
    if (unit.role === "training") trainingUnitCount += 1;
    else validationUnitCount += 1;
    const actualTimes = [...unit.timeKeys].map(Number).sort((left, right) => left - right).map(canonicalTimeKey);
    if (JSON.stringify(actualTimes) !== JSON.stringify(expectedTimes)) {
      fail(
        "INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY",
        `${unitId} does not contain the complete exact source-time trajectory.`,
        "dataset.observations",
        unitId,
      );
    }
  }
  if (trainingUnitCount === 0 || validationUnitCount === 0) {
    fail(
      "INCOMPLETE_TRAINING_VALIDATION_ROLES",
      "At least one complete training unit and one complete validation unit are required.",
      "dataset.observations",
      { trainingUnitCount, validationUnitCount },
    );
  }
  return {
    sourceTimes,
    maximumTimeHours: sourceTimes.at(-1),
    independentUnitCount: units.size,
    trainingUnitCount,
    validationUnitCount,
  };
}

function parameterSpaceFor(carryingCapacity) {
  const initialUpper = Math.min(8.5, carryingCapacity - 0.1);
  if (!(initialUpper > 3)) {
    fail("INCOMPATIBLE_INITIAL_STATE_BOUNDS", "The fixed carrying capacity leaves no valid initial-state range.");
  }
  return {
    parameters: [
      {
        name: GROWTH_PARAMETER,
        lower: 0.05,
        upper: 0.8,
        transform: "identity",
        rationale: "A conservative positive untreated-growth range spanning approximately 23-minute to 6-hour doubling times without invoking treatment effects.",
      },
      {
        name: INITIAL_STATE_PARAMETER,
        lower: 3,
        upper: initialUpper,
        transform: "identity",
        rationale: "A broad latent model-time-zero population-density range constrained below the fixed carrying capacity; raw OD600 does not establish an absolute CFU scale."
      },
    ],
    initialStateSeriesIds: ["pooled"],
  };
}

function boundsFromSpace(parameterSpace) {
  return Object.fromEntries(
    parameterSpace.parameters.map(({ name, lower, upper }) => [name, [lower, upper]]),
  );
}

function clamp(value, lower, upper) {
  return Math.max(lower, Math.min(upper, value));
}

function initialParameters(resolvedModel, parameterSpace) {
  const bounds = boundsFromSpace(parameterSpace);
  return {
    [GROWTH_PARAMETER]: clamp(
      resolvedModel.parameters.psiMaxLog10PerHour,
      bounds[GROWTH_PARAMETER][0],
      bounds[GROWTH_PARAMETER][1],
    ),
    [INITIAL_STATE_PARAMETER]:
      (bounds[INITIAL_STATE_PARAMETER][0] + bounds[INITIAL_STATE_PARAMETER][1]) / 2,
  };
}

function uniqueSortedTimes(observations) {
  return [...new Set(observations.map(({ timeHours }) => timeHours))].sort((left, right) => left - right);
}

function constantNoDrugProtocol(maximumTimeHours) {
  return {
    kind: "piecewise_constant",
    drugId: "none",
    segments: [{
      start: { value: 0, unit: "h" },
      end: { value: maximumTimeHours, unit: "h" },
      concentration: { value: 0, unit: "mg/L" },
    }],
  };
}

function simulateLatentFractions(resolvedModel, biologicalParameters, times, maximumTimeHours) {
  const snapshot = applyParameterOverrides(resolvedModel, biologicalParameters, {
    initialStateSeriesIds: ["pooled"],
  });
  const initialLog10 = snapshot.initialStates?.pooled?.log10PopulationDensity;
  finite(initialLog10, INITIAL_STATE_PARAMETER);
  const carryingCapacity = snapshot.parameters.carryingCapacityLog10CfuPerMl;
  const simulation = simulatePiecewise(snapshot, {
    protocol: constantNoDrugProtocol(maximumTimeHours),
    sampleTimes: times.map((value) => ({ value, unit: "h" })),
    initialState: {
      populationDensity: { value: initialLog10, unit: "log10(CFU/mL)" },
    },
  });
  const byTime = new Map(
    simulation.trajectory.map((row) => [canonicalTimeKey(row.timeHours), row]),
  );
  return times.map((timeHours) => {
    const row = byTime.get(canonicalTimeKey(timeHours));
    if (!row) {
      fail("SIMULATION_TIME_MISSING", `The simulator did not return exact time ${timeHours} h.`);
    }
    const fraction = 10 ** (row.latentLog10PopulationDensity - carryingCapacity);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1 + 1e-9) {
      fail("INVALID_LATENT_FRACTION", "The latent logistic N/K fraction is invalid.", null, fraction);
    }
    return Math.min(1, fraction);
  });
}

function predictionsAtObservations(resolvedModel, biologicalParameters, observations, maximumTimeHours, nuisance) {
  const times = uniqueSortedTimes(observations);
  const fractions = simulateLatentFractions(
    resolvedModel,
    biologicalParameters,
    times,
    maximumTimeHours,
  );
  const byTime = new Map(times.map((time, index) => [canonicalTimeKey(time), fractions[index]]));
  return observations.map((observation) =>
    applyOdObservationLayer(byTime.get(canonicalTimeKey(observation.timeHours)), nuisance));
}

function profiledTrainingEvaluation(resolvedModel, biologicalParameters, observations, maximumTimeHours) {
  const times = uniqueSortedTimes(observations);
  const fractions = simulateLatentFractions(
    resolvedModel,
    biologicalParameters,
    times,
    maximumTimeHours,
  );
  const byTime = new Map(times.map((time, index) => [canonicalTimeKey(time), fractions[index]]));
  const alignedFractions = observations.map((observation) => byTime.get(canonicalTimeKey(observation.timeHours)));
  return profileOdObservationLayer({
    latentFractions: alignedFractions,
    observedOd: observations.map(({ value }) => value),
    minimumScaleOd: 1e-12,
  });
}

function profileGrid(lower, upper, estimate, pointCount) {
  const values = Array.from({ length: pointCount }, (_, index) => lower + ((upper - lower) * index) / (pointCount - 1));
  const interiorIndexes = values.map((_, index) => index).filter((index) => index > 0 && index < pointCount - 1);
  const nearest = interiorIndexes.reduce((best, index) => (
    Math.abs(values[index] - estimate) < Math.abs(values[best] - estimate) ? index : best
  ), interiorIndexes[0]);
  values[nearest] = Math.min(upper, Math.max(lower, estimate));
  const unique = [...new Set(values)].sort((a, b) => a - b);
  while (unique.length < pointCount) {
    let largestGap = -1;
    let largestGapIndex = 0;
    for (let index = 0; index < unique.length - 1; index += 1) {
      const gap = unique[index + 1] - unique[index];
      if (gap > largestGap) { largestGap = gap; largestGapIndex = index; }
    }
    unique.splice(largestGapIndex + 1, 0, (unique[largestGapIndex] + unique[largestGapIndex + 1]) / 2);
  }
  return unique;
}

function profileCrossing(points, threshold, direction) {
  const ordered = direction === "upper" ? [...points].reverse() : points;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const first = ordered[index];
    const second = ordered[index + 1];
    if (first.deltaNegativeLogLikelihood > threshold && second.deltaNegativeLogLikelihood <= threshold) {
      const fraction = (threshold - first.deltaNegativeLogLikelihood)
        / (second.deltaNegativeLogLikelihood - first.deltaNegativeLogLikelihood);
      return first.value + (second.value - first.value) * fraction;
    }
  }
  return null;
}

function profileCrossingBracket(points, deltaOf, threshold, direction) {
  const ordered = direction === "upper" ? [...points].reverse() : points;
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const outer = ordered[index];
    const inner = ordered[index + 1];
    const outerDelta = deltaOf(outer);
    const innerDelta = deltaOf(inner);
    if (Number.isFinite(outerDelta) && Number.isFinite(innerDelta)
      && outerDelta > threshold && innerDelta <= threshold) {
      return { outer, inner };
    }
  }
  return null;
}

async function profileLeastSquaresLikelihood({
  fit,
  observations,
  resolvedModel,
  maximumTimeHours,
  bounds,
  config,
  computation,
  seed,
  checkpoint,
  onProgress,
}) {
  const threshold = 1.920729410347062;
  const method = "profile_likelihood_gaussian_ssr_sigma_profiled";
  const ar1Method = "profile_likelihood_gaussian_random_intercept_ar1_sigma_profiled";
  const ar1Enabled = config.profileErrorModel === "both";
  const refinementEnabled = config.profileRootRefinement;
  const maxIterations = config.profileRootRefinementMaxIterations;
  const relativeTolerance = config.profileRootRefinementRelativeTolerance;
  const profileTargets = {};
  const ar1Parameters = {};
  let ar1Status = "ASSESSED";
  let ar1Reason = null;
  let completed = 0;
  let refinementIndex = 0;
  let refitEvaluationCount = 0;
  let total = PARAMETER_NAMES.length * config.profileLikelihoodPoints
    + (refinementEnabled ? PARAMETER_NAMES.length * 2 * maxIterations * (ar1Enabled ? 2 : 1) : 0);
  const report = () => onProgress?.({ completed, total });

  let dependence = null;
  let dependenceFailure = null;
  if (ar1Enabled) {
    try {
      if (!Array.isArray(fit.residuals) || fit.residuals.length !== observations.length) {
        throw Object.assign(new Error("The main fit did not return aligned residuals."), {
          code: "AR1_RESIDUALS_UNAVAILABLE",
        });
      }
      const coefficient = pooledAr1Coefficient(observations, fit.residuals);
      const components = estimateVarianceComponents(observations, fit.residuals);
      const designEffect = ar1DesignEffect(components.observationsPerCurve, coefficient.phi, components.lambda);
      dependence = {
        method: "random_intercept_ar1_within_curve",
        phi: coefficient.phi,
        lambda: components.lambda,
        icc: components.icc,
        betweenCurveSd: components.betweenCurveSd,
        withinCurveSd: components.withinCurveSd,
        curveCount: components.curveCount,
        observationsPerCurve: components.observationsPerCurve,
        designEffect,
        effectiveSampleSize: observations.length / designEffect,
        lagOneDesignEffect: 1 + (components.observationsPerCurve - 1) * coefficient.phi,
      };
    } catch (error) {
      dependenceFailure = error?.code ?? "AR1_ESTIMATION_FAILED";
      ar1Status = "NOT_ASSESSED";
      ar1Reason = dependenceFailure;
    }
  }

  const ar1NegativeLogLikelihood = (residuals) => {
    if (!dependence || !Array.isArray(residuals) || residuals.length !== observations.length) return null;
    try {
      return randomInterceptAr1ProfileNegativeLogLikelihood({
        observations,
        residuals,
        phi: dependence.phi,
        lambda: dependence.lambda,
      });
    } catch {
      return null;
    }
  };

  const evaluateAt = async (targetName, value, tag) => {
    let refit;
    if (Math.abs(value - fit.fittedParameters[targetName]) <= 1e-12 * Math.max(1, Math.abs(value))) {
      refit = {
        objectiveValue: fit.objectiveValue,
        converged: fit.converged,
        status: fit.status,
        terminationReason: fit.optimization?.terminationReason ?? null,
        residuals: fit.residuals,
        optimization: null,
      };
    } else {
      const freeNames = PARAMETER_NAMES.filter((name) => name !== targetName);
      refit = fitParameters({
        observations,
        parameterPolicy: "scientific",
        parameterWhitelist: freeNames,
        parameterContext: { initialStateSeriesIds: ["pooled"], drugIds: [] },
        bounds,
        initialParameters: fit.fittedParameters,
        fixedParameters: { [targetName]: value },
        method: "least_squares",
        seed: deriveSeed(seed, "profile-likelihood", targetName, tag),
        restarts: config.optimizerRestarts,
        differentialEvolution: {
          ...computation.differentialEvolution,
          populationSize: config.populationSize,
          maxEvaluations: config.differentialEvolutionMaxEvaluations,
        },
        nelderMead: { ...computation.nelderMead, maxEvaluations: config.nelderMeadMaxEvaluations },
        evaluator: (biologicalParameters, rows) => profiledTrainingEvaluation(
          resolvedModel,
          biologicalParameters,
          rows,
          maximumTimeHours,
        ).predictions,
        observationModel: (profiledOdPrediction) => profiledOdPrediction,
      });
    }
    const sumSquares = refit.objectiveValue;
    const negativeLogLikelihood = Number.isFinite(sumSquares) && sumSquares >= 0
      ? (observations.length / 2) * Math.log(Math.max(sumSquares / observations.length, Number.MIN_VALUE))
      : null;
    refitEvaluationCount += refit.optimization?.evaluationCount ?? 0;
    return {
      value,
      sumSquaredError: sumSquares,
      negativeLogLikelihood,
      ar1NegativeLogLikelihood: ar1NegativeLogLikelihood(refit.residuals),
      converged: refit.converged === true,
      fitStatus: refit.status,
      terminationReason: refit.terminationReason ?? refit.optimization?.terminationReason ?? null,
    };
  };

  for (const targetName of PARAMETER_NAMES) {
    const [lower, upper] = bounds[targetName];
    const profileValues = profileGrid(lower, upper, fit.fittedParameters[targetName], config.profileLikelihoodPoints);
    const evaluated = [];
    for (let index = 0; index < profileValues.length; index += 1) {
      await checkpoint();
      evaluated.push(await evaluateAt(targetName, profileValues[index], `grid-${index}`));
      completed += 1;
      report();
    }

    const usable = evaluated.filter((point) => Number.isFinite(point.negativeLogLikelihood));
    const minimum = usable.length ? Math.min(...usable.map((point) => point.negativeLogLikelihood)) : null;
    const deltaOf = (point) => (Number.isFinite(point.negativeLogLikelihood) && Number.isFinite(minimum)
      ? Math.max(0, point.negativeLogLikelihood - minimum)
      : Number.NaN);
    const points = evaluated.map((point) => {
      const delta = deltaOf(point);
      return {
        value: point.value,
        sumSquaredError: point.sumSquaredError,
        negativeLogLikelihood: point.negativeLogLikelihood,
        deltaNegativeLogLikelihood: Number.isFinite(delta) ? delta : null,
        converged: point.converged,
        fitStatus: point.fitStatus,
        terminationReason: point.terminationReason,
      };
    });
    const failures = points.filter((point) => !point.converged || !Number.isFinite(point.deltaNegativeLogLikelihood)).length;
    const allPointsAssessed = fit.converged && failures === 0 && points.length >= 3;
    const leftOpen = allPointsAssessed && points[0].deltaNegativeLogLikelihood <= threshold;
    const rightOpen = allPointsAssessed && points.at(-1).deltaNegativeLogLikelihood <= threshold;
    const status = !allPointsAssessed ? "NOT_ASSESSED"
      : leftOpen && rightOpen ? "NOT_IDENTIFIABLE"
        : leftOpen ? "lower-unidentified"
          : rightOpen ? "upper-unidentified" : "identified";
    const reason = !fit.converged ? "main_fit_not_converged"
      : failures ? "profile_refit_nonconvergence_or_invalid_objective"
        : points.length < 3 ? "insufficient_profile_points" : null;

    const refineSide = async (direction) => {
      const bracket = profileCrossingBracket(evaluated, deltaOf, threshold, direction);
      if (!bracket) return null;
      const refinement = await refineThresholdCrossing({
        evaluate: async (value) => {
          refinementIndex += 1;
          const point = await evaluateAt(targetName, value, `refine-${direction}-${refinementIndex}`);
          completed += 1;
          report();
          return { delta: point.converged ? deltaOf(point) : Number.NaN };
        },
        inner: bracket.inner.value,
        outer: bracket.outer.value,
        innerDelta: deltaOf(bracket.inner),
        outerDelta: deltaOf(bracket.outer),
        threshold,
        relativeTolerance,
        maxIterations,
      });
      return refinement;
    };

    let lowerCrossing = allPointsAssessed && !leftOpen ? profileCrossing(points, threshold, "lower") : null;
    let upperCrossing = allPointsAssessed && !rightOpen ? profileCrossing(points, threshold, "upper") : null;
    let lowerRefinement = null;
    let upperRefinement = null;
    if (refinementEnabled && allPointsAssessed) {
      if (lowerCrossing !== null) {
        lowerRefinement = await refineSide("lower");
        if (lowerRefinement?.converged) lowerCrossing = lowerRefinement.value;
      }
      if (upperCrossing !== null) {
        upperRefinement = await refineSide("upper");
        if (upperRefinement?.converged) upperCrossing = upperRefinement.value;
      }
    }

    const rootRefinement = refinementEnabled ? {
      enabled: true,
      method: "bracket_bisection_linear_interpolation",
      maxIterations,
      relativeTolerance,
      evaluations: (lowerRefinement?.evaluations ?? 0) + (upperRefinement?.evaluations ?? 0),
      lower: lowerRefinement,
      upper: upperRefinement,
    } : { enabled: false };

    profileTargets[targetName] = {
      status: allPointsAssessed ? "ASSESSED" : "NOT_ASSESSED",
      ...(reason ? { reason } : {}),
      method,
      profilePointCount: points.length,
      convergedPointCount: points.length - failures,
      nonConvergedPointCount: failures,
      profileMinimumNegativeLogLikelihood: minimum,
      likelihoodRatioThreshold95: threshold,
      profileCompatibleRange95: { lower: lowerCrossing, upper: upperCrossing },
      rootRefinement,
      identifiability: {
        status,
        trend: allPointsAssessed ? status === "identified" ? "bounded_profile_support" : status === "NOT_IDENTIFIABLE" ? "profile_support_spans_parameter_bounds" : `profile_open_at_${status === "lower-unidentified" ? "lower" : "upper"}_bound` : "profile_not_assessed",
        reason,
        criterion: "95% profile-likelihood support under a homoscedastic Gaussian residual model with residual scale profiled analytically; all other biological and OD nuisance parameters are reoptimized",
        oneSided95Bound: status === "lower-unidentified" ? upperCrossing
          : status === "upper-unidentified" ? lowerCrossing : null,
        likelihoodRatioThreshold95: threshold,
      },
      points,
    };

    if (ar1Enabled && dependence) {
      const ar1Usable = evaluated.filter((point) => Number.isFinite(point.ar1NegativeLogLikelihood));
      const estimatePoint = evaluated.find((point) => Math.abs(point.value - fit.fittedParameters[targetName])
        <= 1e-12 * Math.max(1, Math.abs(point.value)));
      // The AR(1) working likelihood is evaluated at IID-refit nuisance values, so
      // its own minimum is not a stable reference. Anchor the ratio at the IID
      // estimate instead: every reported interval is then grid-independent and
      // explicitly conditional on that estimate.
      const ar1Minimum = Number.isFinite(estimatePoint?.ar1NegativeLogLikelihood)
        ? estimatePoint.ar1NegativeLogLikelihood
        : ar1Usable.length ? Math.min(...ar1Usable.map((point) => point.ar1NegativeLogLikelihood)) : null;
      const ar1DeltaOf = (point) => (Number.isFinite(point.ar1NegativeLogLikelihood) && Number.isFinite(ar1Minimum)
        ? Math.max(0, point.ar1NegativeLogLikelihood - ar1Minimum)
        : Number.NaN);
      const ar1Points = evaluated.map((point) => {
        const delta = ar1DeltaOf(point);
        return {
          value: point.value,
          negativeLogLikelihood: point.ar1NegativeLogLikelihood,
          deltaNegativeLogLikelihood: Number.isFinite(delta) ? delta : null,
          converged: point.converged,
        };
      });
      const ar1Failures = ar1Points.filter((point) => !point.converged
        || !Number.isFinite(point.deltaNegativeLogLikelihood)).length;
      const ar1Assessed = fit.converged && ar1Failures === 0 && ar1Points.length >= 3;
      const ar1LeftOpen = ar1Assessed && ar1Points[0].deltaNegativeLogLikelihood <= threshold;
      const ar1RightOpen = ar1Assessed && ar1Points.at(-1).deltaNegativeLogLikelihood <= threshold;
      const ar1IdentifiabilityStatus = !ar1Assessed ? "NOT_ASSESSED"
        : ar1LeftOpen && ar1RightOpen ? "NOT_IDENTIFIABLE"
          : ar1LeftOpen ? "lower-unidentified"
            : ar1RightOpen ? "upper-unidentified" : "identified";
      const ar1Reason = !ar1Assessed ? "ar1_profile_refit_nonconvergence_or_invalid_objective" : null;

      const refineAr1Side = async (direction) => {
        const bracket = profileCrossingBracket(evaluated, ar1DeltaOf, threshold, direction);
        if (!bracket) return null;
        return refineThresholdCrossing({
          evaluate: async (value) => {
            refinementIndex += 1;
            const point = await evaluateAt(targetName, value, `ar1-refine-${direction}-${refinementIndex}`);
            completed += 1;
            report();
            return { delta: point.converged ? ar1DeltaOf(point) : Number.NaN };
          },
          inner: bracket.inner.value,
          outer: bracket.outer.value,
          innerDelta: ar1DeltaOf(bracket.inner),
          outerDelta: ar1DeltaOf(bracket.outer),
          threshold,
          relativeTolerance,
          maxIterations,
        });
      };

      let ar1Lower = ar1Assessed && !ar1LeftOpen ? profileCrossing(ar1Points, threshold, "lower") : null;
      let ar1Upper = ar1Assessed && !ar1RightOpen ? profileCrossing(ar1Points, threshold, "upper") : null;
      let ar1LowerRefinement = null;
      let ar1UpperRefinement = null;
      if (refinementEnabled && ar1Assessed) {
        if (ar1Lower !== null) {
          ar1LowerRefinement = await refineAr1Side("lower");
          if (ar1LowerRefinement?.converged) ar1Lower = ar1LowerRefinement.value;
        }
        if (ar1Upper !== null) {
          ar1UpperRefinement = await refineAr1Side("upper");
          if (ar1UpperRefinement?.converged) ar1Upper = ar1UpperRefinement.value;
        }
      }

      ar1Parameters[targetName] = {
        status: ar1Assessed ? "ASSESSED" : "NOT_ASSESSED",
        ...(ar1Reason ? { reason: ar1Reason } : {}),
        method: ar1Method,
        profilePointCount: ar1Points.length,
        convergedPointCount: ar1Points.length - ar1Failures,
        nonConvergedPointCount: ar1Failures,
        profileMinimumNegativeLogLikelihood: ar1Minimum,
        likelihoodRatioThreshold95: threshold,
        profileCompatibleRange95: { lower: ar1Lower, upper: ar1Upper },
        rootRefinement: refinementEnabled ? {
          enabled: true,
          method: "bracket_bisection_linear_interpolation",
          maxIterations,
          relativeTolerance,
          evaluations: (ar1LowerRefinement?.evaluations ?? 0) + (ar1UpperRefinement?.evaluations ?? 0),
          lower: ar1LowerRefinement,
          upper: ar1UpperRefinement,
        } : { enabled: false },
        identifiability: {
          status: ar1IdentifiabilityStatus,
          trend: ar1Assessed ? ar1IdentifiabilityStatus === "identified"
            ? "bounded_profile_support"
            : ar1IdentifiabilityStatus === "NOT_IDENTIFIABLE"
              ? "profile_support_spans_parameter_bounds"
              : `profile_open_at_${ar1IdentifiabilityStatus === "lower-unidentified" ? "lower" : "upper"}_bound`
            : "profile_not_assessed",
          reason: ar1Reason,
          criterion: "95% profile-likelihood support under a block-diagonal random-intercept AR(1) working covariance with residual scale profiled analytically; phi and lambda are fixed at their training-residual moment estimates, nuisance parameters are reoptimized under the IID least-squares criterion, and the likelihood ratio is anchored at the IID estimate, so this is a sensitivity interval rather than a joint AR(1) refit",
          oneSided95Bound: ar1IdentifiabilityStatus === "lower-unidentified" ? ar1Upper
            : ar1IdentifiabilityStatus === "upper-unidentified" ? ar1Lower : null,
          likelihoodRatioThreshold95: threshold,
        },
        points: ar1Points,
      };
      if (!ar1Assessed) {
        ar1Status = "NOT_ASSESSED";
        ar1Reason = "one_or_more_ar1_profile_refits_or_the_main_fit_did_not_converge";
      }
    } else if (ar1Enabled && !dependence) {
      ar1Parameters[targetName] = {
        status: "NOT_ASSESSED",
        reason: dependenceFailure,
        method: ar1Method,
        profileCompatibleRange95: { lower: null, upper: null },
        points: [],
      };
    }
  }

  total = completed;
  report();

  const status = Object.values(profileTargets).every((profile) => profile.status === "ASSESSED") ? "ASSESSED" : "NOT_ASSESSED";
  return {
    status,
    method,
    reason: status === "NOT_ASSESSED" ? "one_or_more_profile_refits_or_the_main_fit_did_not_converge" : null,
    pointCount: config.profileLikelihoodPoints,
    likelihoodRatioThreshold95: threshold,
    rootRefinement: {
      enabled: refinementEnabled,
      method: "bracket_bisection_linear_interpolation",
      maxIterations,
      relativeTolerance,
    },
    profileRefitEvaluationCount: refitEvaluationCount,
    parameters: profileTargets,
    ...(ar1Enabled ? {
      errorModel: "both",
      residualDependence: dependence,
      ar1RandomIntercept: {
        status: ar1Status,
        role: "sensitivity_analysis",
        method: ar1Method,
        reason: ar1Reason,
        likelihoodRatioThreshold95: threshold,
        residualDependence: dependence,
        nuisanceReoptimization: "iid_least_squares",
        reference: "iid_estimate",
        parameters: ar1Parameters,
      },
      primaryInterval: "iid_profile",
      sensitivityInterval: ar1Status === "ASSESSED" ? "random_intercept_ar1" : null,
    } : { errorModel: "iid" }),
  };
}

function trainingBaseline(trainingObservations, validationObservations, sourceTimes, trainingUnitIds) {
  const byTime = new Map(sourceTimes.map((time) => [canonicalTimeKey(time), []]));
  for (const observation of trainingObservations) {
    byTime.get(canonicalTimeKey(observation.timeHours)).push(observation.value);
  }
  const meanOdByTime = sourceTimes.map((timeHours) => {
    const values = byTime.get(canonicalTimeKey(timeHours));
    if (values.length !== trainingUnitIds.length) {
      fail(
        "INCOMPLETE_TRAINING_BASELINE",
        `Training baseline time ${timeHours} h does not have one value per training unit.`,
      );
    }
    return {
      timeHours,
      meanOd: values.reduce((sum, value) => sum + value, 0) / values.length,
      trainingUnitCount: values.length,
    };
  });
  const lookup = new Map(meanOdByTime.map((entry) => [canonicalTimeKey(entry.timeHours), entry.meanOd]));
  const predictions = validationObservations.map((observation) => {
    const value = lookup.get(canonicalTimeKey(observation.timeHours));
    if (value === undefined) {
      fail("VALIDATION_BASELINE_TIME_MISSING", "A validation source time was absent from the training-only baseline.");
    }
    return value;
  });
  return {
    id: "training-unit-mean-od-by-exact-source-time",
    predeclared: true,
    method: "Arithmetic mean OD600 across complete training independent units at each exact source time; no interpolation and no validation values.",
    sourceRole: "training",
    trainingIndependentUnitIds: [...trainingUnitIds],
    exactSourceTimes: [...sourceTimes],
    meanOdByTime,
    predictions,
  };
}

function linspace(lower, upper, count) {
  return Array.from({ length: count }, (_, index) =>
    lower + (index / (count - 1)) * (upper - lower));
}

function exploratoryDistributions(parameterSpace, fittedParameters, fraction) {
  return Object.fromEntries(parameterSpace.parameters.map((definition) => {
    const span = definition.upper - definition.lower;
    const mode = fittedParameters[definition.name];
    let minimum = Math.max(definition.lower, mode - fraction * span);
    let maximum = Math.min(definition.upper, mode + fraction * span);
    if (!(minimum < maximum)) {
      minimum = definition.lower;
      maximum = definition.upper;
    }
    return [definition.name, { type: "triangular", minimum, mode, maximum }];
  }));
}

function compactOptimization(optimization, failureLimit = 100) {
  return {
    optimizer: optimization.optimizer,
    randomAlgorithm: optimization.randomAlgorithm,
    seed: optimization.seed,
    bounds: optimization.bounds,
    evaluationCount: optimization.evaluationCount,
    terminationReason: optimization.terminationReason,
    converged: optimization.converged,
    failureCount: optimization.failedCandidates.length,
    failuresTruncated: optimization.failedCandidates.length > failureLimit,
    failedCandidates: optimization.failedCandidates.slice(0, failureLimit),
    restarts: optimization.restarts.map((restart) => ({
      restart: restart.restart,
      seed: restart.seed,
      bestParameters: restart.bestParameters,
      bestValue: restart.bestValue,
      evaluationCount: restart.evaluationCount,
      terminationReason: restart.terminationReason,
      converged: restart.converged,
      differentialEvolution: {
        evaluationCount: restart.differentialEvolution.evaluationCount,
        generations: restart.differentialEvolution.generations,
        terminationReason: restart.differentialEvolution.terminationReason,
        converged: restart.differentialEvolution.converged,
      },
      nelderMead: {
        evaluationCount: restart.nelderMead.evaluationCount,
        iterations: restart.nelderMead.iterations,
        terminationReason: restart.nelderMead.terminationReason,
        converged: restart.nelderMead.converged,
      },
    })),
  };
}

function residualSummary(residuals) {
  const values = residuals.filter((entry) => entry.kind === "point").map(({ residual }) => residual);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    convention: "observed - predicted",
    count: values.length,
    mean,
    rootMeanSquare: Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length),
    minimum: Math.min(...values),
    maximum: Math.max(...values),
  };
}

export function researchWorkflowConfiguration(options) {
  const optimizer = options.optimizer ?? {};
  record(optimizer, "optimizer");
  const populationSize = integerOption(
    optimizer.populationSize ?? options.populationSize,
    12,
    "optimizer.populationSize",
    4,
    128,
  );
  const differentialEvolutionMaxEvaluations = integerOption(
    optimizer.differentialEvolutionMaxEvaluations ?? options.differentialEvolutionMaxEvaluations,
    300,
    "optimizer.differentialEvolutionMaxEvaluations",
    populationSize,
    ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumDifferentialEvolutionEvaluations,
  );
  return {
    optimizerRestarts: integerOption(
      optimizer.restarts ?? options.optimizerRestarts,
      1,
      "optimizer.restarts",
      1,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumOptimizerRestarts,
    ),
    populationSize,
    differentialEvolutionMaxEvaluations,
    nelderMeadMaxEvaluations: integerOption(
      optimizer.nelderMeadMaxEvaluations ?? options.nelderMeadMaxEvaluations,
      200,
      "optimizer.nelderMeadMaxEvaluations",
      3,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumNelderMeadEvaluations,
    ),
    scanPointsPerAxis: integerOption(
      options.scanPointsPerAxis,
      5,
      "scanPointsPerAxis",
      3,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumScanPointsPerAxis,
    ),
    monteCarloSamples: integerOption(
      options.monteCarloSamples,
      128,
      "monteCarloSamples",
      4,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumMonteCarloSamples,
    ),
    morrisTrajectories: integerOption(
      options.morrisTrajectories,
      8,
      "morrisTrajectories",
      1,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumMorrisTrajectories,
    ),
    morrisLevels: integerOption(options.morrisLevels, 4, "morrisLevels", 2, 20),
    sobolSamples: integerOption(
      options.sobolSamples,
      64,
      "sobolSamples",
      2,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumSobolSamples,
    ),
    identifiabilityProfilePoints: integerOption(
      options.identifiabilityProfilePoints,
      5,
      "identifiabilityProfilePoints",
      3,
      11,
    ),
    profileLikelihoodPoints: integerOption(
      options.profileLikelihoodPoints,
      5,
      "profileLikelihoodPoints",
      5,
      11,
    ),
    profileRootRefinement: booleanOption(
      options.profileRootRefinement,
      false,
      "profileRootRefinement",
    ),
    profileRootRefinementMaxIterations: integerOption(
      options.profileRootRefinementMaxIterations,
      8,
      "profileRootRefinementMaxIterations",
      1,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumProfileRootRefinementIterations,
    ),
    profileRootRefinementRelativeTolerance: (() => {
      const value = finite(options.profileRootRefinementRelativeTolerance ?? 1e-6, "profileRootRefinementRelativeTolerance");
      if (!(value > 0 && value < 1)) {
        fail(
          "INVALID_WORKFLOW_OPTION",
          "profileRootRefinementRelativeTolerance must lie strictly between 0 and 1.",
          "profileRootRefinementRelativeTolerance",
          value,
        );
      }
      return value;
    })(),
    profileErrorModel: enumOption(
      options.profileErrorModel,
      "iid",
      "profileErrorModel",
      ["iid", "both"],
    ),
    sobolBootstrapReplicates: integerOption(options.sobolBootstrapReplicates, 200, "sobolBootstrapReplicates", 0, 2000),
    sobolConfidenceLevel: finite(options.sobolConfidenceLevel ?? 0.95, "sobolConfidenceLevel"),
    sobolPrecisionTolerance: finite(options.sobolPrecisionTolerance ?? 0.2, "sobolPrecisionTolerance"),
    returnedMonteCarloSamples: integerOption(
      options.returnedMonteCarloSamples,
      32,
      "returnedMonteCarloSamples",
      1,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumReturnedMonteCarloSamples,
    ),
  };
}

/** Fixed numerical rules for this implementation, recorded verbatim for replay. */
export function researchWorkflowComputationSettings(options) {
  const config = researchWorkflowConfiguration(options);
  const space = parameterSpaceFor(assertSupportedResolvedModel(options.resolvedModel));
  return {
    scalarOutputTimeHours: SCALAR_OUTPUT_TIME_HOURS,
    training: {
      method: "least_squares", parameterPolicy: "scientific",
      parameterWhitelist: [...PARAMETER_NAMES], bounds: boundsFromSpace(space),
      initialParameters: initialParameters(options.resolvedModel, space),
      initialStateSeriesIds: ["pooled"], drugIds: [],
    },
    observationLayer: { minimumScaleOd: 1e-12, profilingRole: "training" },
    differentialEvolution: { mutationFactor: 0.8, crossoverRate: 0.9, tolerance: 1e-7, objectiveTolerance: 1e-10 },
    nelderMead: { initialStep: 0.05, tolerance: 1e-8, objectiveTolerance: 1e-12 },
    profileLikelihood: {
      method: "profile_likelihood_gaussian_ssr_sigma_profiled",
      points: config.profileLikelihoodPoints,
      likelihoodRatioThreshold95: 1.920729410347062,
      nuisanceParametersReoptimized: ["baselineOd", "scaleOd"],
      otherBiologicalParametersReoptimized: true,
      errorScaleProfiledAnalytically: true,
      rootRefinement: {
        enabled: config.profileRootRefinement,
        method: "bracket_bisection_linear_interpolation",
        maxIterations: config.profileRootRefinementMaxIterations,
        relativeTolerance: config.profileRootRefinementRelativeTolerance,
      },
      errorModel: config.profileErrorModel,
      residualDependence: {
        method: "random_intercept_ar1_within_curve",
        phiEstimation: "pooled_lag_one_moment",
        varianceComponents: "balanced_method_of_moments",
        requiresEqualSpacing: true,
        nuisanceReoptimization: "iid_least_squares",
      },
    },
    identifiability: {
      relativeStep: 1e-4, rankTolerance: 1e-8, boundaryTolerance: 0.01,
      conditionWarning: 1e6, correlationWarning: 0.95,
      nearOptimumRelativeTolerance: 1e-4, nearOptimumAbsoluteTolerance: 1e-8,
      nearOptimumParameterSeparation: 1e-3,
      objectiveSlices: { points: config.identifiabilityProfilePoints, maxParameters: 2, flatRelativeTolerance: 1e-4 },
    },
    localSensitivity: {
      scheme: "auto", spanRelativeStep: 1e-5, roundoffRelativeStep: Math.sqrt(Number.EPSILON),
      stepRule: "min(span, max(span * spanRelativeStep, roundoffRelativeStep * max(1, abs(transformedCenter))))",
    },
    morris: { delta: config.morrisLevels % 2 === 0 ? config.morrisLevels / (2 * (config.morrisLevels - 1)) : 1 / (config.morrisLevels - 1) },
    monteCarlo: { quantileProbabilities: [0.025, 0.5, 0.975], propagateObservationError: false },
    sobol: { independentInputs: true, minimumTailSamples: 5, quantileMethod: "R7" },
  };
}

function reproducibilityMetadata(options, datasetInput) {
  const fields = ["applicationVersion", "runId", "createdAt", "datasetVersion", "contentHash"];
  const supplied = fields.filter((field) => options[field] !== undefined);
  if (supplied.length > 0 && supplied.length !== fields.length) {
    fail(
      "INCOMPLETE_REPRODUCIBILITY_METADATA",
      `Supply all or none of: ${fields.join(", ")}.`,
      "options",
      supplied,
    );
  }
  if (supplied.length === 0) return null;
  for (const field of fields.slice(0, 4)) nonEmptyString(options[field], field);
  nonEmptyString(options.contentHash, "contentHash");
  if (!HASH_PATTERN.test(options.contentHash)) {
    fail("INVALID_CONTENT_HASH", "contentHash must be a lowercase SHA-256 hex digest.", "contentHash", options.contentHash);
  }
  const computedContentHash = typeof datasetInput === "string" ? sha256HexFallback(datasetInput) : null;
  if (computedContentHash !== null && computedContentHash !== options.contentHash) {
    fail(
      "CONTENT_HASH_MISMATCH",
      "The supplied contentHash does not match the imported source text.",
      "contentHash",
      options.contentHash,
    );
  }
  return {
    applicationVersion: options.applicationVersion,
    runId: options.runId,
    createdAt: options.createdAt,
    datasetVersion: options.datasetVersion,
    contentHash: options.contentHash,
    contentHashVerified: computedContentHash !== null,
  };
}

function allFailures(fit, scan, monteCarlo) {
  return [
    ...fit.optimization.failedCandidates.map((failure) => ({ stage: "optimizer", ...failure })),
    ...scan.results.filter(({ status }) => status === "failed").map((failure) => ({
      stage: "parameter_scan",
      index: failure.index,
      parameters: failure.parameters,
      error: failure.error,
    })),
    ...monteCarlo.failures.map((failure) => ({ stage: "monte_carlo", ...failure })),
  ].slice(0, 200);
}

/**
 * Run the pure, deterministic Stage 4 real-data workflow for the bundled raw
 * OD600 dataset. The caller supplies dataset text/object and a resolved model;
 * this module performs no I/O and has no browser or Node dependencies.
 */
export async function runEcolabStage4ResearchWorkflow(options = {}) {
  record(options, "options");
  const datasetInput = options.datasetInput ?? options.dataset ?? options.datasetJson;
  if (datasetInput === undefined) {
    fail("DATASET_INPUT_REQUIRED", "datasetInput, dataset, or datasetJson is required.", "datasetInput");
  }
  const resolvedModel = options.resolvedModel;
  const carryingCapacity = assertSupportedResolvedModel(resolvedModel);
  const seed = uint32(options.seed ?? 0x5e4c0ab1, "seed");
  const config = researchWorkflowConfiguration(options);
  const computation = researchWorkflowComputationSettings(options);
  if (config.sobolBootstrapReplicates === 1 || !(config.sobolConfidenceLevel > 0 && config.sobolConfidenceLevel < 1) || !(config.sobolPrecisionTolerance > 0)) {
    fail("INVALID_SOBOL_BOOTSTRAP_OPTIONS", "Sobol bootstrap requires 0 or >=2 replicates, confidence level in (0,1), and positive precision tolerance.");
  }
  if (options.developmentComparison !== undefined && typeof options.developmentComparison !== "boolean") fail("INVALID_DEVELOPMENT_COMPARISON", "developmentComparison must be boolean.");
  const developmentComparison = options.developmentComparison === true;
  const runtime = researchWorkflowRuntime(options);
  const progress = runtime.progress;
  runtime.check();
  const metadata = reproducibilityMetadata(options, datasetInput);
  const sourceArtifactSha256 = typeof datasetInput === "string"
    ? sha256HexFallback(datasetInput)
    : metadata?.contentHash ?? null;
  const seeds = {
    analysis: seed,
    optimizer: deriveSeed(seed, "optimizer"),
    monteCarlo: deriveSeed(seed, "monte-carlo"),
    morris: deriveSeed(seed, "morris"),
    sobol: deriveSeed(seed, "sobol"),
    sobolBootstrap: uint32(options.sobolBootstrapSeed ?? deriveSeed(deriveSeed(seed, "sobol"), "sobol", "bootstrap"), "sobolBootstrapSeed"),
  };

  emit(progress, "dataset_import", 0, 1);
  const imported = importObservationDataset(datasetInput, { format: options.datasetFormat ?? "auto" });
  const dataset = imported.dataset;
  emit(progress, "dataset_import", 1, 1);

  emit(progress, "dataset_qc", 0, 1);
  const datasetFacts = assertScientificDataset(dataset);
  const quality = assessDatasetQuality(dataset, {
    keyConditionFields: ["organism", "strain", "medium", "temperatureC"],
  });
  if (!quality.valid) {
    fail("DATASET_QUALITY_FAILED", "Dataset quality checks reported errors.", "dataset", quality.errors);
  }
  const datasetFingerprint = await fingerprintJson(dataset);
  emit(progress, "dataset_qc", 1, 1);

  emit(progress, "dataset_split", 0, 1);
  const split = await createDatasetSplit(dataset, {
    sourceDatasetFingerprint: datasetFingerprint,
    strategy: developmentComparison
      ? "declared_training_and_previously_viewed_development_using_legacy_validation_ids"
      : "declared_training_validation_roles_by_complete_independent_unit",
    lockedValidation: !developmentComparison,
  });
  const trainingObservations = dataset.observations.filter(({ role }) => role === "training");
  const validationObservations = dataset.observations.filter(({ role }) => role === "validation");
  const trainingUnitIds = split.roles.training.independentUnitIds;
  const validationUnitIds = split.roles.validation.independentUnitIds;
  emit(progress, "dataset_split", 1, 1);

  const parameterSpace = parameterSpaceFor(carryingCapacity);
  const bounds = boundsFromSpace(parameterSpace);
  const startingParameters = initialParameters(resolvedModel, parameterSpace);

  await runtime.checkpoint();
  emit(progress, "training_fit", 0, 1);
  const fit = fitParameters({
    observations: trainingObservations,
    parameterPolicy: "scientific",
    parameterWhitelist: [...PARAMETER_NAMES],
    parameterContext: { initialStateSeriesIds: ["pooled"], drugIds: [] },
    bounds,
    initialParameters: startingParameters,
    method: "least_squares",
    seed: seeds.optimizer,
    restarts: config.optimizerRestarts,
    differentialEvolution: {
      ...computation.differentialEvolution,
      populationSize: config.populationSize,
      maxEvaluations: config.differentialEvolutionMaxEvaluations,
    },
    nelderMead: { ...computation.nelderMead, maxEvaluations: config.nelderMeadMaxEvaluations },
    evaluator: (biologicalParameters, observations) =>
      profiledTrainingEvaluation(
        resolvedModel,
        biologicalParameters,
        observations,
        datasetFacts.maximumTimeHours,
      ).predictions,
    observationModel: (profiledOdPrediction) => profiledOdPrediction,
  });
  if (fit.status === "NOT_IDENTIFIABLE") {
    emit(progress, "training_fit", 1, 1);
    const applicationVersion = metadata?.applicationVersion ?? options.applicationVersion ?? "unknown";
    const runId = metadata?.runId ?? options.runId ?? null;
    const statusResult = {
      schemaVersion: "1.0.0",
      kind: "ecolab-stage4-real-data-research-workflow",
      status: "NOT_IDENTIFIABLE",
      dataset: {
        id: dataset.metadata.datasetId,
        observationCount: dataset.observations.length,
        trainingObservationCount: trainingObservations.length,
        exactTrainingObservationCount: fit.fitDiagnostics.identifiability.exactObservationCount,
        validationObservationCount: validationObservations.length,
        normalizedDatasetFingerprint: datasetFingerprint,
        sourceArtifactSha256,
      },
      training: {
        status: fit.status,
        observationCount: trainingObservations.length,
        parameterSetUse: {
          intendedUse: resolvedModel.intendedUse ?? "unspecified",
          researchFitEligible: resolvedModel.researchFitEligible ?? null,
          fittedEstimatesRecomputedFromTrainingDataset: true,
        },
        fittedBiologicalParameters: null,
        objectiveValue: null,
        parameterWhitelist: [...PARAMETER_NAMES],
        fitDiagnostics: {
          ...fit.fitDiagnostics,
          profileLikelihood: {
            status: "NOT_ASSESSED",
            method: "profile_likelihood_gaussian_ssr_sigma_profiled",
            reason: "training_fit_not_identifiable",
            parameters: Object.fromEntries(PARAMETER_NAMES.map((name) => [name, {
              status: "NOT_ASSESSED",
              reason: "training_fit_not_identifiable",
              points: [],
            }])),
          },
        },
      },
      identifiability: fit.fitDiagnostics.identifiability,
      validation: { status: "NOT_RUN", reason: "training_fit_not_identifiable" },
      runMetadata: {
        applicationVersion,
        runId,
        seed,
        seeds: { algorithm: RNG_ALGORITHM, ...seeds },
        settings: {
          preset: options.preset ?? null,
          workflowConfiguration: config,
          computationSettings: computation,
          minimumExactObservations: PARAMETER_NAMES.length + 1,
          baseParameterSetIntendedUse: resolvedModel.intendedUse ?? "unspecified",
          baseParameterSetResearchFitEligible: resolvedModel.researchFitEligible ?? null,
        },
      },
      warnings: [
        "No parameter estimates are reported because the least-squares training fit is not locally identifiable from the exact OD observations.",
        ...(resolvedModel.researchFitEligible === false ? ["The resolved base parameter set is marked for teaching calibration only; its values are not condition-matched research estimates."] : []),
      ],
    };
    emit(progress, "complete", 1, 1);
    return jsonSafe(statusResult);
  }
  const fittedBiologicalParameters = Object.fromEntries(
    PARAMETER_NAMES.map((name) => [name, fit.fittedParameters[name]]),
  );
  const profiledNuisance = profiledTrainingEvaluation(
    resolvedModel,
    fittedBiologicalParameters,
    trainingObservations,
    datasetFacts.maximumTimeHours,
  );
  const trainingMetrics = calculateMetrics({
    observations: trainingObservations,
    predictions: profiledNuisance.predictions,
  });
  emit(progress, "training_fit", 1, 1);

  await runtime.checkpoint();
  emit(progress, "identifiability", 0, 1);
  const identifiabilityRaw = analyzeIdentifiability({
    ...computation.identifiability,
    parameters: fittedBiologicalParameters,
    parameterWhitelist: [...PARAMETER_NAMES],
    bounds,
    observations: trainingObservations,
    evaluator: (biologicalParameters, observations) =>
      profiledTrainingEvaluation(
        resolvedModel,
        biologicalParameters,
        observations,
        datasetFacts.maximumTimeHours,
      ).predictions,
    objective: (biologicalParameters) =>
      profiledTrainingEvaluation(
        resolvedModel,
        biologicalParameters,
        trainingObservations,
        datasetFacts.maximumTimeHours,
      ).sumSquaredErrors,
    optimization: fit.optimization,
  });
  const slices = identifiabilityRaw.objectiveSlices.map((slice) => ({
    ...slice,
    nuisanceParametersOptimized: true,
    otherBiologicalParametersOptimized: false,
    optimizedNuisanceParameters: ["baselineOd", "scaleOd"],
    profileLikelihood: false,
    interpretation: "One biological parameter is scanned with other biological parameters fixed; OD observation-layer nuisance parameters are reoptimized on training data at each point. This is a nuisance-profiled objective slice, not a profile likelihood or confidence interval; endpoints are not confidence limits.",
  }));
  const profileLikelihood = await profileLeastSquaresLikelihood({
    fit,
    observations: trainingObservations,
    resolvedModel,
    maximumTimeHours: datasetFacts.maximumTimeHours,
    bounds,
    config,
    computation,
    seed: seeds.optimizer,
    checkpoint: runtime.checkpoint,
    onProgress: ({ completed, total }) => emit(progress, "profile_likelihood", completed, total),
  });
  const identifiability = jsonSafe({
    ...identifiabilityRaw,
    objectiveSlices: slices,
    profiles: slices,
    profileLikelihoodDiagnostics: profileLikelihood,
  });
  const fitDiagnostics = { ...fit.fitDiagnostics, profileLikelihood };
  emit(progress, "identifiability", 1, 1);

  await runtime.checkpoint();
  emit(progress, developmentComparison ? "freeze_development_plan" : "lock_validation_plan", 0, 1);
  const baseline = trainingBaseline(
    trainingObservations,
    validationObservations,
    datasetFacts.sourceTimes,
    trainingUnitIds,
  );
  const lockedPlan = await lockAnalysisPlan({
    schemaVersion: "1.0.0",
    kind: "analysis-plan",
    id: options.planId ?? `${DATASET_ID}-stage4-od-logistic-plan-v1`,
    analysisKind: developmentComparison
      ? "training_profiled_od600_logistic_fit_and_development_comparison"
      : "training_profiled_od600_logistic_fit_and_locked_validation",
    datasetFingerprint,
    splitFingerprint: split.splitFingerprint,
    modelRef: { id: resolvedModel.ref.id, version: resolvedModel.ref.version },
    baseParameterSetRef: {
      id: resolvedModel.ref.parameterSetId,
      version: resolvedModel.ref.parameterSetVersion,
    },
    parameterSpace,
    randomAlgorithm: RNG_ALGORITHM,
    seeds,
    lockedValidation: false,
    parameters: fittedBiologicalParameters,
    errorModel: {
      kind: "profiled_od600_observation_layer_locked_from_training",
      equation: OD_OBSERVATION_MODEL_EQUATION,
      baselineOd: profiledNuisance.baselineOd,
      scaleOd: profiledNuisance.scaleOd,
      profiledOnRole: "training",
      profiledObservationCount: trainingObservations.length,
      reprofileDuringValidation: false,
      sourceOdValuesModified: false,
    },
    exclusions: [],
    metrics: [
      "macro_rmse",
      "pooled_rmse",
      "mae",
      "mean_residual",
      "median_absolute_error",
      "per_unit",
    ],
    validationIndependentUnitIds: validationUnitIds,
    baseline,
    notes: {
      ...(developmentComparison ? {
        evaluationRole: "development_comparison", sourceObservationRole: "validation",
        previouslyViewed: true, untouched: false, eligibleAsValidationEvidence: false,
        lockSemantics: "lockedValidation is the legacy schema flag for frozen parameters/settings only; it does not assert untouched evidence.",
      } : {}),
      latentModel: "No-drug piecewise-analytic logistic population model with fixed carrying capacity from the resolved model.",
      sampleAlignment: "Exact source times only; model time 0 is an initial state and is not a source observation.",
      carryingCapacityLog10CfuPerMl: carryingCapacity,
      nuisanceParameters: "baselineOd and scaleOd are observation-layer nuisance parameters profiled on training observations and fixed before validation.",
      treatmentInference: "No treatment or antibiotic parameter is inferred.",
    },
  });
  emit(progress, developmentComparison ? "freeze_development_plan" : "lock_validation_plan", 1, 1);

  await runtime.checkpoint();
  emit(progress, developmentComparison ? "development_comparison" : "locked_validation", 0, 1);
  let validationEvaluatorCalls = 0;
  const validation = validateLockedPlan({
    plan: lockedPlan,
    observations: validationObservations,
    dataset,
    split,
    trainingIndependentUnitIds: trainingUnitIds,
    evidenceQualification: {
      independentUnitsDocumented: false,
      eligibleAsValidationEvidence: false,
    },
    evaluator: (biologicalParameters, observations) => {
      validationEvaluatorCalls += 1;
      return predictionsAtObservations(
        resolvedModel,
        biologicalParameters,
        observations,
        datasetFacts.maximumTimeHours,
        {
          baselineOd: lockedPlan.errorModel.baselineOd,
          scaleOd: lockedPlan.errorModel.scaleOd,
        },
      );
    },
  });
  if (developmentComparison) Object.assign(validation, {
    role: "development_comparison", evidenceStatus: "previously_viewed_development_comparison",
    untouched: false, previouslyViewed: true, observationRoleUsed: "validation",
    eligibleAsValidationEvidence: false,
    lockSemantics: "Parameters and observation-layer settings frozen from training; not an untouched holdout.",
  });
  emit(progress, developmentComparison ? "development_comparison" : "locked_validation", 1, 1);

  const scalarEvaluator = (biologicalParameters) => {
    const [fraction] = simulateLatentFractions(
      resolvedModel,
      biologicalParameters,
      [SCALAR_OUTPUT_TIME_HOURS],
      datasetFacts.maximumTimeHours,
    );
    return applyOdObservationLayer(fraction, {
      baselineOd: lockedPlan.errorModel.baselineOd,
      scaleOd: lockedPlan.errorModel.scaleOd,
    });
  };

  await runtime.checkpoint();
  emit(progress, "parameter_scan", 0, config.scanPointsPerAxis ** 2);
  const scanValues = Object.fromEntries(parameterSpace.parameters.map((definition) => [
    definition.name,
    linspace(definition.lower, definition.upper, config.scanPointsPerAxis),
  ]));
  const parameterScan = runParameterScan({
    method: "cartesian",
    parameterSpace,
    values: scanValues,
    evaluator: scalarEvaluator,
    onProgress: ({ completed, total }) => emit(progress, "parameter_scan", completed, total),
  });

  const uncertaintyFraction = finite(options.uncertaintyRangeFraction ?? 0.1, "uncertaintyRangeFraction");
  if (!(uncertaintyFraction > 0 && uncertaintyFraction <= 0.5)) {
    fail("INVALID_UNCERTAINTY_RANGE", "uncertaintyRangeFraction must be within (0, 0.5].");
  }
  const distributions = exploratoryDistributions(
    parameterSpace,
    fittedBiologicalParameters,
    uncertaintyFraction,
  );

  await runtime.checkpoint();
  emit(progress, "monte_carlo", 0, config.monteCarloSamples);
  const monteCarloRaw = runMonteCarlo({
    ...computation.monteCarlo,
    sampleCount: config.monteCarloSamples,
    seed: seeds.monteCarlo,
    parameterDistributions: distributions,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
    onProgress: ({ completed, total }) => emit(progress, "monte_carlo", completed, total),
  });
  const monteCarlo = {
    kind: monteCarloRaw.kind,
    intervalName: monteCarloRaw.intervalName,
    intervalType: monteCarloRaw.intervalType,
    interpretation: "Exploratory parameter-uncertainty simulation interval; these triangular ranges are not confidence intervals.",
    seed: monteCarloRaw.seed,
    randomAlgorithm: monteCarloRaw.randomAlgorithm,
    sampleCount: monteCarloRaw.sampleCount,
    successCount: monteCarloRaw.successCount,
    failureCount: monteCarloRaw.failureCount,
    failureFraction: monteCarloRaw.failureFraction,
    parameterDistributions: monteCarloRaw.parameterDistributions,
    outputNames: monteCarloRaw.outputNames,
    summaries: monteCarloRaw.summaries,
    warnings: monteCarloRaw.warnings,
    failures: monteCarloRaw.failures,
    ...(options.includeMonteCarloSamples === true
      ? { samples: monteCarloRaw.results.slice(0, config.returnedMonteCarloSamples) }
      : {}),
  };

  await runtime.checkpoint();
  emit(progress, "local_sensitivity", 0, 1);
  const local = localSensitivity({
    scheme: computation.localSensitivity.scheme,
    stepIsRelative: false,
    steps: Object.fromEntries(parameterSpace.parameters.map(({ name, lower, upper }) => [name,
      Math.max((upper - lower) * computation.localSensitivity.spanRelativeStep,
        computation.localSensitivity.roundoffRelativeStep * Math.max(1, Math.abs(fittedBiologicalParameters[name]))),
    ])),
    parameterSpace,
    baseline: fittedBiologicalParameters,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
  });
  emit(progress, "local_sensitivity", 1, 1);

  await runtime.checkpoint();
  emit(progress, "morris_sensitivity", 0, 1);
  const morris = morrisSensitivity({
    parameterSpace,
    trajectories: config.morrisTrajectories,
    levels: config.morrisLevels,
    delta: computation.morris.delta,
    seed: seeds.morris,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
  });
  emit(progress, "morris_sensitivity", 1, 1);

  await runtime.checkpoint();
  emit(progress, "sobol_sensitivity", 0, 1);
  const sobol = sobolJansenSensitivity({
    parameterDistributions: distributions,
    sampleCount: config.sobolSamples,
    seed: seeds.sobol,
    bootstrapReplicates: config.sobolBootstrapReplicates,
    bootstrapSeed: seeds.sobolBootstrap,
    confidenceLevel: config.sobolConfidenceLevel,
    precisionTolerance: config.sobolPrecisionTolerance,
    independentInputs: computation.sobol.independentInputs,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
  });
  emit(progress, "sobol_sensitivity", 1, 1);

  const warnings = [
    {
      code: "OD600_NOT_CFU",
      severity: "warning",
      message: "OD600 is an optical-density measurement and is not CFU/mL; no numeric equivalence with CFU/mL is claimed."
    },
    {
      code: "RAW_OD_ABSOLUTE_SCALE_NOT_IDENTIFIED",
      severity: "warning",
      message: "Raw OD600 does not identify an absolute CFU scale or the carrying capacity."
    },
    {
      code: "CARRYING_CAPACITY_FIXED",
      severity: "warning",
      message: "Carrying capacity is fixed from the resolved model and is not estimated from raw OD600.",
      carryingCapacityLog10CfuPerMl: carryingCapacity,
    },
    {
      code: "OD_OBSERVATION_NUISANCE_PARAMETERS",
      severity: "info",
      message: "baselineOd and scaleOd are observation-layer nuisance parameters; they map latent N/K to OD600 and do not alter source measurements.",
    },
    {
      code: "NO_TREATMENT_INFERENCE",
      severity: "info",
      message: "The protocol is constant no-drug exposure and no treatment or antibiotic parameter is inferred.",
    },
      ...(resolvedModel.researchFitEligible === false ? [{
        code: "TEACHING_PARAMETER_SET_ONLY",
        severity: "warning",
        message: "The resolved base parameter set is marked for teaching calibration only. Fitted values in this result are re-estimated from the declared training dataset; the transferred base values are not condition-matched research estimates.",
      }] : []),
    ...(profileLikelihood.status === "NOT_ASSESSED" ? [{
      code: "PROFILE_LIKELIHOOD_NOT_ASSESSED",
      severity: "warning",
      message: "One or more profile refits did not converge; their likelihood-based identifiability status is NOT_ASSESSED.",
    }] : []),
    {
      code: "EXPLORATORY_PARAMETER_INTERVALS",
      severity: "warning",
      message: "Monte Carlo triangular ranges are exploratory parameter-uncertainty simulation inputs, not confidence intervals.",
    },
    {
      code: "INDEPENDENT_UNIT_DOCUMENTATION_INCOMPLETE",
      severity: "warning",
      message: developmentComparison
        ? "Previously viewed development curves are not untouched validation; source plate/well independence is incompletely documented and this evidence is not eligible for L4."
        : "Held-out validation was locked and leakage-free, but source plate/well independence is incompletely documented; this evidence is not eligible for L4.",
      independentUnitsDocumented: false,
    },
  ];
  if (metadata && datasetFingerprint !== metadata.contentHash) {
    warnings.push({
      code: "SOURCE_AND_NORMALIZED_HASHES_DISTINCT",
      severity: "info",
      message: "The normalized JSON artifact byte hash and normalized canonical dataset fingerprint are recorded separately; original workbook hashes are separate provenance records.",
      sourceArtifactSha256: metadata.contentHash,
      normalizedDatasetFingerprint: datasetFingerprint,
    });
  }

  await runtime.checkpoint();
  emit(progress, "capability", 0, 1);
  const capability = assessCapability({
    runId: metadata?.runId ?? null,
    assumptions: [
      "The resolved no-drug analytic logistic scientific core is structurally appropriate for untreated growth trajectories.",
      "Carrying capacity is fixed from the resolved model because raw OD600 does not identify an absolute CFU scale.",
      "The common linear OD600 observation layer is adequate over the measured range, with nuisance terms profiled only on training observations.",
      "Exploratory triangular parameter ranges are independent inputs for uncertainty and Sobol analyses and are not confidence intervals.",
    ],
    uncertainty: { completed: monteCarlo.successCount > 0 },
    sensitivity: {
      completed: Boolean(local && morris && sobol),
      assumptions: ["Sobol–Jansen indices use independent biological parameter inputs."],
    },
    dataFit: {
      completed: true,
      realData: true,
      conditionsDescribed: true,
      diagnostics: {
        trainingMetrics,
        residuals: residualSummary(fit.residuals),
        identifiability,
      },
    },
    validation: {
      completed: validation.completed,
      locked: validation.locked,
      leakageFree: validation.leakageFree,
      untouched: validation.untouched,
      splitFingerprint: validation.splitFingerprint,
      independentUnitsDocumented: false,
      eligibleAsValidationEvidence: false,
      l4Eligibility: developmentComparison ? "ineligible_previously_viewed_development" : "ineligible_due_to_incomplete_source_plate_well_independence_documentation",
    },
  });
  if (capability.level !== "L3") {
    fail("UNEXPECTED_CAPABILITY_LEVEL", "The conservative workflow capability assessment must resolve to L3.", "capability.level", capability.level);
  }
  emit(progress, "capability", 1, 1);

  const training = {
    status: fit.status,
    fitDiagnostics,
    role: fit.role,
    fittedOnThisData: fit.fittedOnThisData,
    eligibleAsValidationEvidence: fit.eligibleAsValidationEvidence,
    calibrationOnly: true,
    parameterSetUse: {
      intendedUse: resolvedModel.intendedUse ?? "unspecified",
      researchFitEligible: resolvedModel.researchFitEligible ?? null,
      fittedEstimatesRecomputedFromTrainingDataset: true,
    },
    observationRoleUsed: "training",
    observationCount: fit.observationCount,
    independentUnitCount: trainingUnitIds.length,
    parameterWhitelist: fit.parameterWhitelist,
    bounds: fit.bounds,
    fittedBiologicalParameters,
    profiledObservationLayer: {
      kind: profiledNuisance.kind,
      equation: profiledNuisance.equation,
      terminology: profiledNuisance.terminology,
      baselineOd: profiledNuisance.baselineOd,
      scaleOd: profiledNuisance.scaleOd,
      constraints: profiledNuisance.constraints,
      activeConstraint: profiledNuisance.activeConstraint,
      profiledOnRole: "training",
      observationCount: profiledNuisance.observationCount,
      lockedBeforeValidation: true,
    },
    objectiveValue: fit.objectiveValue,
    metrics: trainingMetrics,
    residualSummary: residualSummary(fit.residuals),
    optimization: compactOptimization(fit.optimization),
    converged: fit.converged,
  };
  const validationResult = {
    ...validation,
    residualConvention: "observed - predicted",
    optimizerUsed: false,
    nuisanceParametersReprofiled: false,
    validationEvaluatorCalls,
    eligibleForL4: false,
    l4IneligibilityReason: developmentComparison
      ? "Previously viewed development data; source plate/well independence is incompletely documented."
      : "Source plate/well independence is incompletely documented.",
  };

  let manifest = null;
  let methodsSummaryMarkdown = null;
  let researchPackage = null;
  if (metadata) {
    await runtime.checkpoint();
    emit(progress, "research_artifacts", 0, 1);
    const failures = allFailures(fit, parameterScan, monteCarloRaw);
    manifest = createAnalysisManifest({
      runId: metadata.runId,
      createdAt: metadata.createdAt,
      applicationVersion: metadata.applicationVersion,
      resolvedModel,
      parameterOverrides: fittedBiologicalParameters,
      overrideOrigins: {
        [GROWTH_PARAMETER]: {
          kind: "fitted_training_biological_parameter",
          role: "training_calibration",
          datasetFingerprint,
        },
        [INITIAL_STATE_PARAMETER]: {
          kind: "fitted_training_biological_initial_state",
          role: "training_calibration",
          datasetFingerprint,
        },
      },
      dataset: {
        id: dataset.metadata.datasetId,
        version: metadata.datasetVersion,
        normalizedDatasetFingerprint: datasetFingerprint,
        sourceArtifactSha256: metadata.contentHash,
        license: dataset.metadata.license,
      },
      splitFingerprint: split.splitFingerprint,
      plan: lockedPlan,
      random: { algorithm: RNG_ALGORITHM, seed },
      algorithm: {
        name: "bounded_differential_evolution_then_nelder_mead_with_profiled_od_observation_layer",
        version: "1",
        bounds,
        stopping: {
          optimizerRestarts: config.optimizerRestarts,
          differentialEvolutionMaxEvaluations: config.differentialEvolutionMaxEvaluations,
          nelderMeadMaxEvaluations: config.nelderMeadMaxEvaluations,
        },
        settings: {
          differentialEvolutionPopulationSize: config.populationSize,
          biologicalParameterWhitelist: [...PARAMETER_NAMES],
          nuisanceProfilingRole: "training",
          nuisanceLockedBeforeValidation: true,
          validationOptimization: false,
          sensitivityOutputTimeHours: SCALAR_OUTPUT_TIME_HOURS,
          profileLikelihoodMethod: computation.profileLikelihood.method,
          profileLikelihoodPoints: config.profileLikelihoodPoints,
          profileLikelihoodNuisanceReoptimized: true,
          computationSettings: computation,
        },
      },
      failures,
      convergence: {
        converged: fit.converged,
        evaluationCount: fit.optimization.evaluationCount,
        terminationReason: fit.optimization.terminationReason,
      },
      residuals: {
        training: training.residualSummary,
        validation: residualSummary(validation.residuals),
      },
      identifiability,
      metrics: { training: trainingMetrics, validation: validation.metrics },
      capabilityAssessment: capability,
      warnings,
    });
    methodsSummaryMarkdown = generateMethodsSummaryMarkdown(manifest);
    researchPackage = buildResearchPackage({
      packageId: options.packageId ?? `${metadata.runId}-research-package`,
      createdAt: metadata.createdAt,
      manifest,
      methodsSummaryMarkdown,
      replay: {
        selfContained: false,
        statement: "The normalized dataset, split, complete locked plan, and resolved model snapshot are embedded, so no model-registry lookup is required. Replay still requires the declared Ecolab analysis and model software implementations.",
        artifactIds: [
          "normalized-observation-dataset",
          "dataset-split",
          "locked-analysis-plan",
          "resolved-model-snapshot",
        ],
        dependencies: [
          {
            id: ANALYSIS_IMPLEMENTATION_ID,
            kind: "software_implementation",
            version: ANALYSIS_ENGINE_VERSION,
            requirement: "exact",
            description: "Ecolab Stage 4 analysis implementation used for fitting, validation, uncertainty, and sensitivity calculations.",
          },
          {
            id: resolvedModel.ref.implementationId,
            kind: "model_implementation",
            version: resolvedModel.ref.version,
            requirement: "exact",
            description: "Piecewise-analytic model implementation required to evaluate the embedded resolved model snapshot; no registry lookup is required.",
          },
        ],
      },
      artifacts: [
        {
          artifactId: "normalized-observation-dataset",
          role: "normalized_dataset",
          path: "normalized-observation-dataset.json",
          mediaType: "application/json",
          description: "Canonical normalized observation dataset used to compute normalizedDatasetFingerprint.",
          content: dataset,
        },
        {
          artifactId: "dataset-split",
          role: "locked_dataset_split",
          path: "dataset-split.json",
          mediaType: "application/json",
          content: split,
        },
        {
          artifactId: "locked-analysis-plan",
          role: "complete_locked_analysis_plan",
          path: "locked-analysis-plan.json",
          mediaType: "application/json",
          content: lockedPlan,
        },
        {
          artifactId: "resolved-model-snapshot",
          role: "resolved_model_snapshot",
          path: "resolved-model-snapshot.json",
          mediaType: "application/json",
          description: "Resolved model and parameter snapshot embedded to avoid replay-time registry resolution.",
          content: resolvedModel,
        },
        {
          artifactId: "stage4-fit-summary",
          role: "training_calibration_summary",
          path: "stage4-fit-summary.json",
          mediaType: "application/json",
          content: training,
        },
        {
          artifactId: "stage4-locked-validation",
          role: developmentComparison ? "previously_viewed_development_result" : "locked_validation_result",
          path: "stage4-locked-validation.json",
          mediaType: "application/json",
          content: validationResult,
        },
        {
          artifactId: "stage4-workflow-summary",
          role: "analysis_workflow_summary",
          path: "stage4-workflow-summary.json",
          mediaType: "application/json",
          content: {
            schemaVersion: "1.0.0",
            kind: "ecolab-stage4-od600-workflow-summary",
            sourceArtifactSha256: metadata.contentHash,
            sourceArtifactSha256Verified: metadata.contentHashVerified,
            normalizedDatasetFingerprint: datasetFingerprint,
            splitFingerprint: split.splitFingerprint,
            planFingerprint: lockedPlan.planFingerprint,
            seeds,
            scalarOutput: {
              name: `predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`,
              timeHours: SCALAR_OUTPUT_TIME_HOURS,
              nuisanceParametersFixedFromTraining: true,
            },
            capabilityLevel: capability.level,
            independentUnitsDocumented: false,
            warnings,
          },
        },
      ],
    });
    emit(progress, "research_artifacts", 1, 1);
  }

  const result = {
    schemaVersion: "1.0.0",
    kind: "ecolab-stage4-real-data-research-workflow",
    status: fit.status,
    pureWorkflow: true,
    dataset: {
      id: dataset.metadata.datasetId,
      normalizedMeasurementType: "od600",
      sourceSemantics: "raw OD600 source values retained without modification",
      observationCount: dataset.observations.length,
      trainingObservationCount: trainingObservations.length,
      validationObservationCount: validationObservations.length,
      independentUnitCount: datasetFacts.independentUnitCount,
      trainingUnitCount: datasetFacts.trainingUnitCount,
      validationUnitCount: datasetFacts.validationUnitCount,
      sourceTimesHours: datasetFacts.sourceTimes,
      sourceIncludesTimeZero: false,
      maximumObservedTimeHours: datasetFacts.maximumTimeHours,
      normalizedDatasetFingerprint: datasetFingerprint,
      sourceArtifactSha256,
      sourceArtifactSha256Verified: metadata?.contentHashVerified ?? false,
      sourceContentHash: sourceArtifactSha256,
      sourceContentHashVerified: metadata?.contentHashVerified ?? false,
      quality,
      importWarnings: imported.warnings,
    },
    model: {
      id: resolvedModel.ref.id,
      version: resolvedModel.ref.version,
      implementationId: resolvedModel.ref.implementationId,
      scientificCore: "no-drug piecewise-analytic logistic growth",
      carryingCapacityLog10CfuPerMl: carryingCapacity,
      carryingCapacityFixed: true,
      protocol: constantNoDrugProtocol(datasetFacts.maximumTimeHours),
      sampleAlignment: "exact source times",
      treatmentOrAntibioticInference: false,
    },
    split,
    parameterSpace,
    seeds: { algorithm: RNG_ALGORITHM, ...seeds },
    runMetadata: {
      applicationVersion: metadata?.applicationVersion ?? options.applicationVersion ?? "unknown",
      runId: metadata?.runId ?? options.runId ?? null,
      seed,
      seeds: { algorithm: RNG_ALGORITHM, ...seeds },
      settings: {
        preset: options.preset ?? null,
        workflowConfiguration: config,
        computationSettings: computation,
        baseParameterSetIntendedUse: resolvedModel.intendedUse ?? "unspecified",
        baseParameterSetResearchFitEligible: resolvedModel.researchFitEligible ?? null,
        profileLikelihoodPoints: config.profileLikelihoodPoints,
      },
    },
    training,
    identifiability,
    lockedPlan,
    validation: validationResult,
    analyses: {
      scalarOutput: {
        name: `predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`,
        timeHours: SCALAR_OUTPUT_TIME_HOURS,
        observationLayerNuisanceParameters: "fixed at training-profiled values",
      },
      parameterScan,
      monteCarlo,
      sensitivity: {
        local,
        morris,
        sobolJansen: sobol,
        sobolInputAssumption: "independent_inputs_only",
      },
    },
    capability: {
      ...capability,
      independentUnitsDocumented: false,
      heldOutValidationPerformed: !developmentComparison,
      ...(developmentComparison ? { developmentComparisonPerformed: true, untouched: false } : {}),
      heldOutValidationEligibleForL4: false,
    },
    warnings,
    reproducibility: {
      normalizedDatasetFingerprint: datasetFingerprint,
      sourceArtifactSha256,
      sourceContentHash: sourceArtifactSha256,
      splitFingerprint: split.splitFingerprint,
      planFingerprint: lockedPlan.planFingerprint,
      ...(metadata ? {
        datasetVersion: metadata.datasetVersion,
        runId: metadata.runId,
        createdAt: metadata.createdAt,
        applicationVersion: metadata.applicationVersion,
      } : {}),
    },
    ...(manifest ? { manifest, methodsSummaryMarkdown, researchPackage } : {}),
  };
  emit(progress, "complete", 1, 1);
  return jsonSafe(result);
}

export const runStage4ResearchWorkflow = runEcolabStage4ResearchWorkflow;
export const runOd600ResearchWorkflow = runEcolabStage4ResearchWorkflow;
