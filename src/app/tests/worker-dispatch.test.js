import test from "node:test";
import assert from "node:assert/strict";
import {
  createSerializableEvaluator,
  dispatchTask,
  handleRunEnvelope,
} from "../workers/analysis-worker.js";
import { importObservationDataset } from "../../analysis/dataset-import.js";
import { assessDatasetQuality } from "../../analysis/dataset-quality.js";
import {
  createObservationDatasetEvaluator,
  createObservationPredictionEvaluator,
  createScalarSummaryEvaluator,
  evaluateObservationDataset,
} from "../../analysis/model-evaluator.js";
import { runParameterScan } from "../../analysis/parameter-scan.js";
import { runMonteCarlo } from "../../analysis/monte-carlo.js";
import { localSensitivity } from "../../analysis/sensitivity-local.js";
import { morrisSensitivity } from "../../analysis/sensitivity-morris.js";
import { sobolJansenSensitivity } from "../../analysis/sensitivity-sobol.js";
import { fitParameters } from "../../analysis/fitting.js";

const analysisApi = {
  importObservationDataset,
  assessDatasetQuality,
  createObservationDatasetEvaluator,
  createObservationPredictionEvaluator,
  createScalarSummaryEvaluator,
  evaluateObservationDataset,
  runParameterScan,
  runMonteCarlo,
  localSensitivity,
  morrisSensitivity,
  sobolJansenSensitivity,
  fitParameters,
};

function dispatch(task, context = {}) {
  return dispatchTask(task, { analysisApi, ...context });
}

function resolvedModel() {
  return {
    kind: "ResolvedModel",
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
      drugs: {
        ciprofloxacin: {
          zMicMgPerL: 1,
          hillKappa: 2,
          psiMinLog10PerHour: -1,
          paperBrothDilutionMicMgPerL: 1,
        },
      },
    },
    warnings: [],
  };
}

function observation(overrides = {}) {
  return {
    observationId: "o-0",
    seriesId: "series-a",
    independentUnitId: "unit-a",
    role: "training",
    timeHours: 0,
    drugId: "ciprofloxacin",
    concentrationMgPerL: 0,
    measurementType: "log10_cfu_per_ml",
    value: 6,
    censoring: "none",
    censoringBounds: null,
    replicate: "r1",
    conditions: {},
    ...overrides,
  };
}

function dataset() {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId: "worker-data", title: "Worker data" },
    observations: [
      observation(),
      observation({ observationId: "o-1", timeHours: 1 }),
    ],
  };
}

const modelOptions = {
  resolvedModel: resolvedModel(),
  initialStates: { "series-a": { log10PopulationDensity: 6 } },
  dataset: dataset(),
};

const parameterSpace = {
  parameters: [{
    name: "psiMaxLog10PerHour",
    lower: 0,
    upper: 2,
    rationale: "Worker test.",
  }],
};

test("serializable evaluator specs support built-ins and reject arbitrary callbacks", () => {
  const constant = createSerializableEvaluator({ kind: "constant", value: 4 });
  assert.equal(constant({}), 4);
  const parameter = createSerializableEvaluator({ kind: "parameter", parameter: "x" });
  assert.equal(parameter({ x: 3 }), 3);
  const linear = createSerializableEvaluator({
    kind: "linear-combination",
    offset: 1,
    terms: [
      { parameter: "x", coefficient: 2 },
      { parameter: "y", coefficient: -1 },
    ],
  });
  assert.equal(linear({ x: 3, y: 4 }), 3);
  const model = createSerializableEvaluator({
    kind: "observation-scalar-summary",
    options: { ...modelOptions, summary: { kind: "final_prediction", seriesId: "series-a" } },
  }, analysisApi);
  assert.ok(Number.isFinite(model({ psiMaxLog10PerHour: 0.4 })));
  assert.throws(
    () => createSerializableEvaluator({ kind: "javascript", source: "parameters.x" }),
    { code: "UNSUPPORTED_EVALUATOR_SPEC" },
  );
});

