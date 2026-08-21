import test from "node:test";
import assert from "node:assert/strict";
import { DATASET_IMPORT_LIMITS } from "../../analysis/index.js";
import { MemoryProjectRepository } from "../persistence.js";
import {
  buildCompletedAnalysisRecord,
  createResearchController,
  selectRestorableResearch,
} from "../research/controller.js";
import {
  TEST_HASH,
  createCatalogFixture,
  createDatasetRecord,
  createResearchResult,
} from "./research-test-fixtures.js";

function createAppStub() {
  return {
    nodes: new Map(),
    querySelector(selector) {
      return this.nodes.get(selector) ?? null;
    },
  };
}

function deferredHandle() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const handle = {
    promise,
    cancelCalls: 0,
    cancel() {
      this.cancelCalls += 1;
      const error = new Error("cancelled");
      error.code = "TASK_CANCELLED";
      reject(error);
      return true;
    },
  };
  return { handle, resolve, reject };
}

function createHarness(options = {}) {
  const catalog = createCatalogFixture();
  const repository = options.repository ?? new MemoryProjectRepository();
  const app = createAppStub();
  const statuses = [];
  const downloads = [];
  const focusRequests = [];
  let renderCount = 0;
  let taskClientFactoryCalls = 0;
  const queuedRuns = options.queuedRuns ?? [];
  const taskCalls = [];
  const taskClient = {
    run(kind, payload, runOptions = {}) {
      taskCalls.push({ kind, payload, runOptions });
      const queued = queuedRuns.shift();
      if (!queued) throw new Error(`No queued task for ${kind}`);
      return queued.handle;
    },
    close() {},
  };
  const controller = createResearchController({
    app,
    catalog,
    repository,
    applicationVersion: "4.0.0",
    downloadText(text, name, type) { downloads.push({ text, name, type }); },
    t(key, params = {}) {
      return Object.entries(params).reduce(
        (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
        key,
      );
    },
    getLocale: () => "en",
    requestRender() { renderCount += 1; },
    requestFocus(key) { focusRequests.push(key); },
    setStatus(status) { statuses.push(status); },
    taskClientFactory() {
      taskClientFactoryCalls += 1;
      return taskClient;
    },
    now: options.now ?? (() => new Date("2026-08-21T12:00:00.000Z")),
  });
  return {
    controller,
    repository,
    app,
    statuses,
    downloads,
    focusRequests,
    taskCalls,
    get renderCount() { return renderCount; },
    get taskClientFactoryCalls() { return taskClientFactoryCalls; },
  };
}

test("completed analysis records retain run metadata and exact dataset revision/hash references", () => {
  const datasetRecord = createDatasetRecord({ revision: 7 });
  const run = {
    runId: "run-1",
    createdAt: "2026-08-21T12:00:00.000Z",
    applicationVersion: "4.0.0",
    seed: 4,
    preset: "small",
  };
  const result = createResearchResult();
  const record = buildCompletedAnalysisRecord({
    run,
    datasetRecord,
    result,
    completedAt: "2026-08-21T12:05:00.000Z",
  });
  assert.equal(record.status, "completed");
  assert.equal(record.datasetRef.id, datasetRecord.id);
  assert.equal(record.datasetRef.revision, 7);
  assert.equal(record.datasetRef.contentHash, TEST_HASH);
  assert.equal(record.run.runId, "run-1");
  assert.equal(record.result, result);
});

test("restore selection ignores running records and requires a hash-linked dataset for the analysis result", () => {
  const dataset = createDatasetRecord();
  const completed = {
    id: "completed",
    status: "completed",
    updatedAt: "2026-08-21T12:00:00Z",
    datasetRef: { id: dataset.id, contentHash: dataset.contentHash },
    result: createResearchResult(),
  };
  const running = {
    id: "running",
    status: "running",
    updatedAt: "2026-08-22T12:00:00Z",
    datasetRef: { id: dataset.id, contentHash: dataset.contentHash },
    result: { partial: true },
  };
  assert.equal(selectRestorableResearch({ datasets: [dataset], analyses: [running, completed] }).analysis.id, "completed");
  const unlinked = selectRestorableResearch({
    datasets: [dataset],
    analyses: [{ ...completed, datasetRef: { id: "other", contentHash: "0".repeat(64) } }],
  });
  assert.equal(unlinked.dataset.id, dataset.id);
  assert.equal(unlinked.analysis, null);
});

test("dedicated workflow submission captures one run, updates progress DOM directly, persists only success, and saves idempotently", async () => {
  const workflow = deferredHandle();
  let nowCalls = 0;
  const harness = createHarness({
    queuedRuns: [workflow],
    now() {
      nowCalls += 1;
      return new Date("2026-08-21T12:00:00.000Z");
    },
  });
  await harness.controller.initialize();
  const dataset = await harness.repository.saveDataset(createDatasetRecord({ revision: 0 }));
  harness.controller.state.datasets = [dataset];
  harness.controller.state.selectedDataset = dataset;
  const progressNode = { value: 0 };
  const phaseNode = { textContent: "" };
  const valueNode = { textContent: "" };
  harness.app.nodes.set("#research-progress-bar", progressNode);
  harness.app.nodes.set("#research-progress-phase", phaseNode);
  harness.app.nodes.set("#research-progress-value", valueNode);

  await harness.controller.handleClick("research-run", { dataset: {} });
  assert.equal(harness.taskCalls.length, 1);
  assert.equal(harness.taskCalls[0].kind, "analysis.research-workflow");
  const options = harness.taskCalls[0].payload.options;
  assert.equal(options.datasetVersion, "1.0.0");
  assert.equal(options.contentHash, TEST_HASH);
  assert.equal(options.applicationVersion, "4.0.0");
  assert.equal(options.seed, harness.controller.state.seed);
  assert.equal(harness.taskCalls[0].runOptions.taskId, options.runId);

  harness.taskCalls[0].runOptions.onProgress({ phase: "training_fit", completed: 1, total: 4, fraction: 0.25 });
  assert.equal(progressNode.value, 0.25);
  assert.equal(phaseNode.textContent, "research.progress.training_fit");
  assert.equal(valueNode.textContent, "25%");

  workflow.resolve(createResearchResult({ reproducibility: { runId: options.runId } }));
  await workflow.handle.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.controller.state.running, false);
  assert.equal(harness.controller.state.activeSection, "results");
  assert.deepEqual(harness.focusRequests, ["research-section-heading-results"]);
  assert.equal((await harness.repository.listAnalyses()).length, 1);
  assert.equal(harness.controller.state.selectedAnalysis.datasetRef.revision, dataset.revision);
  assert.equal(harness.controller.state.selectedAnalysis.datasetRef.contentHash, TEST_HASH);
  const callsAfterCompletion = nowCalls;
  await harness.controller.save();
  assert.equal((await harness.repository.listAnalyses())[0].revision, 1);
  assert.equal((await harness.repository.listDatasets())[0].revision, 1);
  assert.equal(nowCalls, callsAfterCompletion);
});

