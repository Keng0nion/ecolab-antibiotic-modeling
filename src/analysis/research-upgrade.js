import { ENGINE_VERSION } from "../model.js";
import { buildResearchPackage, createAnalysisManifest, generateMethodsSummaryMarkdown } from "./analysis-manifest.js";
import { importObservationDataset } from "./dataset-import.js";
import { canonicalJson, sha256HexFallback } from "./fingerprint.js";
import { GROWTH_COMPARISON_LIMITS, runGrowthModelComparison } from "./growth-comparison.js";
import { deriveSeed, RNG_ALGORITHM } from "./random.js";
import {
  EcolabResearchWorkflowError,
  researchWorkflowComputationSettings,
  researchWorkflowConfiguration,
  researchWorkflowRuntime,
  runEcolabStage4ResearchWorkflow,
} from "./research-workflow.js";
import { ANALYSIS_ENGINE_VERSION, ANALYSIS_IMPLEMENTATION_ID } from "./version.js";

export const RESEARCH_WORKFLOW_IMPLEMENTATION_ID = "ecolab-research-development-v2";
const APPLICATION_VERSION = "6.0.0";
const SCIENTIFIC_FIELDS = Object.freeze([
  "dataset", "model", "split", "parameterSpace", "seeds", "training", "identifiability",
  "lockedPlan", "validation", "analyses", "growthComparison", "capability", "warnings", "researchAssessment",
]);
const OPTIMIZER_KEYS = ["restarts", "populationSize", "differentialEvolutionMaxEvaluations", "nelderMeadMaxEvaluations"];
const SCALAR_KEYS = [
  "scanPointsPerAxis", "monteCarloSamples", "morrisTrajectories", "morrisLevels", "sobolSamples",
  "sobolBootstrapReplicates", "sobolBootstrapSeed", "sobolConfidenceLevel", "sobolPrecisionTolerance",
  "identifiabilityProfilePoints", "returnedMonteCarloSamples", "uncertaintyRangeFraction", "includeMonteCarloSamples",
];
const OPTION_KEYS = [
  "datasetInput", "datasetFormat", "resolvedModel", "runId", "createdAt", "datasetVersion", "contentHash",
  "applicationVersion", "planId", "packageId", "seed", "optimizer", "optimizerRestarts", "populationSize",
  "differentialEvolutionMaxEvaluations", "nelderMeadMaxEvaluations", ...SCALAR_KEYS,
  "growthComparison", "developmentComparison", "scalarOutputTimeHours", "seeds", "computationSettings", "runtime", "onProgress",
];
const APP_DEFAULTS = {
  optimizer: { restarts: 1, populationSize: 12, differentialEvolutionMaxEvaluations: 300, nelderMeadMaxEvaluations: 200 },
  scanPointsPerAxis: 5, monteCarloSamples: 128, morrisTrajectories: 8, morrisLevels: 4,
  sobolSamples: 64, sobolBootstrapReplicates: 200, sobolConfidenceLevel: 0.95, sobolPrecisionTolerance: 0.2,
  identifiabilityProfilePoints: 5, returnedMonteCarloSamples: 32,
  uncertaintyRangeFraction: 0.1, includeMonteCarloSamples: false,
};
const GROWTH_DEFAULTS = {
  bounds: { baselineOd: [0, 0.3], amplitudeOd: [0.001, 1], ratePerHour: [0.001, 4], timingHours: [0, 30] },
  optimizer: {
    restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 120,
    nelderMeadMaxEvaluations: 80, tolerance: 1e-7, objectiveTolerance: 1e-12,
  },
  bootstrap: { samples: 20, intervalLevel: 0.95 },
};

function fail(code, message, path) {
  throw new EcolabResearchWorkflowError(code, message, { path });
}

