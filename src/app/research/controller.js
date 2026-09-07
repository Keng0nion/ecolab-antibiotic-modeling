import { DATASET_IMPORT_LIMITS, sha256Hex } from "../../analysis/index.js";
import { TaskClient } from "../workers/task-client.js";
import {
  assessWorkflowEligibility,
  buildDatasetRecord,
  bundledDatasetRecord,
  bundledDatasetSource,
  createGenericDatasetRecord,
  fetchBundledDatasetText,
  validateCsvMetadata,
} from "./dataset-loader.js";
import {
  analysisManifestJson,
  normalizedDatasetToCsv,
  predictionsMetricsToCsv,
  researchExportAvailability,
  researchMethodsText,
  researchPackageJson,
} from "./export.js";
import { renderResearchCharts, serializeResearchDashboard } from "./charts.js";
import {
  buildResearchWorkflowOptions,
  captureResearchRun,
  createResearchState,
  isCompletedAnalysis,
  newestCompletedAnalysis,
  normalizeResearchSeed,
  setResearchSection,
} from "./state.js";
import { renderResearchWorkspace } from "./view.js";

const RESEARCH_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value) {
  return String(value ?? "research")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "research";
}

function formatFromFile(file) {
  const name = String(file?.name ?? "").toLowerCase();
  if (name.endsWith(".csv") || file?.type === "text/csv") return "csv";
  if (name.endsWith(".json") || file?.type === "application/json") return "json";
  return "auto";
}

