export const TEST_HASH = "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817";

export function createNormalizedDataset(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: {
      datasetId: "figshare-bw25113-growth-v1",
      title: "Fixture OD600 dataset",
      license: "CC-BY-4.0",
      conditions: {
        organism: "Escherichia coli",
        strain: "BW25113",
        medium: { conditionId: "Cond00003" },
        temperatureC: 37,
      },
    },
    observations: [
      {
        observationId: "train-1",
        seriesId: "train-unit",
        independentUnitId: "train-unit",
        role: "training",
        timeHours: 0.5,
        drugId: "none",
        concentrationMgPerL: 0,
        measurementType: "od600",
        value: 0.08,
        censoring: "none",
        censoringBounds: null,
        replicate: "train-unit",
        conditions: {},
      },
      {
        observationId: "train-2",
        seriesId: "train-unit",
        independentUnitId: "train-unit",
        role: "training",
        timeHours: 1,
        drugId: "none",
        concentrationMgPerL: 0,
        measurementType: "od600",
        value: 0.1,
        censoring: "none",
        censoringBounds: null,
        replicate: "train-unit",
        conditions: {},
      },
      {
        observationId: "validation-1",
        seriesId: "validation-unit",
        independentUnitId: "validation-unit",
        role: "validation",
        timeHours: 0.5,
        drugId: "none",
        concentrationMgPerL: 0,
        measurementType: "od600",
        value: 0.09,
        censoring: "none",
        censoringBounds: null,
        replicate: "validation-unit",
        conditions: {},
      },
      {
        observationId: "validation-2",
        seriesId: "validation-unit",
        independentUnitId: "validation-unit",
        role: "validation",
        timeHours: 1,
        drugId: "none",
        concentrationMgPerL: 0,
        measurementType: "od600",
        value: 0.12,
        censoring: "none",
        censoringBounds: null,
        replicate: "validation-unit",
        conditions: {},
      },
    ],
    ...overrides,
  };
}

export function createQualityReport(overrides = {}) {
  return {
    valid: true,
    errors: [],
    warnings: [],
    info: [],
    summary: {
      observationCount: 4,
      independentUnitCount: 2,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      byRole: { training: 2, validation: 2 },
      byMeasurementType: { od600: 4 },
      byCensoring: { none: 4 },
    },
    ...overrides,
  };
}

export function createDatasetRecord(overrides = {}) {
  const normalizedDataset = overrides.normalizedDataset ?? createNormalizedDataset();
  return {
    id: "figshare-bw25113-growth-v1@1.0.0",
    revision: 3,
    updatedAt: "2026-08-21T10:00:00.000Z",
    datasetVersion: "1.0.0",
    title: normalizedDataset.metadata.title,
    license: normalizedDataset.metadata.license,
    sourceKind: "bundled",
    sourceFormat: "json",
    sourceText: JSON.stringify(normalizedDataset),
    normalizedDataset,
    contentHash: TEST_HASH,
    registryRef: "figshare-bw25113-growth-v1@1.0.0",
    integrityVerified: true,
    qualityReport: createQualityReport(),
    importWarnings: [],
    importStats: { rowCount: normalizedDataset.observations.length },
    workflowEligible: true,
    workflowIneligibilityReasons: [],
    ...overrides,
  };
}

function metrics(overrides = {}) {
  return {
    macroRmse: 0.02,
    pooledRmse: 0.021,
    mae: 0.015,
    meanResidual: -0.001,
    medianAbsoluteError: 0.013,
    ...overrides,
  };
}