function record(value, path, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail("INVALID_WORKFLOW_INPUT", `${path} must be a plain object.`, path);
  }
  if (keys) for (const key of Object.keys(value)) {
    if (!keys.includes(key)) fail("UNKNOWN_WORKFLOW_OPTION", `Unknown ${path}.${key}.`, `${path}.${key}`);
  }
  if (keys) for (const [key, child] of Object.entries(value)) {
    if (child === null) fail("INVALID_WORKFLOW_INPUT", `${path}.${key} cannot be null; omit it to use its default.`, `${path}.${key}`);
  }
  return value;
}

function text(value, path) {
  if (typeof value !== "string" || !value.trim()) fail("INVALID_WORKFLOW_STRING", `${path} must be a non-empty string.`, path);
  return value;
}

function number(value, path, lower = -Infinity, upper = Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < lower || value > upper) {
    fail("INVALID_WORKFLOW_NUMBER", `${path} must be finite within [${lower}, ${upper}].`, path);
  }
  return value;
}

function integer(value, path, lower, upper) {
  number(value, path, lower, upper);
  if (!Number.isSafeInteger(value)) fail("INVALID_WORKFLOW_INTEGER", `${path} must be a safe integer.`, path);
  return value;
}

function clone(value) { return JSON.parse(canonicalJson(value)); }
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
}

function verifyFixed(supplied, expected, path) {
  if (supplied !== undefined && canonicalJson(supplied) !== canonicalJson(expected)) {
    fail("REPLAY_SETTINGS_MISMATCH", `${path} differs from the resolved settings for this implementation.`, path);
  }
}

