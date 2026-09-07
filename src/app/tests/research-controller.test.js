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
    applicationVersion: "6.0.0",
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

test("restore selection ignores running records and requires an id/revision/hash-linked dataset for the analysis result", () => {
  const dataset = createDatasetRecord();
  const completed = {
    id: "completed",
    status: "completed",
    updatedAt: "2026-08-21T12:00:00Z",
    datasetRef: { id: dataset.id, revision: dataset.revision, contentHash: dataset.contentHash },
    result: createResearchResult(),
  };
  const running = {
    id: "running",
    status: "running",
    updatedAt: "2026-08-22T12:00:00Z",
    datasetRef: { id: dataset.id, revision: dataset.revision, contentHash: dataset.contentHash },
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

function completedForDataset(dataset, overrides = {}) {
  return {
    id: "stored-analysis",
    revision: 0,
    status: "completed",
    updatedAt: "2026-08-21T12:00:00Z",
    datasetRef: { id: dataset.id, revision: dataset.revision, contentHash: dataset.contentHash },
    result: createResearchResult(),
    ...overrides,
  };
}

for (const field of ["id", "revision", "contentHash"]) {
  test(`automatic restoration cannot match an absent ${field} on both sides`, () => {
    const dataset = createDatasetRecord();
    const analysis = completedForDataset(dataset);
    delete dataset[field];
    delete analysis.datasetRef[field];
    assert.equal(selectRestorableResearch({ datasets: [dataset], analyses: [analysis] }).analysis, null);
  });
}

const DATASET_REFERENCE_MISMATCHES = [
  ["id", { id: "other-dataset" }],
  ["revision", { revision: 99 }],
  ["hash", { contentHash: "0".repeat(64) }],
  ["missing revision", { revision: undefined }],
];

for (const [field, mismatch] of DATASET_REFERENCE_MISMATCHES) {
  test(`automatic restoration refuses a dataset reference with ${field} mismatch`, () => {
    const dataset = createDatasetRecord();
    const analysis = completedForDataset(dataset);
    Object.assign(analysis.datasetRef, mismatch);
    const restored = selectRestorableResearch({ datasets: [dataset], analyses: [analysis] });
    assert.equal(restored.dataset, dataset);
    assert.equal(restored.analysis, null);
  });

  for (const action of ["initialize", "restore", "refreshRecords", "attach", "manual-cached", "manual-loaded"]) {
    test(`${action} requires matching dataset ${field} before restoring results`, async () => {
      const repository = new MemoryProjectRepository();
      const dataset = await repository.saveDataset(createDatasetRecord({ revision: 0 }));
      const analysis = completedForDataset(dataset);
      Object.assign(analysis.datasetRef, mismatch);
      const savedAnalysis = await repository.saveAnalysis(analysis);
      const harness = createHarness({ repository });
      const { controller } = harness;
      if (action === "initialize" || action === "restore") {
        await controller[action]();
      } else {
        controller.state.datasets = action === "manual-loaded" ? [] : [dataset];
        controller.state.analyses = action === "manual-loaded" ? [] : [savedAnalysis];
        if (action === "refreshRecords") {
          controller.state.selectedDataset = dataset;
          controller.state.selectedAnalysis = savedAnalysis;
          controller.state.result = savedAnalysis.result;
          await controller.refreshRecords();
        } else if (action === "attach") {
          await controller.handleClick("research-select-dataset", { dataset: { id: dataset.id } });
        } else {
          await assert.rejects(
            controller.handleClick("research-select-analysis", { dataset: { id: savedAnalysis.id } }),
            /research\.analysis\.datasetUnavailable/,
          );
        }
      }
      assert.equal(controller.state.selectedAnalysis, null);
      assert.equal(controller.state.result, null);
      assert.deepEqual(harness.focusRequests, []);
    });
  }
}

for (const action of ["initialize", "restore", "refreshRecords", "attach", "manual-cached", "manual-loaded"]) {
  test(`${action} restores a completed result with an exact dataset reference`, async () => {
    const repository = new MemoryProjectRepository();
    const dataset = await repository.saveDataset(createDatasetRecord({ revision: 0 }));
    const analysis = await repository.saveAnalysis(completedForDataset(dataset));
    const { controller } = createHarness({ repository });
    if (action === "initialize" || action === "restore") {
      await controller[action]();
    } else {
      controller.state.datasets = action === "manual-loaded" ? [] : [dataset];
      controller.state.analyses = action === "manual-loaded" ? [] : [analysis];
      if (action === "refreshRecords") {
        controller.state.selectedDataset = dataset;
        controller.state.selectedAnalysis = analysis;
        await controller.refreshRecords();
      } else if (action === "attach") {
        await controller.handleClick("research-select-dataset", { dataset: { id: dataset.id } });
      } else {
        await controller.handleClick("research-select-analysis", { dataset: { id: analysis.id } });
      }
    }
    assert.deepEqual(controller.state.selectedDataset, dataset);
    assert.deepEqual(controller.state.selectedAnalysis, analysis);
    assert.deepEqual(controller.state.result, analysis.result);
  });
}

test("refresh clears restored results when the dataset revision changes without a content change", async () => {
  const repository = new MemoryProjectRepository();
  const dataset = await repository.saveDataset(createDatasetRecord({ revision: 0 }));
  await repository.saveAnalysis(completedForDataset(dataset));
  const { controller } = createHarness({ repository });
  await controller.initialize();
  assert.ok(controller.state.result);
  const updated = await repository.saveDataset({ ...dataset, title: "Updated metadata" });
  assert.equal(updated.contentHash, dataset.contentHash);
  await controller.enter();
  assert.equal(controller.state.selectedDataset.revision, updated.revision);
  assert.equal(controller.state.selectedAnalysis, null);
  assert.equal(controller.state.result, null);
});

test("manual restoration validates the identity of a repository-loaded dataset", async () => {
  const dataset = createDatasetRecord();
  const analysis = completedForDataset(dataset);
  const repository = {
    async loadAnalysis() { return analysis; },
    async loadDataset() { return { ...dataset, id: "different-id" }; },
  };
  const { controller } = createHarness({ repository });
  await assert.rejects(
    controller.handleClick("research-select-analysis", { dataset: { id: analysis.id } }),
    /research\.analysis\.datasetUnavailable/,
  );
  assert.equal(controller.state.result, null);
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
  assert.equal(options.applicationVersion, "6.0.0");
    assert.match(options.runId, /^research-v2-/);
    assert.equal(options.growthComparison?.bootstrap.samples, 20);
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

function inspectedPackage(overrides = {}) {
  return {
    replayable: true, status: "replayable", reasons: [],
    researchPackage: { packageId: "imported-package", contents: { analysisManifest: {
      runId: "imported-run", versions: { application: "6.0.0", core: "2.0.0", analysis: "2.0.0" },
      dataset: { id: "not-the-selected-source" },
    } } },
    ...overrides,
  };
}


const settleTasks = () => new Promise((resolve) => setImmediate(resolve));

async function withExistingAnalysis(queuedRuns = []) {
  const harness = createHarness({ queuedRuns });
  const dataset = await harness.repository.saveDataset(createDatasetRecord({ revision: 0 }));
  await harness.repository.saveAnalysis(completedForDataset(dataset));
  await harness.controller.initialize();
  return harness;
}

test("package size is rejected before text() or task client creation, leaving existing analysis intact", async () => {
  const harness = await withExistingAnalysis();
  const before = structuredClone(harness.controller.state.result);
  let reads = 0;
  assert.equal(await harness.controller.handleChange({ name: "research-package-file", files: [{
    name: "large.json", size: 32 * 1024 * 1024 + 1, async text() { reads++; return "{}"; },
  }] }), true);
  assert.equal(reads, 0);
  assert.equal(harness.taskClientFactoryCalls, 0);
  assert.match(harness.controller.state.packageError, /research\.package\.tooLarge/);
  assert.deepEqual(harness.controller.state.result, before);
});

test("package import only inspects raw text in a Worker; an explicit replay creates an isolated unsaved preview", async () => {
  const inspection = deferredHandle();
  const replay = deferredHandle();
  const harness = await withExistingAnalysis([inspection, replay]);
  const before = structuredClone({ dataset: harness.controller.state.selectedDataset, analysis: harness.controller.state.selectedAnalysis });
  const input = '{ "package": "raw source" }';
  const importing = harness.controller.handleChange({ name: "research-package-file", files: [{ name: "package.json", size: 32 * 1024 * 1024, text: async () => input }] });
  await settleTasks();
  assert.deepEqual(harness.taskCalls.map(({ kind, payload }) => ({ kind, payload })), [{ kind: "research.package-inspect", payload: { input } }]);
  inspection.resolve(inspectedPackage());
  await importing;
  assert.equal(harness.taskCalls.length, 1);
  assert.equal(harness.controller.state.replayPreview.researchPackage.contents.analysisManifest.runId, "imported-run");
  assert.equal(harness.controller.state.replayPreview.result, null);
  assert.equal(harness.controller.state.replayPreview.matched, null);
  assert.equal(await harness.controller.handleClick("research-package-replay", {}), true);
  assert.equal(harness.taskCalls[1].kind, "research.package-replay");
  assert.deepEqual(harness.taskCalls[1].payload, { input });
  const comparison = { mismatchCount: 1, mismatchPaths: ["$.training.metrics.macroRmse"], absoluteTolerance: 1e-10, relativeTolerance: 1e-8, truncated: false };
  const result = createResearchResult({ reproducibility: { runId: "imported-run" } });
  replay.resolve({ matched: false, comparison, result });
  await settleTasks();
  assert.equal(harness.controller.state.replayPreview.matched, false);
  assert.equal(harness.controller.state.replayPreview.status, "mismatch");
  assert.deepEqual(harness.controller.state.replayPreview.comparison, comparison);
  assert.equal(harness.controller.state.replayPreview.result, result);
  assert.deepEqual(harness.controller.state.selectedDataset, before.dataset);
  assert.deepEqual(harness.controller.state.selectedAnalysis, before.analysis);
  assert.deepEqual(harness.controller.state.result, before.analysis.result);
  await harness.controller.save();
  assert.equal((await harness.repository.listAnalyses()).length, 1);
  assert.equal((await harness.repository.listDatasets()).length, 1);
  const restored = createHarness({ repository: harness.repository });
  await restored.controller.initialize();
  assert.equal(restored.controller.state.replayPreview, null);
});

for (const code of ["MISSING_REPLAY_INPUT", "UNSUPPORTED_SOFTWARE_VERSION"]) {
  test(`inspect-only ${code} packages cannot execute, even through a direct action`, async () => {
    const inspection = deferredHandle();
    const harness = createHarness({ queuedRuns: [inspection] });
    inspection.resolve(inspectedPackage({ replayable: false, status: "inspect_only", reasons: [{ code, message: "Inspection only." }] }));
    assert.equal(await harness.controller.handleChange({ name: "research-package-file", files: [{ name: "legacy.json", size: 2, text: async () => "{}" }] }), true);
    await harness.controller.handleClick("research-package-replay", {});
    assert.equal(harness.taskCalls.length, 1);
    assert.equal(harness.controller.state.replayPreview.status, "inspect_only");
    assert.equal(harness.controller.state.replayPreview.reasons[0].code, code);
  });
}

for (const phase of ["inspect", "replay"]) {
  for (const outcome of ["cancel", "error"]) {
    test(`package ${phase} ${outcome} preserves existing results and saves no partial record`, async () => {
      const inspection = deferredHandle();
      const replay = deferredHandle();
      const harness = await withExistingAnalysis([inspection, replay]);
      const before = structuredClone(harness.controller.state.result);
      const importing = harness.controller.handleChange({ name: "research-package-file", files: [{ name: "package.json", size: 2, text: async () => "{}" }] });
      await settleTasks();
      let task = inspection;
      if (phase === "replay") {
        inspection.resolve(inspectedPackage());
        await importing;
        await harness.controller.handleClick("research-package-replay", {});
        task = replay;
      }
      if (outcome === "cancel") {
        assert.equal(await harness.controller.handleClick("research-package-cancel", {}), true);
        assert.equal(task.handle.cancelCalls, 1);
        await harness.controller.handleClick("research-package-cancel", {});
        assert.equal(task.handle.cancelCalls, 1);
      } else task.reject(Object.assign(new Error("tampered or unavailable"), { code: "RESEARCH_PACKAGE_INTEGRITY", path: "$.artifactInventory" }));
      await importing;
      await settleTasks();
      assert.equal(harness.controller.state.packageOperation, null);
      assert.deepEqual(harness.controller.state.result, before);
      assert.equal(harness.controller.state.replayPreview?.result ?? null, null);
      assert.equal((await harness.repository.listAnalyses()).length, 1);
      if (outcome === "error") assert.match(harness.controller.state.packageError, /tampered or unavailable/);
    });
  }
}

test("cancel during package file reading ignores its late text without creating a Worker", async () => {
  const harness = createHarness();
  const reading = deferredHandle();
  const importing = harness.controller.handleChange({ name: "research-package-file", files: [{ name: "slow.json", size: 2, text: () => reading.handle.promise }] });
  assert.equal(await harness.controller.handleClick("research-package-cancel", {}), true);
  reading.resolve("{}");
  await importing;
  assert.equal(harness.taskClientFactoryCalls, 0);
  assert.equal(harness.controller.state.replayPreview, null);
});

test("failed workflow keeps previous analysis, including synchronous task submission failure", async () => {
  const harness = await withExistingAnalysis();
  const before = structuredClone(harness.controller.state.result);
  await harness.controller.handleClick("research-run", {});
  await settleTasks();
  assert.equal(harness.controller.state.running, false);
  assert.match(harness.controller.state.analysisError, /No queued task/);
  assert.deepEqual(harness.controller.state.result, before);
});

test("matched replay stays isolated when the selected source changes during execution", async () => {
  const inspection = deferredHandle();
  const replay = deferredHandle();
  const harness = await withExistingAnalysis([inspection, replay]);
  inspection.resolve(inspectedPackage());
  await harness.controller.handleChange({ name: "research-package-file", files: [{ name: "package.json", size: 2, text: async () => "{}" }] });
  await harness.controller.handleClick("research-package-replay", {});
  await harness.controller.handleClick("research-package-replay", {});
  assert.equal(harness.taskCalls.length, 2);
  const generic = await harness.repository.saveDataset(createDatasetRecord({ id: "own-source", revision: 0, contentHash: "c".repeat(64), workflowEligible: false, registryRef: null }));
  await harness.controller.handleClick("research-select-dataset", { dataset: { id: generic.id } });
  const comparison = { mismatchCount: 0, mismatchPaths: [], absoluteTolerance: 1e-10, relativeTolerance: 1e-8, truncated: false };
  replay.resolve({ matched: true, comparison, result: createResearchResult() });
  await settleTasks();
  assert.equal(harness.controller.state.replayPreview.status, "matched");
  assert.equal(harness.controller.state.selectedDataset.id, generic.id);
  assert.equal(harness.controller.state.result, null);
  assert.equal(harness.controller.state.selectedAnalysis, null);
  await harness.controller.save();
  assert.equal((await harness.repository.listAnalyses()).length, 1);
});

for (const phase of ["inspect", "replay", "workflow"]) {
  test(`cancelled ${phase} ignores a late successful response and returns to idle without persistence`, async () => {
    const task = deferredHandle();
    task.handle.cancel = function () { this.cancelCalls++; return true; };
    const harness = await withExistingAnalysis([task]);
    const before = structuredClone(harness.controller.state.result);
    let pending;
    if (phase === "inspect") {
      pending = harness.controller.handleChange({ name: "research-package-file", files: [{ name: "package.json", size: 2, text: async () => "{}" }] });
    } else if (phase === "replay") {
      harness.controller.state.replayPreview = { ...inspectedPackage(), input: "{}", result: null };
      await harness.controller.handleClick("research-package-replay", {});
    } else await harness.controller.handleClick("research-run", {});
    await settleTasks();
    await harness.controller.handleClick(phase === "workflow" ? "research-cancel" : "research-package-cancel", {});
    task.resolve(phase === "inspect" ? inspectedPackage() : phase === "replay" ? { matched: true, result: createResearchResult() } : createResearchResult());
    await pending;
    await settleTasks();
    assert.equal(harness.controller.state.running, false);
    assert.equal(harness.controller.state.packageOperation, null);
    assert.equal(harness.controller.state[phase === "workflow" ? "progress" : "packageProgress"].phase, "cancelled");
    assert.deepEqual(harness.controller.state.result, before);
    assert.equal(harness.controller.state.replayPreview?.result ?? null, null);
    assert.equal((await harness.repository.listAnalyses()).length, 1);
  });
}

for (const phase of ["inspect", "replay"]) {
  test(`disposing active package ${phase} cancels its handle and suppresses late results`, async () => {
    const task = deferredHandle();
    const harness = await withExistingAnalysis([task]);
    const before = structuredClone(harness.controller.state.result);
    let pending;
    if (phase === "inspect") pending = harness.controller.handleChange({ name: "research-package-file", files: [{ name: "package.json", size: 2, text: async () => "{}" }] });
    else {
      harness.controller.state.replayPreview = { ...inspectedPackage(), input: "{}", result: null };
      await harness.controller.handleClick("research-package-replay", {});
    }
    await settleTasks();
    harness.controller.dispose();
    await pending;
    await settleTasks();
    assert.equal(task.handle.cancelCalls, 1);
    assert.deepEqual(harness.controller.state.result, before);
    assert.equal(harness.controller.state.replayPreview?.result ?? null, null);
    assert.equal((await harness.repository.listAnalyses()).length, 1);
  });
}

test("direct run on an unavailable dataset is handled without creating a Worker or losing results", async () => {
  const harness = await withExistingAnalysis();
  const before = structuredClone(harness.controller.state.result);
  harness.controller.state.selectedDataset.workflowEligible = false;
  await harness.controller.handleClick("research-run", {});
  await settleTasks();
  assert.equal(harness.taskClientFactoryCalls, 0);
  assert.match(harness.controller.state.analysisError, /research\.analysis\.disabledReason/);
  assert.deepEqual(harness.controller.state.result, before);
});

test("asynchronous workflow failure retains the last completed analysis", async () => {
  const task = deferredHandle();
  const harness = await withExistingAnalysis([task]);
  const before = structuredClone(harness.controller.state.selectedAnalysis);
  await harness.controller.handleClick("research-run", {});
  task.reject(new Error("fit unavailable"));
  await settleTasks();
  assert.equal(harness.controller.state.running, false);
  assert.match(harness.controller.state.analysisError, /fit unavailable/);
  assert.deepEqual(harness.controller.state.selectedAnalysis, before);
  assert.equal((await harness.repository.listAnalyses()).length, 1);
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