function mergeRecord(records, saved) {
  return [saved, ...records.filter((record) => record.id !== saved.id)]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

function progressKey(phase) {
  return String(phase || "idle").replace(/[-:]/g, "_");
}

export function buildCompletedAnalysisRecord({ run, datasetRecord, result, completedAt }) {
  return {
    id: run.runId,
    revision: 0,
    updatedAt: completedAt,
    completedAt,
    status: "completed",
    datasetRef: {
      id: datasetRecord.id,
      revision: datasetRecord.revision,
      datasetId: datasetRecord.normalizedDataset.metadata.datasetId,
      datasetVersion: datasetRecord.datasetVersion,
      contentHash: datasetRecord.contentHash,
    },
    run: {
      runId: run.runId,
      createdAt: run.createdAt,
      applicationVersion: run.applicationVersion,
      seed: run.seed,
      preset: run.preset,
    },
    result,
  };
}

function matchesAnalysisDataset(dataset, analysis) {
  return Boolean(dataset
    && typeof dataset.id === "string" && dataset.id.length > 0
    && Number.isInteger(dataset.revision) && dataset.revision >= 0
    && typeof dataset.contentHash === "string" && dataset.contentHash.length > 0
    && dataset.id === analysis?.datasetRef?.id
    && dataset.revision === analysis?.datasetRef?.revision
    && dataset.contentHash === analysis?.datasetRef?.contentHash);
}

export function selectRestorableResearch({ datasets, analyses }) {
  const analysis = newestCompletedAnalysis(analyses);
  const linkedDataset = analysis
    ? datasets.find((dataset) => matchesAnalysisDataset(dataset, analysis))
    : null;
  return {
    dataset: linkedDataset ?? datasets[0] ?? null,
    analysis: linkedDataset ? analysis : null,
  };
}

export function createResearchController(options) {
  const {
    app,
    catalog,
    repository,
    applicationVersion,
    downloadText,
    t,
    getLocale,
    requestRender,
    requestFocus = () => {},
    setStatus,
    fetchImpl = globalThis.fetch,
    hashImpl = sha256Hex,
    now = () => new Date(),
    taskClientFactory = null,
  } = options;
  const state = createResearchState();
  state.cancelling = false;
  const registryRecord = bundledDatasetRecord(catalog.datasetRegistry);
  const sourceRecord = bundledDatasetSource(catalog.sourceRegistry);
  const runtime = {
    taskClient: null,
    runTask: null,
    importTask: null,
    packageTask: null,
    disposed: false,
  };

  function client() {
    if (!runtime.taskClient) {
      runtime.taskClient = taskClientFactory
        ? taskClientFactory()
        : new TaskClient({
            maxConcurrency: 1,
            workerUrl: new URL("./research-worker.js", import.meta.url),
          });
    }
    return runtime.taskClient;
  }

  function notify(key, tone = "info", params = {}) {
    setStatus({ key, tone, params });
  }

  function render() {
    return renderResearchWorkspace({
      state,
      catalog,
      registryRecord,
      sourceRecord,
      t,
      locale: getLocale(),
    });
  }

  function afterRender() {
    if (state.activeSection !== "results" || !state.result || !state.selectedDataset) return;
    renderResearchCharts(app.querySelector("#research-chart-dashboard"), {
      dataset: state.selectedDataset.normalizedDataset,
      result: state.result,
      selectedValidationUnit: state.selectedValidationUnit,
      locale: getLocale(),
    });
  }

  async function refreshRecords({ preserveSelection = true } = {}) {
    const [datasets, analyses] = await Promise.all([
      repository.listDatasets(),
      repository.listAnalyses(),
    ]);
    state.datasets = datasets;
    state.analyses = analyses;
    if (preserveSelection && state.selectedDataset) {
      state.selectedDataset = datasets.find((record) => record.id === state.selectedDataset.id) ?? state.selectedDataset;
    }
    if (preserveSelection && state.selectedAnalysis) {
      const selected = analyses.find((record) => record.id === state.selectedAnalysis.id) ?? state.selectedAnalysis;
      const linked = datasets.find((dataset) => matchesAnalysisDataset(dataset, selected));
      if (isCompletedAnalysis(selected) && linked) {
        state.selectedAnalysis = selected;
        state.selectedDataset = linked;
        state.result = selected.result;
      } else {
        state.selectedAnalysis = null;
        state.result = null;
      }
    }
  }

  async function initialize() {
    await refreshRecords({ preserveSelection: false });
    const restored = selectRestorableResearch({ datasets: state.datasets, analyses: state.analyses });
    state.selectedDataset = restored.dataset;
    state.selectedAnalysis = restored.analysis;
    state.result = restored.analysis && restored.dataset ? restored.analysis.result : null;
    if (!state.result) state.selectedAnalysis = null;
    setDefaultValidationUnit();
  }

  async function enter() {
    await refreshRecords();
    requestRender();
  }

  function setDefaultValidationUnit() {
    const units = state.result?.validation?.independentUnits?.validation ?? [];
    if (!units.includes(state.selectedValidationUnit)) state.selectedValidationUnit = units[0] ?? null;
  }

  function attachDataset(record) {
    state.selectedDataset = record;
    const matching = state.analyses.find((analysis) => isCompletedAnalysis(analysis)
      && matchesAnalysisDataset(record, analysis));
    state.selectedAnalysis = matching ?? null;
    state.result = matching?.result ?? null;
    setDefaultValidationUnit();
  }

  async function persistDataset(record) {
    if (!record.qualityReport?.valid) return record;
    const current = state.datasets.find((candidate) => candidate.id === record.id);
    if (current?.contentHash === record.contentHash) {
      state.selectedDataset = current;
      return current;
    }
    const saved = await repository.saveDataset({
      ...record,
      revision: current?.revision ?? record.revision ?? 0,
      updatedAt: now().toISOString(),
    });
    state.datasets = mergeRecord(state.datasets, saved);
    state.selectedDataset = saved;
    return saved;
  }

  async function parseDataset(input, parseOptions) {
    const handle = client().run("dataset.parse", {
      input,
      options: parseOptions,
      qualityOptions: {
        keyConditionFields: ["organism", "strain", "medium", "temperatureC"],
      },
    });
    runtime.importTask = handle;
    try {
      return await handle.promise;
    } finally {
      if (runtime.importTask === handle) runtime.importTask = null;
    }
  }

  async function loadBundled() {
    state.busy = true;
    state.datasetError = null;
    requestRender();
    try {
      const verified = await fetchBundledDatasetText({ registryRecord, fetchImpl, hashImpl });
      const imported = await parseDataset(verified.text, { format: "json" });
      const record = buildDatasetRecord({
        imported,
        sourceText: verified.text,
        contentHash: verified.contentHash,
        sourceKind: "bundled",
        registryRecord,
        trustedBundledArtifact: true,
        updatedAt: now().toISOString(),
      });
      state.lastImport = imported;
      const selected = record.qualityReport.valid ? await persistDataset(record) : record;
      attachDataset(selected);
      notify(record.workflowEligible ? "research.status.datasetReady" : "research.status.datasetQcOnly", record.workflowEligible ? "success" : "warning");
    } catch (error) {
      state.datasetError = errorMessage(error);
      notify("research.status.datasetError", "danger", { message: state.datasetError });
    } finally {
      state.busy = false;
      requestRender();
    }
  }

  async function importFile(file) {
    if (!file) return;
    if (Number.isFinite(file.size) && file.size > DATASET_IMPORT_LIMITS.blockBytes) {
      state.datasetError = t("research.data.fileTooLarge", {
        maximum: Math.round(DATASET_IMPORT_LIMITS.blockBytes / (1024 * 1024)),
      });
      notify("research.status.datasetError", "danger", { message: state.datasetError });
      requestRender();
      return;
    }
    state.busy = true;
    state.datasetError = null;
    requestRender();
    try {
      const text = await file.text();
      const format = formatFromFile(file);
      const parseOptions = { format };
      if (format === "csv") parseOptions.datasetMetadata = validateCsvMetadata(state.csvMetadata);
      const imported = await parseDataset(text, parseOptions);
      const record = await createGenericDatasetRecord({
        imported,
        sourceText: text,
        sourceFormat: format,
        hashImpl,
        updatedAt: now().toISOString(),
      });
      const eligibility = assessWorkflowEligibility(record, { trustedBundledArtifact: false });
      record.workflowEligible = eligibility.eligible;
      record.workflowIneligibilityReasons = eligibility.reasons;
      state.lastImport = imported;
      const selected = record.qualityReport.valid ? await persistDataset(record) : record;
      attachDataset(selected);
      notify(record.qualityReport.valid ? "research.status.imported" : "research.status.qcFailed", record.qualityReport.valid ? "success" : "danger");
    } catch (error) {
      state.datasetError = errorMessage(error);
      notify("research.status.datasetError", "danger", { message: state.datasetError });
    } finally {
      state.busy = false;
      requestRender();
    }
  }

  function packageProgress(message) {
    if (!state.packageOperation || state.packageCancelling) return;
    const fraction = Number.isFinite(message.fraction) ? message.fraction
      : message.total > 0 ? message.completed / message.total : 0;
    state.packageProgress = { phase: progressKey(message.phase), fraction: Math.max(0, Math.min(1, fraction)) };
    const progress = app.querySelector("#research-package-progress");
    const phase = app.querySelector("#research-package-phase");
    if (progress) progress.value = state.packageProgress.fraction;
    if (phase) phase.textContent = t(`research.progress.${state.packageProgress.phase}`);
  }

  async function packageOperation(kind, { file, preview } = {}) {
    if (runtime.disposed || state.running || state.busy || state.packageOperation) return;
    if (file && Number.isFinite(file.size) && file.size > RESEARCH_PACKAGE_MAX_BYTES) {
      state.packageError = t("research.package.tooLarge", { maximum: 32 });
      requestRender();
      return;
    }
    const task = { handle: null, cancelled: false };
    runtime.packageTask = task;
    state.packageOperation = kind;
    state.packageCancelling = false;
    state.packageError = null;
    state.packageProgress = { phase: kind === "inspect" ? "package_read" : "replay_execute", fraction: 0 };
    requestRender();
    try {
      const input = file ? await file.text() : preview.input;
      if (runtime.packageTask !== task || task.cancelled || runtime.disposed) return;
      task.handle = client().run(`research.package-${kind}`, { input }, { onProgress: packageProgress });
      const response = await task.handle.promise;
      if (runtime.packageTask !== task || task.cancelled || runtime.disposed) return;
      if (kind === "inspect") {
        state.replayPreview = {
          input, fileName: file.name, researchPackage: response.researchPackage,
          replayable: response.replayable === true && response.status === "replayable",
          status: response.status, reasons: response.reasons,
          matched: null, comparison: null, result: null,
        };
      } else {
        state.replayPreview = {
          ...preview, matched: response.matched, comparison: response.comparison, result: response.result,
          status: response.matched === true ? "matched" : "mismatch",
        };
      }
      state.packageProgress = { phase: "complete", fraction: 1 };
    } catch (error) {
      if (runtime.packageTask !== task || runtime.disposed) return;
      if (task.cancelled || ["TASK_CANCELLED", "ANALYSIS_CANCELLED"].includes(error?.code)) {
        state.packageProgress = { phase: "cancelled", fraction: 0 };
      } else {
        state.packageError = [error?.code, errorMessage(error), error?.path].filter(Boolean).join(" · ");
        state.packageProgress = { phase: "failed", fraction: 0 };
      }
    } finally {
      if (runtime.packageTask === task) {
        runtime.packageTask = null;
        state.packageOperation = null;
        state.packageCancelling = false;
        if (task.cancelled) state.packageProgress = { phase: "cancelled", fraction: 0 };
        if (!runtime.disposed) requestRender();
      }
    }
  }

  function replayPackage() {
    const preview = state.replayPreview;
    if (!preview?.replayable || typeof preview.input !== "string") return;
    return packageOperation("replay", { preview });
  }

  function cancelPackage() {
    const task = runtime.packageTask;
    if (!task || task.cancelled) return false;
    task.cancelled = true;
    state.packageCancelling = true;
    state.packageProgress = { ...state.packageProgress, phase: "cancelling" };
    if (task.handle) task.handle.cancel();
    else {
      runtime.packageTask = null;
      state.packageOperation = null;
      state.packageCancelling = false;
      state.packageProgress = { phase: "cancelled", fraction: 0 };
    }
    requestRender();
    return true;
  }

  function updateProgress(message) {
    if (state.cancelling) return;
    const fraction = Number.isFinite(message.fraction)
      ? Math.max(0, Math.min(1, message.fraction))
      : message.total > 0
        ? Math.max(0, Math.min(1, message.completed / message.total))
        : 0;
    state.progress = {
      phase: progressKey(message.phase),
      completed: message.completed,
      total: message.total,
      fraction,
    };
    const progress = app.querySelector("#research-progress-bar");
    const phase = app.querySelector("#research-progress-phase");
    const value = app.querySelector("#research-progress-value");
    if (progress) progress.value = fraction;
    if (phase) phase.textContent = t(`research.progress.${state.progress.phase}`);
    if (value) value.textContent = `${Math.round(fraction * 100)}%`;
  }

  async function runAnalysis() {
    if (runtime.disposed || state.running || state.busy || state.packageOperation) return;
    const datasetRecord = state.selectedDataset;
    if (!datasetRecord?.workflowEligible || !datasetRecord.qualityReport?.valid) {
      state.analysisError = t("research.analysis.disabledReason");
      requestRender();
      return;
    }
    const run = captureResearchRun({
      dataset: datasetRecord,
      seed: state.seed,
      preset: state.preset,
      applicationVersion,
      now,
    });
    const payload = {
      options: buildResearchWorkflowOptions({
        run,
        dataset: datasetRecord,
        resolvedModel: catalog.resolvedModel,
      }),
    };
    state.running = true;
    state.cancelling = false;
    state.analysisError = null;
    state.currentRun = run;
    state.progress = { phase: "research_workflow", completed: 0, total: 1, fraction: 0 };
    notify("research.status.running", "info");
    requestRender();
    runtime.runTask = { handle: null, run, datasetRecord };
    try {
      const handle = client().run("analysis.research-workflow", payload, {
        taskId: run.runId,
        onProgress: updateProgress,
      });
      runtime.runTask.handle = handle;
      const result = await handle.promise;
      if (runtime.runTask?.run.runId !== run.runId || runtime.disposed || state.cancelling) return;
      const completedAt = now().toISOString();
      const record = buildCompletedAnalysisRecord({ run, datasetRecord, result, completedAt });
      const saved = await repository.saveAnalysis(record);
      state.analyses = mergeRecord(state.analyses, saved);
      state.selectedDataset = datasetRecord;
      state.selectedAnalysis = saved;
      state.result = result;
      state.running = false;
      state.cancelling = false;
      state.currentRun = null;
      state.progress = { phase: "complete", completed: 1, total: 1, fraction: 1 };
      state.activeSection = "results";
      setDefaultValidationUnit();
      notify("research.status.completed", "success");
      requestFocus("research-section-heading-results");
      requestRender();
    } catch (error) {
      if (runtime.runTask?.run.runId !== run.runId || runtime.disposed) return;
      const cancelled = state.cancelling || ["TASK_CANCELLED", "ANALYSIS_CANCELLED"].includes(error?.code);
      state.running = false;
      state.cancelling = false;
      state.currentRun = null;
      if (cancelled) {
        state.analysisError = null;
        state.progress = { phase: "cancelled", completed: 0, total: 1, fraction: 0 };
        notify("research.status.cancelled", "warning");
      } else {
        state.analysisError = errorMessage(error);
        state.progress = { phase: "failed", completed: 0, total: 1, fraction: 0 };
        notify("research.status.analysisError", "danger", { message: state.analysisError });
      }
      requestRender();
    } finally {
      if (runtime.runTask?.run.runId === run.runId) {
        runtime.runTask = null;
        if (state.running) {
          state.running = false;
          state.cancelling = false;
          state.currentRun = null;
          state.progress = { phase: "cancelled", completed: 0, total: 1, fraction: 0 };
          if (!runtime.disposed) {
            notify("research.status.cancelled", "warning");
            requestRender();
          }
        }
      }
    }
  }

  function cancelAnalysis() {
    if (!state.running || state.cancelling || !runtime.runTask) return false;
    state.cancelling = true;
    state.progress = { ...state.progress, phase: "cancelling" };
    notify("research.status.cancelling", "warning");
    requestRender();
    const cancelled = runtime.runTask.handle.cancel();
    if (!cancelled) {
      state.cancelling = false;
      requestRender();
    }
    return cancelled;
  }

  async function selectDataset(id) {
    const record = state.datasets.find((candidate) => candidate.id === id) ?? await repository.loadDataset(id);
    if (!record) throw new Error(t("research.data.savedNotFound"));
    attachDataset(record);
    requestRender();
  }

  async function selectAnalysis(id) {
    const record = state.analyses.find((candidate) => candidate.id === id) ?? await repository.loadAnalysis(id);
    if (!isCompletedAnalysis(record)) throw new Error(t("research.analysis.notComplete"));
    const linked = state.datasets.find((dataset) => matchesAnalysisDataset(dataset, record))
      ?? await repository.loadDataset(record.datasetRef?.id);
    if (!matchesAnalysisDataset(linked, record)) {
      throw new Error(t("research.analysis.datasetUnavailable"));
    }
    state.selectedAnalysis = record;
    state.selectedDataset = linked;
    state.result = record.result;
    state.activeSection = "results";
    setDefaultValidationUnit();
    requestFocus("research-section-heading-results");
    requestRender();
  }

  async function save() {
    let savedSomething = false;
    if (state.selectedDataset?.qualityReport?.valid) {
      await persistDataset(state.selectedDataset);
      savedSomething = true;
    }
    if (isCompletedAnalysis(state.selectedAnalysis)) {
      const persistedAnalysis = state.analyses.find((record) => record.id === state.selectedAnalysis.id);
      if (!persistedAnalysis) {
        const saved = await repository.saveAnalysis({
          ...state.selectedAnalysis,
          updatedAt: now().toISOString(),
        });
        state.analyses = mergeRecord(state.analyses, saved);
        state.selectedAnalysis = saved;
      } else {
        state.selectedAnalysis = persistedAnalysis;
      }
      savedSomething = true;
    }
    notify(savedSomething ? "research.status.saved" : "research.status.nothingToSave", savedSomething ? "success" : "info");
    requestRender();
  }

  async function restore() {
    await refreshRecords({ preserveSelection: false });
    const restored = selectRestorableResearch({ datasets: state.datasets, analyses: state.analyses });
    state.selectedDataset = restored.dataset;
    state.selectedAnalysis = restored.analysis && restored.dataset ? restored.analysis : null;
    state.result = state.selectedAnalysis?.result ?? null;
    setDefaultValidationUnit();
    notify(restored.dataset || restored.analysis ? "research.status.restored" : "research.status.noSaved", restored.dataset || restored.analysis ? "success" : "info");
    requestRender();
  }

  function exportResearch(kind) {
    const datasetRecord = state.selectedDataset;
    const result = state.result;
    const available = researchExportAvailability(datasetRecord, result);
    const base = slugify(result?.reproducibility?.runId ?? datasetRecord?.title ?? "ecolab-stage4-research");
    if (!available[kind]) throw new Error(t(kind === "dataset" ? "research.export.noDataset" : "research.export.noResult"));
    if (kind === "dataset") downloadText(normalizedDatasetToCsv(datasetRecord.normalizedDataset, getLocale()), `${base}.normalized-dataset.csv`, "text/csv;charset=utf-8");
    else if (kind === "manifest") downloadText(analysisManifestJson(result, getLocale()), `${base}.analysis-manifest.json`, "application/json;charset=utf-8");
    else if (kind === "package") downloadText(researchPackageJson(result, getLocale()), `${base}.research-package.json`, "application/json;charset=utf-8");
    else if (kind === "predictions") downloadText(predictionsMetricsToCsv(datasetRecord.normalizedDataset, result, getLocale()), `${base}.predictions-residuals-metrics.csv`, "text/csv;charset=utf-8");
    else if (kind === "methods") downloadText(researchMethodsText(result, getLocale()), `${base}.methods.md`, "text/markdown;charset=utf-8");
    else if (kind === "svg") downloadText(serializeResearchDashboard({ dataset: datasetRecord.normalizedDataset, result, selectedValidationUnit: state.selectedValidationUnit, locale: getLocale() }), `${base}.research-dashboard.svg`, "image/svg+xml;charset=utf-8");
    else throw new RangeError(t("research.export.unknown", { kind: String(kind) }));
    notify("research.status.exported", "success");
    requestRender();
  }

  function renderExportMenu() {
    const available = researchExportAvailability(state.selectedDataset, state.result);
    const disabled = (kind) => available[kind] ? "" : "disabled";
    const anyResult = available.manifest || available.package || available.predictions || available.methods || available.svg;
    return `<details class="export-menu" data-focus-key="research-export-menu"><summary>${t("nav.export")}</summary><div class="export-popover research-export-popover"><button type="button" data-action="research-export-manifest" ${disabled("manifest")}>${t("research.export.manifest")}</button><button type="button" data-action="research-export-package" ${disabled("package")}>${t("research.export.package")}</button><button type="button" data-action="research-export-dataset" ${disabled("dataset")}>${t("research.export.dataset")}</button><button type="button" data-action="research-export-predictions" ${disabled("predictions")}>${t("research.export.predictions")}</button><button type="button" data-action="research-export-methods" ${disabled("methods")}>${t("research.export.methods")}</button><button type="button" data-action="research-export-svg" ${disabled("svg")}>${t("research.export.svg")}</button><p>${t(anyResult ? "research.export.ready" : "research.export.disabled")}</p></div></details>`;
  }

  async function handleClick(action, target) {
    if (action === "save") { await save(); return true; }
    if (action === "restore") { await restore(); return true; }
    if (action === "research-section") {
      setResearchSection(state, target.dataset.section);
      requestFocus(`research-section-heading-${target.dataset.section}`);
      requestRender();
      return true;
    }
    if (action === "research-package-replay") { void replayPackage(); return true; }
    if (action === "research-package-cancel") { cancelPackage(); return true; }
    if (action === "research-load-bundled") {
      if (!state.running && !state.busy && !state.packageOperation) await loadBundled();
      return true;
    }
    if (action === "research-run") { void runAnalysis(); return true; }
    if (action === "research-cancel") { cancelAnalysis(); return true; }
    if (action === "research-select-dataset") { await selectDataset(target.dataset.id); return true; }
    if (action === "research-select-analysis") { await selectAnalysis(target.dataset.id); return true; }
    const exports = {
      "research-export-manifest": "manifest",
      "research-export-package": "package",
      "research-export-dataset": "dataset",
      "research-export-predictions": "predictions",
      "research-export-methods": "methods",
      "research-export-svg": "svg",
    };
    if (exports[action]) { exportResearch(exports[action]); return true; }
    return false;
  }

  async function handleChange(input) {
    switch (input.name) {
      case "research-seed":
        state.seed = normalizeResearchSeed(input.value);
        return true;
      case "research-preset":
        state.preset = input.value;
        return true;
      case "research-csv-id":
        state.csvMetadata.datasetId = input.value;
        return true;
      case "research-csv-title":
        state.csvMetadata.title = input.value;
        return true;
      case "research-csv-license":
        state.csvMetadata.license = input.value;
        return true;
      case "research-package-file":
        if (input.files?.[0]) await packageOperation("inspect", { file: input.files[0] });
        return true;
      case "research-dataset-file":
        if (!state.running && !state.busy && !state.packageOperation) await importFile(input.files?.[0]);
        return true;
      case "research-validation-unit":
        state.selectedValidationUnit = input.value;
        afterRender();
        return true;
      default:
        return false;
    }
  }

  function dispose() {
    runtime.disposed = true;
    cancelPackage();
    runtime.runTask?.handle?.cancel();
    runtime.importTask?.cancel();
    runtime.taskClient?.close();
  }

  return {
    state,
    initialize,
    enter,
    render,
    afterRender,
    renderExportMenu,
    handleClick,
    handleChange,
    save,
    restore,
    dispose,
    refreshRecords,
    cancelAnalysis,
  };
}