function growthConfiguration(input, trainingIds) {
  const source = record(input ?? {}, "growthComparison", ["bounds", "optimizer", "crossValidation", "bootstrap"]);
  const bounds = clone(record(source.bounds ?? GROWTH_DEFAULTS.bounds, "growthComparison.bounds", Object.keys(GROWTH_DEFAULTS.bounds)));
  for (const name of Object.keys(GROWTH_DEFAULTS.bounds)) {
    const pair = bounds[name];
    const path = `growthComparison.bounds.${name}`;
    if (!Array.isArray(pair) || pair.length !== 2) fail("INVALID_BOUNDS", `${path} requires [lower, upper].`, path);
    number(pair[0], `${path}[0]`); number(pair[1], `${path}[1]`);
    if (!(pair[0] < pair[1]) || !Number.isFinite(pair[1] - pair[0])
      || (["amplitudeOd", "ratePerHour"].includes(name) && !(pair[0] > 0))) {
      fail("INVALID_BOUNDS", `${path} requires finite width, increasing endpoints and positive amplitude/rate.`, path);
    }
  }
  number(bounds.baselineOd[1] + bounds.amplitudeOd[1], "growthComparison upper OD asymptote");
  const optimizer = {
    ...GROWTH_DEFAULTS.optimizer,
    ...record(source.optimizer ?? {}, "growthComparison.optimizer", Object.keys(GROWTH_DEFAULTS.optimizer)),
  };
  const limits = GROWTH_COMPARISON_LIMITS;
  integer(optimizer.restarts, "growthComparison.optimizer.restarts", 1, limits.maximumRestarts);
  integer(optimizer.populationSize, "growthComparison.optimizer.populationSize", 4, limits.maximumPopulationSize);
  for (const key of OPTIMIZER_KEYS.slice(2)) integer(optimizer[key], `growthComparison.optimizer.${key}`, 1, limits.maximumStageEvaluations);
  number(optimizer.tolerance, "growthComparison.optimizer.tolerance", Number.MIN_VALUE, 1);
  number(optimizer.objectiveTolerance, "growthComparison.optimizer.objectiveTolerance", 0);
  const cv = record(source.crossValidation ?? {}, "growthComparison.crossValidation", ["folds", "tieTolerance"]);
  const rawFolds = cv.folds ?? trainingIds.map((id) => [id]);
  if (!Array.isArray(rawFolds) || rawFolds.length < 2 || rawFolds.length > trainingIds.length) {
    fail("INVALID_FOLDS", "Cross-validation requires at least two complete-training-trajectory folds.", "growthComparison.crossValidation.folds");
  }
  const folds = Array.from(rawFolds, (fold) => {
    if (!Array.isArray(fold) || !fold.length || fold.length >= trainingIds.length
      || fold.some((id) => typeof id !== "string" || !trainingIds.includes(id))) {
      fail("INVALID_FOLDS", "Folds must contain nonempty proper subsets of exact training IDs.", "growthComparison.crossValidation.folds");
    }
    return [...fold].sort();
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  verifyFixed(folds.flat().sort(), trainingIds, "growthComparison.crossValidation.folds");
  const bootstrap = { ...GROWTH_DEFAULTS.bootstrap, ...record(source.bootstrap ?? {}, "growthComparison.bootstrap", ["samples", "intervalLevel"]) };
  integer(bootstrap.samples, "growthComparison.bootstrap.samples", 0, limits.maximumBootstrapSamples);
  number(bootstrap.intervalLevel, "growthComparison.bootstrap.intervalLevel", Number.MIN_VALUE, 1 - Number.EPSILON);
  const evaluations = optimizer.restarts * (optimizer.differentialEvolutionMaxEvaluations + optimizer.nelderMeadMaxEvaluations)
    * (2 * (folds.length + 1) + bootstrap.samples);
  if (evaluations > limits.maximumTotalEvaluations) fail("EVALUATION_LIMIT", "Combined growth CV/refit/bootstrap budget exceeds its limit.", "growthComparison");
  return { bounds, optimizer, crossValidation: { folds, tieTolerance: number(cv.tieTolerance ?? 1e-10, "growthComparison.crossValidation.tieTolerance", 0) }, bootstrap };
}

function normalizeOptions(input) {
  record(input, "options", OPTION_KEYS);

  for (const key of ["runId", "createdAt", "datasetVersion"]) text(input[key], key);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(input.createdAt) || !Number.isFinite(Date.parse(input.createdAt))) {
    fail("INVALID_TIMESTAMP", "createdAt must be an ISO 8601 timestamp with a timezone.", "createdAt");
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(input.datasetVersion)) fail("INVALID_DATASET_VERSION", "datasetVersion must be semantic version text.", "datasetVersion");
  verifyFixed(input.applicationVersion, APPLICATION_VERSION, "applicationVersion");
  verifyFixed(input.developmentComparison, true, "developmentComparison");
  verifyFixed(input.scalarOutputTimeHours, 10, "scalarOutputTimeHours");
  const seed = integer(input.seed ?? 0x5e4c0ab1, "seed", 0, 0xffff_ffff);
  const optimizer = record(input.optimizer ?? {}, "optimizer", OPTIMIZER_KEYS);
  for (const key of OPTIMIZER_KEYS) {
    const alias = key === "restarts" ? "optimizerRestarts" : key;
    if (optimizer[key] !== undefined && input[alias] !== undefined && optimizer[key] !== input[alias]) {
      fail("CONFLICTING_OPTIMIZER_OPTIONS", `optimizer.${key} conflicts with ${alias}.`, alias);
    }
    if (optimizer[key] === null) fail("INVALID_WORKFLOW_INPUT", `optimizer.${key} cannot be null.`, `optimizer.${key}`);
  }
  const explicit = {
    ...APP_DEFAULTS,
    ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)),
    optimizer: Object.fromEntries(OPTIMIZER_KEYS.map((key) => [key,
      optimizer[key] ?? input[key === "restarts" ? "optimizerRestarts" : key] ?? APP_DEFAULTS.optimizer[key],
    ])),
  };
  const config = researchWorkflowConfiguration(explicit);
  if (config.sobolBootstrapReplicates === 1 || !(config.sobolConfidenceLevel > 0 && config.sobolConfidenceLevel < 1) || !(config.sobolPrecisionTolerance > 0)) {
    fail("INVALID_SOBOL_BOOTSTRAP_OPTIONS", "Sobol bootstrap requires 0 or >=2 replicates, confidence in (0,1), and positive precision tolerance.", "sobolBootstrapReplicates");
  }
  if (input.includeMonteCarloSamples !== undefined && typeof input.includeMonteCarloSamples !== "boolean") {
    fail("INVALID_WORKFLOW_BOOLEAN", "includeMonteCarloSamples must be boolean.", "includeMonteCarloSamples");
  }
  const uncertaintyRangeFraction = number(explicit.uncertaintyRangeFraction, "uncertaintyRangeFraction", Number.MIN_VALUE, 0.5);
  const resolvedModel = clone(record(input.resolvedModel, "resolvedModel"));
  if (resolvedModel.ref?.version !== "1.0.0") {
    fail("UNSUPPORTED_MODEL_VERSION", "This built-in workflow requires resolvedModel.ref.version 1.0.0.", "resolvedModel.ref.version");
  }
  const computationSettings = {
    ...researchWorkflowComputationSettings({ ...explicit, resolvedModel }),
    growthComparison: {
      implementationId: "direct-od-growth-comparison-v1", developmentRole: "validation",
      objective: "mean_trajectory_mse_od600", crossValidationMetric: "macroRmse",
      tieOrder: ["training_mean", "logistic", "gompertz"],
      optimizerConstants: { mutationFactor: 0.8, crossoverRate: 0.9, initialStep: 0.05 },
      quantileMethod: "R7", minimumExpectedTailSamples: 5, intervalRefits: "finite_converged_only",
      seedDerivation: "deriveSeed(root, direct-od-growth-comparison-v1, phase, model, index); restart and stage substreams",
      resamplingUnit: "whole_training_trajectory", independentParameterMarginalsForSensitivity: false,
    },
  };
  verifyFixed(input.computationSettings, computationSettings, "computationSettings");

  // Canonicalizing an object creates a new source artifact, never evidence that an
  // older whitespace-sensitive source-byte hash still matches it.
  const objectInput = typeof input.datasetInput !== "string";
  const datasetInput = objectInput ? canonicalJson(record(input.datasetInput, "datasetInput")) : text(input.datasetInput, "datasetInput");
  let datasetFormat = input.datasetFormat ?? "auto";
  if (datasetFormat === "object") {
    if (!objectInput) fail("INVALID_IMPORT_FORMAT", "object format requires object input.", "datasetFormat");
    datasetFormat = "json";
  }
  const imported = importObservationDataset(datasetInput, { format: datasetFormat });
  const contentHash = sha256HexFallback(datasetInput);
  if (input.contentHash !== undefined && input.contentHash !== contentHash) {
    fail("CONTENT_HASH_MISMATCH", "contentHash does not match the exact replay source text (canonical text for object input).", "contentHash");
  }
  const trainingIds = [...new Set(imported.dataset.observations.filter(({ role }) => role === "training").map(({ independentUnitId }) => independentUnitId))].sort();
  if (trainingIds.length < 2 || trainingIds.length > GROWTH_COMPARISON_LIMITS.maximumTrainingTrajectories
    || imported.dataset.observations.length > GROWTH_COMPARISON_LIMITS.maximumObservations) {
    fail("GROWTH_DATASET_LIMIT", "Growth comparison requires 2–128 training trajectories and at most 10000 observations.", "datasetInput");
  }
  const growthComparison = growthConfiguration(input.growthComparison, trainingIds);
  const sobolSeed = deriveSeed(seed, "sobol");
  const sobolBootstrapSeed = integer(input.sobolBootstrapSeed ?? deriveSeed(sobolSeed, "sobol", "bootstrap"), "sobolBootstrapSeed", 0, 0xffff_ffff);
  const seeds = {
    analysis: seed, optimizer: deriveSeed(seed, "optimizer"), monteCarlo: deriveSeed(seed, "monte-carlo"),
    morris: deriveSeed(seed, "morris"), sobol: sobolSeed, sobolBootstrap: sobolBootstrapSeed,
    growthComparison: deriveSeed(seed, "growth-comparison"),
  };
  verifyFixed(input.seeds, seeds, "seeds");
  const normalized = {
    datasetInput, datasetFormat: imported.format, resolvedModel,
    applicationVersion: APPLICATION_VERSION, runId: input.runId, createdAt: new Date(input.createdAt).toISOString(),
    datasetVersion: input.datasetVersion, contentHash,
    packageId: text(input.packageId ?? `${input.runId}-research-package`, "packageId"),
    planId: text(input.planId ?? `${imported.dataset.metadata.datasetId}-development-plan-v2`, "planId"),
    developmentComparison: true, scalarOutputTimeHours: 10, seed, seeds, computationSettings,
    optimizer: {
      restarts: config.optimizerRestarts, populationSize: config.populationSize,
      differentialEvolutionMaxEvaluations: config.differentialEvolutionMaxEvaluations,
      nelderMeadMaxEvaluations: config.nelderMeadMaxEvaluations,
    },
    ...Object.fromEntries(SCALAR_KEYS.filter((key) => Object.hasOwn(config, key)).map((key) => [key, config[key]])),
    sobolBootstrapSeed, uncertaintyRangeFraction, includeMonteCarloSamples: explicit.includeMonteCarloSamples,
    growthComparison,
  };
  return freeze(clone(normalized));
}

