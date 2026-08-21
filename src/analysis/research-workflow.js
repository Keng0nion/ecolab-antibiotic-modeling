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
import { localSensitivity } from "./sensitivity-local.js";
import { morrisSensitivity } from "./sensitivity-morris.js";
import { sobolJansenSensitivity } from "./sensitivity-sobol.js";
import { createDatasetSplit } from "./split.js";
import { validateLockedPlan } from "./validation.js";
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
  });
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

function workflowConfiguration(options) {
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
    returnedMonteCarloSamples: integerOption(
      options.returnedMonteCarloSamples,
      32,
      "returnedMonteCarloSamples",
      1,
      ECOLAB_STAGE4_WORKFLOW_LIMITS.maximumReturnedMonteCarloSamples,
    ),
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
  const config = workflowConfiguration(options);
  const progress = progressCallback(options.onProgress);
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
    strategy: "declared_training_validation_roles_by_complete_independent_unit",
    lockedValidation: true,
  });
  const trainingObservations = dataset.observations.filter(({ role }) => role === "training");
  const validationObservations = dataset.observations.filter(({ role }) => role === "validation");
  const trainingUnitIds = split.roles.training.independentUnitIds;
  const validationUnitIds = split.roles.validation.independentUnitIds;
  emit(progress, "dataset_split", 1, 1);

  const parameterSpace = parameterSpaceFor(carryingCapacity);
  const bounds = boundsFromSpace(parameterSpace);
  const startingParameters = initialParameters(resolvedModel, parameterSpace);

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
      populationSize: config.populationSize,
      maxEvaluations: config.differentialEvolutionMaxEvaluations,
    },
    nelderMead: { maxEvaluations: config.nelderMeadMaxEvaluations },
    evaluator: (biologicalParameters, observations) =>
      profiledTrainingEvaluation(
        resolvedModel,
        biologicalParameters,
        observations,
        datasetFacts.maximumTimeHours,
      ).predictions,
    observationModel: (profiledOdPrediction) => profiledOdPrediction,
  });
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

  emit(progress, "identifiability", 0, 1);
  const identifiabilityRaw = analyzeIdentifiability({
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
    profiles: { points: config.identifiabilityProfilePoints, maxParameters: 2 },
    optimization: fit.optimization,
  });
  const identifiability = jsonSafe(identifiabilityRaw);
  emit(progress, "identifiability", 1, 1);

  emit(progress, "lock_validation_plan", 0, 1);
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
    analysisKind: "training_profiled_od600_logistic_fit_and_locked_validation",
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
      latentModel: "No-drug piecewise-analytic logistic population model with fixed carrying capacity from the resolved model.",
      sampleAlignment: "Exact source times only; model time 0 is an initial state and is not a source observation.",
      carryingCapacityLog10CfuPerMl: carryingCapacity,
      nuisanceParameters: "baselineOd and scaleOd are observation-layer nuisance parameters profiled on training observations and fixed before validation.",
      treatmentInference: "No treatment or antibiotic parameter is inferred.",
    },
  });
  emit(progress, "lock_validation_plan", 1, 1);

  emit(progress, "locked_validation", 0, 1);
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
  emit(progress, "locked_validation", 1, 1);

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

  emit(progress, "monte_carlo", 0, config.monteCarloSamples);
  const monteCarloRaw = runMonteCarlo({
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

  emit(progress, "local_sensitivity", 0, 1);
  const local = localSensitivity({
    parameterSpace,
    baseline: fittedBiologicalParameters,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
  });
  emit(progress, "local_sensitivity", 1, 1);

  emit(progress, "morris_sensitivity", 0, 1);
  const morris = morrisSensitivity({
    parameterSpace,
    trajectories: config.morrisTrajectories,
    levels: config.morrisLevels,
    seed: seeds.morris,
    outputNames: [`predictedOdAt${SCALAR_OUTPUT_TIME_HOURS}Hours`],
    evaluator: scalarEvaluator,
  });
  emit(progress, "morris_sensitivity", 1, 1);

  emit(progress, "sobol_sensitivity", 0, 1);
  const sobol = sobolJansenSensitivity({
    parameterDistributions: distributions,
    sampleCount: config.sobolSamples,
    seed: seeds.sobol,
    independentInputs: true,
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
    {
      code: "EXPLORATORY_PARAMETER_INTERVALS",
      severity: "warning",
      message: "Monte Carlo triangular ranges are exploratory parameter-uncertainty simulation inputs, not confidence intervals.",
    },
    {
      code: "INDEPENDENT_UNIT_DOCUMENTATION_INCOMPLETE",
      severity: "warning",
      message: "Held-out validation was locked and leakage-free, but source plate/well independence is incompletely documented; this evidence is not eligible for L4.",
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
      l4Eligibility: "ineligible_due_to_incomplete_source_plate_well_independence_documentation",
    },
  });
  if (capability.level !== "L3") {
    fail("UNEXPECTED_CAPABILITY_LEVEL", "The conservative workflow capability assessment must resolve to L3.", "capability.level", capability.level);
  }
  emit(progress, "capability", 1, 1);

  const training = {
    role: fit.role,
    fittedOnThisData: fit.fittedOnThisData,
    eligibleAsValidationEvidence: fit.eligibleAsValidationEvidence,
    calibrationOnly: true,
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
    l4IneligibilityReason: "Source plate/well independence is incompletely documented.",
  };

  let manifest = null;
  let methodsSummaryMarkdown = null;
  let researchPackage = null;
  if (metadata) {
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
            id: "ecolab-stage4-analysis-v1",
            kind: "software_implementation",
            version: "1.0.0",
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
          role: "locked_validation_result",
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
      heldOutValidationPerformed: true,
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