test("cancellation delegates to TaskHandle.cancel and persists no partial completed record", async () => {
  const workflow = deferredHandle();
  const harness = createHarness({ queuedRuns: [workflow] });
  await harness.controller.initialize();
  const dataset = await harness.repository.saveDataset(createDatasetRecord({ revision: 0 }));
  harness.controller.state.datasets = [dataset];
  harness.controller.state.selectedDataset = dataset;

  await harness.controller.handleClick("research-run", { dataset: {} });
  assert.equal(harness.controller.cancelAnalysis(), true);
  assert.equal(harness.controller.state.cancelling, true);
  assert.equal(harness.controller.state.progress.phase, "cancelling");
  assert.equal(harness.controller.cancelAnalysis(), false);
  assert.equal(workflow.handle.cancelCalls, 1);
  await workflow.handle.promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workflow.handle.cancelCalls, 1);
  assert.equal(harness.controller.state.running, false);
  assert.equal(harness.controller.state.progress.phase, "cancelled");
  assert.equal((await harness.repository.listAnalyses()).length, 0);
});

test("oversized imports are rejected before reading the file or creating a task client", async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  let textCalls = 0;
  const file = {
    name: "too-large.csv",
    type: "text/csv",
    size: DATASET_IMPORT_LIMITS.blockBytes + 1,
    async text() {
      textCalls += 1;
      return "unexpected";
    },
  };

  assert.equal(await harness.controller.handleChange({ name: "research-dataset-file", files: [file] }), true);
  assert.equal(textCalls, 0);
  assert.equal(harness.taskClientFactoryCalls, 0);
  assert.equal(harness.taskCalls.length, 0);
  assert.match(harness.controller.state.datasetError, /research\.data\.fileTooLarge/);
});