/** Deterministic scientific output only; metadata timestamps are recursively omitted. */
export function scientificResearchProjection(result) {
  record(result, "result");
  const selected = clone(Object.fromEntries(SCIENTIFIC_FIELDS.map((key) => [key, result[key]])));
  function omitTimestamps(value) {
    if (Array.isArray(value)) return value.map(omitTimestamps);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key !== "createdAt").map(([key, child]) => [key, omitTimestamps(child)]));
    return value;
  }
  return freeze(omitTimestamps(selected));
}

function assessResearch(legacy, growth) {
  const candidateFits = Object.values(growth.trainingFits).concat(
    Object.values(growth.crossValidation.candidates).flatMap(({ folds }) => folds.map(({ fit }) => fit)),
  );
  const sobolPrecision = Object.values(legacy.analyses.sensitivity.sobolJansen.byParameter)
    .flatMap(({ parameter, outputs }) => Object.entries(outputs).map(([output, value]) => ({ parameter, output, ...value.precision })));
  const sobolAssessed = sobolPrecision.length > 0 && sobolPrecision.every(({ assessed }) => assessed);
  const growthConverged = candidateFits.every((fit) => fit.converged && fit.finite) && growth.bootstrap.failures.length === 0;
  return {
    completed: legacy.validation.completed === true && growth.completed === true,
    converged: legacy.training.converged && growthConverged,
    identified: false,
    precisionAssessed: sobolAssessed && growth.bootstrap.intervals.precisionAssessed,
    validationEvidence: "previously_viewed_development_only", untouched: false, eligibleForL4: false,
    convergence: {
      legacyTraining: legacy.training.converged,
      growthTrainingAndCrossValidationFits: candidateFits.every((fit) => fit.converged && fit.finite),
      growthBootstrapFailureCount: growth.bootstrap.failures.length,
      criterion: "All reported best training/CV fits must be finite and converged, with no failed requested bootstrap refits; individual stage diagnostics remain authoritative. This is not proof of a global optimum.",
    },
    identification: {
      status: "not_established", legacyLocalFullRank: legacy.identifiability.rank === legacy.identifiability.parameterNames.length,
      covarianceStatus: legacy.identifiability.covarianceDiagnostics.status,
      calibratedParameterUncertainty: legacy.identifiability.covarianceDiagnostics.parameterUncertaintyEstimated,
      growthIdentifiabilityAssessed: false,
      interpretation: "Local geometry and conditional curve resampling do not establish full parameter identification; absolute CFU scale is not identified by raw OD600 and growth structural/practical identifiability is not assessed here.",
    },
    precision: {
      sobolAssessed, sobolImprecise: sobolPrecision.some(({ imprecise }) => imprecise === true), sobol: sobolPrecision,
      growthBootstrapAssessed: growth.bootstrap.intervals.precisionAssessed,
      growthBootstrapTailResolutionAdequate: growth.bootstrap.intervals.tailResolutionAdequate,
      interpretation: "Sobol precision concerns Monte Carlo sampling under declared independent engineering ranges only. Growth percentile intervals are conditional and exploratory; tail resolution alone does not establish precision or coverage.",
    },
  };
}