test("dataset.parse uses strict import followed by quality control", async () => {
  const progress = [];
  const result = await dispatch({
    kind: "dataset.parse",
    payload: { input: JSON.stringify(dataset()), options: { format: "json" } },
  }, { reportProgress: (...entry) => progress.push(entry) });
  assert.equal(result.format, "json");
  assert.equal(result.dataset.metadata.datasetId, "worker-data");
  assert.equal(result.qualityReport.valid, true);
  assert.deepEqual(progress.map(([phase, completed]) => [phase, completed]), [
    ["import", 0],
    ["import", 1],
    ["quality-check", 0],
    ["quality-check", 1],
  ]);
});

test("dataset quality and direct model evaluation dispatch pure APIs", async () => {
  const quality = await dispatch({
    kind: "dataset.quality-check",
    payload: { dataset: dataset() },
  });
  assert.equal(quality.valid, true);

  const evaluation = await dispatch({
    kind: "analysis.evaluate",
    payload: modelOptions,
  });
  assert.equal(evaluation.kind, "analysis-dataset-evaluation");
  assert.equal(evaluation.predictions.length, 2);

  const scalar = await dispatch({
    kind: "analysis.evaluate",
    payload: {
      evaluator: { kind: "linear-combination", offset: 1, terms: [{ parameter: "x", coefficient: 2 }] },
      parameters: { x: 3 },
    },
  });
  assert.equal(scalar, 7);
});

test("scan and Monte Carlo forward analysis progress with serializable evaluators", async () => {
  const scanProgress = [];
  const scan = await dispatch({
    kind: "analysis.parameter-scan",
    payload: {
      options: {
        parameterSpace,
        values: { psiMaxLog10PerHour: [0, 1, 2] },
      },
      evaluator: {
        kind: "linear-combination",
        offset: 1,
        terms: [{ parameter: "psiMaxLog10PerHour", coefficient: 2 }],
      },
    },
  }, { reportProgress: (...entry) => scanProgress.push(entry) });
  assert.deepEqual(scan.results.map((entry) => entry.value), [1, 3, 5]);
  assert.equal(scanProgress.at(-1)[0], "parameter-scan");
  assert.equal(scanProgress.at(-1)[1], 3);
  assert.equal(scanProgress.at(-1)[2], 3);

  const mcProgress = [];
  const monteCarlo = await dispatch({
    kind: "analysis.monte-carlo",
    payload: {
      options: {
        seed: 8,
        sampleCount: 5,
        distributions: {
          psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
        },
      },
      evaluator: { kind: "parameter", parameter: "psiMaxLog10PerHour" },
    },
  }, { reportProgress: (...entry) => mcProgress.push(entry) });
  assert.equal(monteCarlo.sampleCount, 5);
  assert.equal(monteCarlo.successCount, 5);
  assert.equal(mcProgress.at(-1)[0], "monte-carlo");
  assert.equal(mcProgress.at(-1)[1], 5);
});

test("local, Morris, and Sobol sensitivity support serializable scalar evaluators", async () => {
  const local = await dispatch({
    kind: "analysis.sensitivity-local",
    payload: {
      options: {
        parameterSpace,
        baseline: { psiMaxLog10PerHour: 1 },
        step: 1e-4,
      },
      evaluator: {
        kind: "linear-combination",
        terms: [{ parameter: "psiMaxLog10PerHour", coefficient: 3 }],
      },
    },
  });
  assert.ok(Math.abs(local.byParameter.psiMaxLog10PerHour.derivative - 3) < 1e-8);

  const morris = await dispatch({
    kind: "analysis.sensitivity-morris",
    payload: {
      options: { parameterSpace, trajectories: 4, levels: 4, seed: 12 },
      evaluator: {
        kind: "linear-combination",
        terms: [{ parameter: "psiMaxLog10PerHour", coefficient: 2 }],
      },
    },
  });
  assert.ok(Math.abs(morris.byParameter.psiMaxLog10PerHour.muStar - 2) < 1e-12);

  const sobol = await dispatch({
    kind: "analysis.sensitivity-sobol",
    payload: {
      options: {
        sampleCount: 200,
        seed: 7,
        distributions: {
          psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
        },
      },
      evaluator: { kind: "parameter", parameter: "psiMaxLog10PerHour" },
    },
  });
  assert.equal(sobol.kind, "sobol_jansen_sensitivity");
  assert.equal(sobol.evaluationCount, 600);
});