export function createResearchResult(overrides = {}) {
  const result = {
    schemaVersion: "1.0.0",
    kind: "ecolab-stage4-real-data-research-workflow",
    dataset: {
      id: "figshare-bw25113-growth-v1",
      importWarnings: [],
      quality: createQualityReport(),
    },
    training: {
      role: "training_calibration",
      observationCount: 2,
      independentUnitCount: 1,
      fittedBiologicalParameters: {
        psiMaxLog10PerHour: 0.31,
        "initialStates.pooled.log10PopulationDensity": 6.1,
      },
      profiledObservationLayer: {
        baselineOd: 0.071,
        scaleOd: 0.33,
        profiledOnRole: "training",
        lockedBeforeValidation: true,
      },
      optimization: {
        evaluationCount: 42,
        terminationReason: "converged",
      },
      converged: true,
      metrics: metrics(),
      residualSummary: { rootMeanSquare: 0.018 },
    },
    validation: {
      role: "untouched_validation",
      observationCount: 2,
      independentUnits: {
        training: ["train-unit"],
        validation: ["validation-unit"],
      },
      predictions: [0.085, 0.115],
      residuals: [
        { kind: "point", observed: 0.09, predicted: 0.085, residual: 0.005 },
        { kind: "point", observed: 0.12, predicted: 0.115, residual: 0.005 },
      ],
      metrics: {
        ...metrics({ pooledRmse: 0.005, macroRmse: 0.005 }),
        baselineComparison: {
          baselineId: "training-unit-mean-od-by-exact-source-time",
          predeclared: true,
          baselineMetrics: metrics({ pooledRmse: 0.03, macroRmse: 0.03 }),
          delta: { pooledRmse: -0.025, macroRmse: -0.025 },
        },
      },
      eligibleForL4: false,
      l4IneligibilityReason: "Source plate/well independence is incompletely documented.",
    },
    identifiability: {
      parameterNames: ["psiMaxLog10PerHour", "initialStates.pooled.log10PopulationDensity"],
      rank: 2,
      conditionNumber: 12.4,
      correlations: [{ parameters: ["psiMaxLog10PerHour", "initialStates.pooled.log10PopulationDensity"], correlation: -0.91 }],
      warnings: [{ code: "STRONG_PARAMETER_CORRELATION", severity: "warning", message: "Fixture correlation warning." }],
    },
    analyses: {
      scalarOutput: { name: "predictedOdAt10Hours", timeHours: 10 },
      parameterScan: {
        warnings: [],
        results: [
          { status: "ok", parameters: { psiMaxLog10PerHour: 0.2, "initialStates.pooled.log10PopulationDensity": 5.8 }, value: 0.2 },
          { status: "ok", parameters: { psiMaxLog10PerHour: 0.3, "initialStates.pooled.log10PopulationDensity": 5.8 }, value: 0.27 },
          { status: "ok", parameters: { psiMaxLog10PerHour: 0.2, "initialStates.pooled.log10PopulationDensity": 6.2 }, value: 0.3 },
          { status: "ok", parameters: { psiMaxLog10PerHour: 0.3, "initialStates.pooled.log10PopulationDensity": 6.2 }, value: 0.38 },
        ],
      },
      monteCarlo: {
        warnings: [],
        summaries: {
          predictedOdAt10Hours: {
            quantiles: { "0.025": 0.22, "0.5": 0.3, "0.975": 0.39 },
          },
        },
      },
      sensitivity: {
        local: {
          byParameter: {
            psiMaxLog10PerHour: { derivative: 0.8 },
            "initialStates.pooled.log10PopulationDensity": { derivative: 0.2 },
          },
        },
        morris: {
          byParameter: {
            psiMaxLog10PerHour: { muStar: 0.7 },
            "initialStates.pooled.log10PopulationDensity": { muStar: 0.25 },
          },
        },
        sobolJansen: {
          byParameter: {
            psiMaxLog10PerHour: { firstOrder: 0.62, totalOrder: 0.71 },
            "initialStates.pooled.log10PopulationDensity": { firstOrder: 0.2, totalOrder: 0.3 },
          },
        },
      },
    },
    capability: {
      level: "L3",
      gates: [{ level: "L4", passed: false, code: "L4_VALIDATION_EVIDENCE_INSUFFICIENT", message: "Independent-unit documentation is incomplete." }],
      warnings: [],
    },
    warnings: [{ code: "RAW_OD_ABSOLUTE_SCALE_NOT_IDENTIFIED", severity: "warning", message: "Raw OD600 does not identify absolute CFU scale." }],
    reproducibility: {
      runId: "stage4-fixture-run",
      createdAt: "2026-08-21T10:10:00.000Z",
      applicationVersion: "4.0.0",
      datasetVersion: "1.0.0",
      sourceContentHash: TEST_HASH,
    },
    manifest: { runId: "stage4-fixture-run", capabilityAssessment: { level: "L3" } },
    researchPackage: { kind: "ecolab.research-package", contents: { analysisManifest: { runId: "stage4-fixture-run" } } },
    methodsSummaryMarkdown: "# Methods\n\nLocked training and validation workflow.",
  };
  return { ...result, ...overrides };
}

export function createCatalogFixture() {
  return {
    datasetRegistry: {
      records: [{
        id: "figshare-bw25113-growth-v1",
        version: "1.0.0",
        bundled: true,
        strain: "BW25113",
        paths: { normalizedJson: "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json" },
        artifactIntegrity: { normalizedDataSha256: TEST_HASH },
      }],
    },
    sourceRegistry: {
      records: [{
        id: "figshare-bw25113-growth-v1",
        version: "1.0.0",
        url: "https://figshare.com/articles/dataset/example/28342064",
        doi: "10.6084/m9.figshare.28342064.v1",
        articleDoi: "10.1038/s41597-025-05356-3",
        attribution: "Fixture attribution",
      }],
    },
    resolvedModel: {
      ref: {
        id: "ecolab.single-population.regoes-logistic",
        version: "1.0.0",
        implementationId: "regoes-logistic-piecewise-analytic-v1",
        parameterSetId: "base",
        parameterSetVersion: "1.0.0",
      },
      parameters: {
        psiMaxLog10PerHour: 0.3,
        carryingCapacityLog10CfuPerMl: 9,
        drugs: {},
      },
      parameterSet: {
        conditions: {
          target: {
            strain: "BW25113",
            medium: "M9 salts + 0.1% casamino acids + 0.2% glucose",
          },
        },
      },
    },
  };
}