function retainedWarnings(legacy, growth, assessment, options) {
  const warnings = [
    ...legacy.warnings,
    ...legacy.identifiability.warnings.map((warning) => ({ ...warning, stage: "identifiability" })),
    ...legacy.analyses.monteCarlo.warnings.map((warning) => ({ ...warning, stage: "monte_carlo" })),
    ...growth.warnings.map((warning) => ({ ...warning, stage: "growth_comparison" })),
  ].map((warning) => ({ ...warning, severity: warning.severity ?? "warning" }));
  const add = (code, message, details = {}) => warnings.push({ code, severity: "warning", message, ...details });
  if (!legacy.training.converged) add("LEGACY_OPTIMIZER_NOT_CONVERGED", "The legacy training fit exhausted its bounded search without establishing convergence; completion is not numerical success.");
  if (legacy.training.optimization.restarts.some((run) => !run.differentialEvolution.converged || !run.nelderMead.converged)) {
    add("LEGACY_OPTIMIZER_STAGE_NOT_CONVERGED", "At least one legacy optimizer stage did not converge; all bounded-stage termination diagnostics are retained.");
  }
  if (options.optimizer.differentialEvolutionMaxEvaluations < 500 || options.optimizer.nelderMeadMaxEvaluations < 500) {
    add("LOW_LEGACY_OPTIMIZER_BUDGET", "The legacy calibration uses a reduced engineering computation budget; a finite fit does not establish convergence or a global optimum.");
  }
  for (const precision of assessment.precision.sobol) {
    if (!precision.assessed || precision.imprecise) add(
      precision.assessed ? "SOBOL_IMPRECISE" : "SOBOL_PRECISION_NOT_ASSESSED",
      "Sobol paired-row bootstrap precision is insufficient or unassessed; raw estimates and their issues are retained, not clipped or reordered.",
      { parameter: precision.parameter, output: precision.output, issues: precision.issues },
    );
  }
  add("GROWTH_BOUNDS_PREDECLARED", "Direct-OD bounds are explicit engineering constraints, not inferred from development values or claimed as physiological confidence ranges.", { bounds: options.growthComparison.bounds });
  add("SENSITIVITY_NOT_BOOTSTRAP_MARGINALS", "Legacy sensitivity uses separately declared independent exploratory biological-parameter ranges, never marginal distributions of joint growth-bootstrap samples. Trajectory independence remains unverified.");
  return warnings;
}