test("selecting a different dataset clears an unrelated completed result", async () => {
  const repository = new MemoryProjectRepository();
  const first = await repository.saveDataset(createDatasetRecord({ revision: 0, updatedAt: "2026-08-20T00:00:00Z" }));
  const second = await repository.saveDataset(createDatasetRecord({
    id: "import:generic:bbbb",
    revision: 0,
    updatedAt: "2026-08-22T00:00:00Z",
    contentHash: "b".repeat(64),
    registryRef: null,
    workflowEligible: false,
    workflowIneligibilityReasons: ["Generic import."],
  }));
  await repository.saveAnalysis({
    id: "analysis-first",
    revision: 0,
    updatedAt: "2026-08-21T00:00:00Z",
    status: "completed",
    datasetRef: { id: first.id, revision: first.revision, contentHash: first.contentHash },
    result: createResearchResult(),
  });
  const harness = createHarness({ repository });
  await harness.controller.initialize();
  assert.equal(harness.controller.state.selectedDataset.id, first.id);
  assert.ok(harness.controller.state.result);

  await harness.controller.handleClick("research-select-dataset", { dataset: { id: second.id } });
  assert.equal(harness.controller.state.selectedDataset.id, second.id);
  assert.equal(harness.controller.state.selectedAnalysis, null);
  assert.equal(harness.controller.state.result, null);
});

test("route-specific export menu and actions disable result artifacts until completion", async () => {
  const harness = createHarness();
  await harness.controller.initialize();
  let menu = harness.controller.renderExportMenu();
  assert.match(menu, /research-export-manifest" disabled/);
  assert.match(menu, /research-export-dataset" disabled/);

  harness.controller.state.selectedDataset = createDatasetRecord();
  menu = harness.controller.renderExportMenu();
  assert.match(menu, /research-export-dataset" >/);
  assert.match(menu, /research-export-manifest" disabled/);

  harness.controller.state.result = createResearchResult();
  harness.controller.state.selectedValidationUnit = "validation-unit";
  menu = harness.controller.renderExportMenu();
  assert.doesNotMatch(menu, /research-export-manifest" disabled/);
  for (const action of [
    "research-export-manifest",
    "research-export-package",
    "research-export-dataset",
    "research-export-predictions",
    "research-export-methods",
    "research-export-svg",
  ]) {
    assert.equal(await harness.controller.handleClick(action, { dataset: {} }), true);
  }
  assert.equal(harness.downloads.length, 6);
  assert.deepEqual(harness.downloads.map(({ name }) => name.split(".").at(-1)), ["json", "json", "csv", "csv", "md", "svg"]);

  harness.controller.state.selectedDataset = createDatasetRecord({
    qualityReport: { ...createDatasetRecord().qualityReport, valid: false },
  });
  menu = harness.controller.renderExportMenu();
  for (const action of ["manifest", "package", "dataset", "predictions", "methods", "svg"]) {
    assert.match(menu, new RegExp(`research-export-${action}\\" disabled`));
  }
});