test("fit supports a serializable linear-observation predictor", async () => {
  const observations = [-1, 0, 1, 2].map((x, index) => ({
    id: `o${index}`,
    role: "training",
    independentUnitId: `u${index}`,
    x,
    value: 2.5 * x - 0.4,
    measurementType: "log10_cfu",
  }));
  const result = await dispatch({
    kind: "analysis.fit",
    payload: {
      options: {
        observations,
        parameterPolicy: "generic_test_adapter",
        parameterWhitelist: ["slope", "intercept"],
        bounds: { slope: [0, 5], intercept: [-2, 2] },
        seed: 42,
        restarts: 1,
        differentialEvolution: { maxEvaluations: 800, populationSize: 20 },
        nelderMead: { maxEvaluations: 300 },
      },
      evaluator: {
        kind: "linear-observation",
        interceptParameter: "intercept",
        terms: [{ parameter: "slope", observationField: "x" }],
      },
    },
  });
  assert.ok(Math.abs(result.fittedParameters.slope - 2.5) < 1e-4);
  assert.ok(Math.abs(result.fittedParameters.intercept + 0.4) < 1e-4);
});

test("callback-dependent tasks reject missing serializable specs clearly", async () => {
  await assert.rejects(
    dispatch({
      kind: "analysis.parameter-scan",
      payload: { parameterSpace, values: { psiMaxLog10PerHour: [1] } },
    }),
    (error) => error.code === "SERIALIZABLE_EVALUATOR_REQUIRED" && /cannot receive callback functions/.test(error.message),
  );
});

test("research workflow is called directly when exported and reports unavailable otherwise", async () => {
  const progress = [];
  const result = await dispatch({
    kind: "analysis.research-workflow",
    payload: { options: { runId: "workflow-1" } },
  }, {
    analysisApi: {
      async runResearchWorkflow(options) {
        options.onProgress({ phase: "fit", completed: 1, total: 2, note: "half" });
        return { kind: "research-workflow", runId: options.runId };
      },
    },
    reportProgress: (...entry) => progress.push(entry),
  });
  assert.deepEqual(result, { kind: "research-workflow", runId: "workflow-1" });
  assert.equal(progress.some(([phase]) => phase === "fit"), true);

  await assert.rejects(
    dispatch({ kind: "analysis.research-workflow", payload: {} }, { analysisApi: {} }),
    { code: "RESEARCH_WORKFLOW_UNAVAILABLE" },
  );
});

test("run-envelope handler emits validated progress/result and serialized error messages", async () => {
  const messages = [];
  await handleRunEnvelope({
    type: "run",
    taskId: "evaluate-1",
    task: {
      kind: "analysis.evaluate",
      payload: { evaluator: { kind: "constant", value: 9 }, parameters: {} },
    },
  }, (message) => messages.push(message), { analysisApi });
  assert.deepEqual(messages.map(({ type }) => type), ["progress", "progress", "result"]);
  assert.equal(messages.at(-1).result, 9);

  const failures = [];
  await handleRunEnvelope({
    type: "run",
    taskId: "bad-1",
    task: { kind: "analysis.parameter-scan", payload: {} },
  }, (message) => failures.push(message), { analysisApi });
  assert.deepEqual(failures.map(({ type }) => type), ["progress", "error"]);
  assert.equal(failures.at(-1).error.code, "SERIALIZABLE_EVALUATOR_REQUIRED");
  assert.equal(Object.hasOwn(failures.at(-1).error, "stack"), false);
});