function buildArtifacts(result, legacy, options) {
  const manifest = createAnalysisManifest({
    runId: options.runId, createdAt: options.createdAt, applicationVersion: options.applicationVersion,
    resolvedModel: options.resolvedModel, parameterOverrides: legacy.manifest.parameterOverrides,
    dataset: legacy.manifest.dataset, plan: result.lockedPlan, splitFingerprint: result.split.splitFingerprint,
    random: { algorithm: RNG_ALGORITHM, seed: options.seed },
    algorithm: {
      name: RESEARCH_WORKFLOW_IMPLEMENTATION_ID, version: ANALYSIS_ENGINE_VERSION,
      bounds: result.training.bounds,
      stopping: {
        optimizer: options.optimizer, growthOptimizer: options.growthComparison.optimizer,
        growthBootstrapSamples: options.growthComparison.bootstrap.samples,
        monteCarloSamples: options.monteCarloSamples, sobolSamples: options.sobolSamples,
        sobolBootstrapReplicates: options.sobolBootstrapReplicates,
      },
      settings: {
        implementationId: RESEARCH_WORKFLOW_IMPLEMENTATION_ID, replayInputArtifactId: "research-replay-input",
        seeds: options.seeds, computationSettings: options.computationSettings,
        growthComparison: options.growthComparison, evaluationRole: "development_comparison", untouched: false,
        nuisanceProfilingRole: "training", developmentOptimization: false,
      },
    },
    failures: [...legacy.manifest.failures, ...result.growthComparison.bootstrap.failures.map((failure) => ({ stage: "growth_bootstrap", ...failure }))],
    convergence: { converged: result.researchAssessment.converged, researchAssessment: result.researchAssessment },
    residuals: { training: result.training.residualSummary, development: legacy.manifest.diagnostics.residuals.validation },
    identifiability: result.identifiability,
    metrics: { training: result.training.metrics, development: result.validation.metrics, growthDevelopment: result.growthComparison.development.selected.metrics },
    capabilityAssessment: result.capability, warnings: result.warnings,
  });
  const methodsSummaryMarkdown = `${generateMethodsSummaryMarkdown(manifest)}\n## Development-only workflow\n\n`
    + "The legacy source role named validation is previously viewed development data: untouched=false, no L4 evidence. The legacy locked-plan flag records frozen training parameters/settings, not untouched evidence.\n\n"
    + "Direct-OD Logistic and Gompertz candidates are empirical observation-scale curves, not CFU or log-population Zwietering physiology. Complete-trajectory training-only CV selects against the exact-time training-mean baseline with a deterministic tolerance/tie order. Selection is frozen before development evaluation.\n\n"
    + "Whole training trajectories are resampled with replacement; selected-model refits retain joint parameter draws and failures. Percentile intervals condition on successful refits and exclude selection/noise uncertainty. Independence, identification, precision and coverage are not established by completion.\n\n"
    + "Objective slices fix other biological parameters but reoptimize OD nuisance parameters on training data; they are not profile likelihood. Legacy Monte Carlo/Sobol uses separate engineering ranges, never independently mixed growth-bootstrap marginals. All exact inputs, seeds and budgets are embedded in research-replay-input.json.\n";
  const replayInput = {
    schemaVersion: "1.0.0", kind: "ecolab-research-replay-input", implementationId: RESEARCH_WORKFLOW_IMPLEMENTATION_ID,
    versions: { application: options.applicationVersion, core: ENGINE_VERSION, analysis: ANALYSIS_ENGINE_VERSION, analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID },
    options,
  };
  const contents = [
    ["normalized-observation-dataset", "normalized_dataset", legacy.researchPackage.contents.artifacts["normalized-observation-dataset"]],
    ["dataset-split", "training_and_previously_viewed_development_split", result.split],
    ["locked-analysis-plan", "frozen_legacy_training_analysis_plan", result.lockedPlan],
    ["resolved-model-snapshot", "resolved_model_snapshot", options.resolvedModel],
    ["research-replay-input", "complete_research_replay_input", replayInput],
    ["scientific-result", "deterministic_scientific_result", scientificResearchProjection(result)],
  ];
  const researchPackage = buildResearchPackage({
    packageId: options.packageId, createdAt: options.createdAt, manifest, methodsSummaryMarkdown,
    replay: {
      selfContained: false,
      statement: "Exact source text, complete normalized inputs, model snapshot and deterministic scientific output are embedded. Replay requires the declared exact built-in software implementations; no registry lookup, imported code or network fetch is needed. Previously viewed development data is not untouched validation.",
      artifactIds: contents.map(([id]) => id),
      dependencies: [
        { id: ANALYSIS_IMPLEMENTATION_ID, kind: "software_implementation", version: ANALYSIS_ENGINE_VERSION, requirement: "exact", description: "Built-in analysis implementation containing this development-only workflow and direct-OD comparison." },
        { id: result.model.implementationId, kind: "model_implementation", version: result.model.version, requirement: "exact", description: "Built-in model implementation for the embedded resolved snapshot; no registry resolution." },
      ],
    },
    artifacts: contents.map(([artifactId, role, content]) => ({ artifactId, role, path: `${artifactId}.json`, mediaType: "application/json", content })),
  });
  return { manifest, methodsSummaryMarkdown, researchPackage };
}

