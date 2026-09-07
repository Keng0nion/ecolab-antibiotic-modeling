export const RESEARCH_SECTIONS = Object.freeze(["data", "design", "analysis", "results"]);

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const RESEARCH_PRESETS = deepFreeze({
  small: Object.freeze({
    optimizer: Object.freeze({
      restarts: 1,
      populationSize: 8,
      differentialEvolutionMaxEvaluations: 80,
      nelderMeadMaxEvaluations: 80,
    }),
    scanPointsPerAxis: 3,
    monteCarloSamples: 8,
    morrisTrajectories: 2,
    morrisLevels: 4,
    sobolSamples: 8,
    sobolBootstrapReplicates: 40,
    sobolConfidenceLevel: 0.95,
    sobolPrecisionTolerance: 0.2,
    growthComparison: {
      bounds: { baselineOd: [0, 0.3], amplitudeOd: [0.001, 1], ratePerHour: [0.001, 4], timingHours: [0, 30] },
      optimizer: {
        restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 120,
        nelderMeadMaxEvaluations: 80, tolerance: 1e-7, objectiveTolerance: 1e-12,
      },
      crossValidation: { tieTolerance: 1e-10 },
      bootstrap: { samples: 20, intervalLevel: 0.95 },
    },
    identifiabilityProfilePoints: 3,
    returnedMonteCarloSamples: 8,
  }),
  standard: Object.freeze({
    optimizer: Object.freeze({
      restarts: 1,
      populationSize: 12,
      differentialEvolutionMaxEvaluations: 300,
      nelderMeadMaxEvaluations: 200,
    }),
    scanPointsPerAxis: 5,
    monteCarloSamples: 128,
    morrisTrajectories: 8,
    morrisLevels: 4,
    sobolSamples: 64,
    sobolBootstrapReplicates: 200,
    sobolConfidenceLevel: 0.95,
    sobolPrecisionTolerance: 0.2,
    growthComparison: {
      bounds: { baselineOd: [0, 0.3], amplitudeOd: [0.001, 1], ratePerHour: [0.001, 4], timingHours: [0, 30] },
      optimizer: {
        restarts: 1, populationSize: 12, differentialEvolutionMaxEvaluations: 1200,
        nelderMeadMaxEvaluations: 800, tolerance: 1e-7, objectiveTolerance: 1e-12,
      },
      crossValidation: { tieTolerance: 1e-10 },
      bootstrap: { samples: 100, intervalLevel: 0.95 },
    },
    identifiabilityProfilePoints: 5,
    returnedMonteCarloSamples: 32,
  }),
});

export function routeFromHashValue(hash) {
  if (hash === "#/sandbox") return "sandbox";
  if (hash === "#/research") return "research";
  return "learn";
}

export function createResearchState() {
  return {
    activeSection: "data",
    seed: 0x5e4c0ab1,
    preset: "small",
    csvMetadata: {
      datasetId: "",
      title: "",
      license: "",
    },
    datasets: [],
    analyses: [],
    selectedDataset: null,
    selectedAnalysis: null,
    result: null,
    replayPreview: null,
    packageOperation: null,
    packageCancelling: false,
    packageError: null,
    packageProgress: { phase: "idle", fraction: 0 },
    selectedValidationUnit: null,
    busy: false,
    running: false,
    currentRun: null,
    progress: {
      phase: "idle",
      completed: 0,
      total: 1,
      fraction: 0,
    },
    datasetError: null,
    analysisError: null,
    lastImport: null,
  };
}

export function setResearchSection(state, section) {
  if (!RESEARCH_SECTIONS.includes(section)) {
    throw new RangeError(`Unknown Research section: ${String(section)}.`);
  }
  state.activeSection = section;
  return state;
}

export function normalizeResearchSeed(value) {
  const seed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    throw new RangeError("Research seed must be an unsigned 32-bit integer.");
  }
  return seed >>> 0;
}

export function researchPreset(name) {
  const preset = RESEARCH_PRESETS[name];
  if (!preset) throw new RangeError(`Unknown Research compute preset: ${String(name)}.`);
  return structuredClone(preset);
}

export function researchEvaluationRole(result) {
  return result?.kind === "ecolab-development-research-workflow" || result?.validation?.role === "development_comparison"
    ? "development" : "validation";
}

export function researchSensitivityRows(result) {
  const sensitivity = result?.analyses?.sensitivity ?? {};
  const output = result?.analyses?.scalarOutput?.name;
  const local = sensitivity.local?.byParameter ?? {};
  const morris = sensitivity.morris?.byParameter ?? {};
  const sobol = sensitivity.sobolJansen?.byParameter ?? {};
  const scalar = (entry) => entry?.outputs?.[output] ?? entry ?? {};
  return [...new Set([...Object.keys(local), ...Object.keys(morris), ...Object.keys(sobol)])].map((name) => ({
    name, local: scalar(local[name]).derivative,
    morris: scalar(morris[name]), sobol: scalar(sobol[name]),
  }));
}

export function isCompletedAnalysis(record) {
  return Boolean(record && record.status === "completed" && record.result);
}

export function newestCompletedAnalysis(records) {
  return [...records]
    .filter(isCompletedAnalysis)
    .sort((left, right) => String(right.updatedAt ?? right.completedAt ?? "")
      .localeCompare(String(left.updatedAt ?? left.completedAt ?? "")))[0] ?? null;
}

export function captureResearchRun({ dataset, seed, preset, applicationVersion, now = () => new Date() }) {
  if (!dataset?.contentHash || !dataset?.datasetVersion) {
    throw new TypeError("A versioned, hashed dataset is required to capture a Research run.");
  }
  const dateValue = now();
  const date = dateValue instanceof Date ? dateValue : new Date(dateValue);
  if (!Number.isFinite(date.getTime())) throw new TypeError("Research run timestamp is invalid.");
  const createdAt = date.toISOString();
  const normalizedSeed = normalizeResearchSeed(seed);
  const safeDatasetId = String(dataset.normalizedDataset?.metadata?.datasetId ?? dataset.id)
    .replace(/[^a-zA-Z0-9._-]+/g, "-");
  const runId = `research-v2-${safeDatasetId}-${dataset.contentHash.slice(0, 12)}-${normalizedSeed}-${date.getTime()}`;
  return Object.freeze({
    runId,
    createdAt,
    applicationVersion,
    datasetVersion: dataset.datasetVersion,
    contentHash: dataset.contentHash,
    seed: normalizedSeed,
    preset,
  });
}

export function buildResearchWorkflowOptions({ run, dataset, resolvedModel }) {
  const budgets = researchPreset(run.preset);
  return {
    datasetInput: dataset.sourceText ?? dataset.normalizedDataset,
    resolvedModel,
    applicationVersion: run.applicationVersion,
    runId: run.runId,
    createdAt: run.createdAt,
    datasetVersion: run.datasetVersion,
    contentHash: run.contentHash,
    seed: run.seed,
    ...budgets,
  };
}