/**
 * Development-only, pure v2 research workflow; no I/O or registry resolution.
 * Required: datasetInput (source text or JSON object), resolvedModel, runId,
 * createdAt (ISO timestamp), datasetVersion. applicationVersion defaults to 6.0.0
 * and other versions are rejected. contentHash defaults to SHA-256 of the exact
 * text; object input is canonicalized to NEW source text and any supplied hash
 * must match that text. The bundled legacy dataset/model restrictions still apply.
 *
 * Stage 4 scalar/optimizer options are supported with explicit saved defaults;
 * conflicting aliases and unsupported keys are rejected. growthComparison accepts
 * only {bounds, optimizer, crossValidation, bootstrap}; absent bounds use predeclared
 * engineering ranges b:[0,.3], A:[.001,1], r:[.001,4], c:[0,30]. Growth defaults:
 * 1 restart, population 8, DE 120, NM 80, tolerance 1e-7, objectiveTolerance 1e-12,
 * leave-one-training-trajectory-out CV/tieTolerance 1e-10, bootstrap 20/level .95.
 * Sobol: bootstrapReplicates 200, confidence .95, precisionTolerance .2; explicit
 * uint32 sobolBootstrapSeed or derived from the root seed. Root default 0x5e4c0ab1.
 * All remaining scalar defaults and fixed numerical rules are in replay.options.
 * Replay-supplied seeds/computationSettings must match the resolved rules exactly.
 *
 * runtime:{signal?,checkCancelled?,yieldControl?}, onProgress({phase,completed,total})
 * are execution-only, never serialized. Abort/true callback => ANALYSIS_CANCELLED;
 * host exceptions propagate. Cooperative yields occur between bounded legacy
 * phases and growth optimizer stages; a synchronous phase cannot be interrupted.
 * Growth progress is prefixed "growth:"; only the wrapper emits final "complete".
 *
 * Returns JSON-safe frozen legacy scientific fields plus growthComparison,
 * researchAssessment (completion/convergence/identification/precision separated),
 * manifest, methodsSummaryMarkdown and strict researchPackage. The package embeds
 * research-replay-input and scientific-result alongside the four audited snapshots.
 * Replay by passing researchPackage.contents.artifacts['research-replay-input'].options
 * back to this function; no metadata, seed, budget or default must be reconstructed.
 */
export async function runEcolabResearchWorkflow(input = {}) {
  record(input, "options", OPTION_KEYS);
  record(input.runtime ?? {}, "runtime", ["signal", "checkCancelled", "yieldControl"]);
  const runtime = researchWorkflowRuntime({ ...input, runtime: input.runtime ?? {} });
  runtime.check();
  const options = normalizeOptions(input);
  await runtime.checkpoint();
  const execution = { runtime: input.runtime ?? {} };
  const legacy = await runEcolabStage4ResearchWorkflow({
    ...options, ...execution,
    onProgress: (event) => { if (event.phase !== "complete") runtime.progress(event); },
  });
  await runtime.checkpoint();
  const growthComparison = await runGrowthModelComparison({
    dataset: legacy.researchPackage.contents.artifacts["normalized-observation-dataset"],
    split: legacy.split, developmentRole: "validation", seed: options.seeds.growthComparison,
    ...options.growthComparison, ...execution,
    onProgress: (event) => runtime.progress({ ...event, phase: `growth:${event.phase}` }),
  });
  const researchAssessment = assessResearch(legacy, growthComparison);
  const result = {
    ...legacy, kind: "ecolab-development-research-workflow", implementationId: RESEARCH_WORKFLOW_IMPLEMENTATION_ID,
    seeds: { algorithm: RNG_ALGORITHM, ...options.seeds }, growthComparison, researchAssessment,
    warnings: retainedWarnings(legacy, growthComparison, researchAssessment, options),
  };
  await runtime.checkpoint();
  runtime.progress({ phase: "research_package", completed: 0, total: 1 });
  Object.assign(result, buildArtifacts(result, legacy, options));
  runtime.progress({ phase: "research_package", completed: 1, total: 1 });
  await runtime.checkpoint();
  runtime.progress({ phase: "complete", completed: 1, total: 1 });
  return freeze(result);
}
