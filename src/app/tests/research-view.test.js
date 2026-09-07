import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGES } from "../i18n.js";
import { createResearchState } from "../research/state.js";
import { escapeHtml, renderResearchWorkspace } from "../research/view.js";
import {
  createCatalogFixture,
  createDatasetRecord,
  createResearchResult,
  createResearchV2Result,
} from "./research-test-fixtures.js";

function t(key, params = {}) {
  const template = MESSAGES.en[key] ?? key;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function render(state, locale = "en") {
  const catalog = createCatalogFixture();
  return renderResearchWorkspace({
    state,
    catalog,
    registryRecord: catalog.datasetRegistry.records[0],
    sourceRecord: catalog.sourceRegistry.records[0],
    t: locale === "en" ? t : (key) => MESSAGES[locale][key] ?? key,
    locale,
  });
}

test("Research view escapes imported text and renders one main content landmark", () => {
  const state = createResearchState();
  state.selectedDataset = createDatasetRecord({ title: '<img src=x onerror="alert(1)">' });
  const html = render(state);
  assert.equal((html.match(/id="main-content"/g) ?? []).length, 1);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /<h1 id="research-page-heading"[^>]*data-focus-key="page-heading-research"/);
  assert.match(html, /<h2 id="research-data-heading"[^>]*data-focus-key="research-section-heading-data"/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("Data section shows exact bundled facts, field-by-field mismatch, and busy controls", () => {
  const state = createResearchState();
  state.busy = true;
  const html = render(state);
  assert.match(html, /528 real observations/);
  assert.match(html, /352 · 8 units/);
  assert.match(html, /176 · 4 units/);
  assert.match(html, /0.5–22 h/);
  assert.match(html, /10\.6084\/m9\.figshare\.28342064\.v1/);
  assert.match(html, /CC BY 4\.0/);
  assert.match(html, /Unknown/);
  assert.doesNotMatch(html, /<span class="research-chip research-chip-success">Match<\/span>/);
  assert.match(html, /data-action="research-load-bundled" disabled/);
  assert.match(html, /name="research-dataset-file"[^>]*disabled/);

  state.selectedDataset = createDatasetRecord();
  const selectedHtml = render(state);
  assert.match(selectedHtml, /Match/);
  assert.match(selectedHtml, /Mismatch/);
  assert.match(selectedHtml, /Incompatible/);
});

test("Design and Analysis sections expose the locked model, presets, progress, and completed-only records", () => {
  const state = createResearchState();
  state.activeSection = "design";
  let html = render(state);
  assert.match(html, /OD600 = baselineOd \+ scaleOd × \(N\/K\)/);
  assert.match(html, /psiMaxLog10PerHour/);
  assert.match(html, /initialStates\.pooled\.log10PopulationDensity/);
  assert.match(html, /uint32 random seed/);
  assert.match(html, /Small · quick browser check/);
  assert.match(html, /Standard · fuller diagnostics/);
  assert.match(html, /No t0 fabrication/);
  assert.match(html, /No antibiotic inference/);

  state.activeSection = "analysis";
  state.selectedDataset = createDatasetRecord();
  state.analyses = [
    { id: "complete", status: "completed", result: createResearchResult(), datasetRef: { id: "data", revision: 2 }, updatedAt: "2026-08-21T00:00:00Z" },
    { id: "running", status: "running", result: { partial: true }, datasetRef: { id: "data", revision: 2 }, updatedAt: "2026-08-22T00:00:00Z" },
  ];
  html = render(state);
  assert.match(html, /class="research-progress" role="status" aria-live="polite" aria-atomic="true" aria-busy="false"/);
  assert.match(html, /<label id="research-progress-phase" for="research-progress-bar">/);
  assert.match(html, /id="research-progress-bar"[^>]*aria-labelledby="research-progress-phase research-progress-value"/);
  assert.match(html, /data-action="research-run"/);
  assert.match(html, /running[\s\S]*Interrupted/);
  assert.match(html, /data-id="running"[^>]*disabled/);
  assert.match(html, /data-id="complete"/);
  assert.match(html, /<th scope="col">Actions<\/th>/);
  assert.match(html, /<th scope="row">running<\/th>/);
  assert.match(html, /aria-label="Open analysis result: running"/);

  state.running = true;
  state.cancelling = true;
  html = render(state);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /data-action="research-cancel" disabled>Cancelling…<\/button>/);
});

test("package controls require compatibility, render inspection/report metrics, and never imply automatic execution", () => {
  const state = createResearchState();
  state.activeSection = "analysis";
  let html = render(state);
  assert.match(html, /name="research-package-file"/);
  assert.match(html, /32 MiB/);
  assert.match(html, /data-action="research-package-replay"[^>]*disabled/);
  assert.match(html, /Inspection never runs/);
  state.replayPreview = { replayable: false, status: "inspect_only", reasons: [{ code: "MISSING_REPLAY_INPUT", message: "<script>legacy</script>" }],
    researchPackage: { packageId: "historical-package", contents: { analysisManifest: { runId: "historical-run", versions: { application: "5.0.0", analysis: "1.0.0" }, model: { version: "1.0.0" } } } } };
  html = render(state);
  assert.match(html, /historical-run/);
  assert.match(html, /5\.0\.0/);
  assert.match(html, /MISSING_REPLAY_INPUT/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-action="research-package-replay"[^>]*disabled/);
  state.replayPreview.replayable = true;
  state.replayPreview.status = "matched";
  state.replayPreview.matched = true;
  state.replayPreview.result = createResearchV2Result();
  state.replayPreview.comparison = { mismatchCount: 0, mismatchPaths: [], absoluteTolerance: 1e-10, relativeTolerance: 1e-8 };
  html = render(state);
  assert.match(html, /Replay matched/);
  assert.match(html, /0\.023/);
  assert.match(html, /Memory-only preview/);
  assert.doesNotMatch(html, /data-action="research-package-replay"[^>]*disabled/);
  state.packageOperation = "replay";
  state.packageCancelling = true;
  html = render(state);
  assert.match(html, /data-action="research-package-replay"[^>]*disabled/);
  assert.match(html, /data-action="research-package-cancel"[^>]*disabled/);
  state.packageOperation = null;
  state.packageCancelling = false;
  state.replayPreview.matched = false;
  state.replayPreview.status = "mismatch";
  state.replayPreview.comparison.mismatchCount = 1;
  state.replayPreview.comparison.mismatchPaths = ["$.growthComparison.development"];
  html = render(state);
  assert.match(html, /Replay mismatch/);
  assert.match(html, /\$\.growthComparison\.development/);
});

test("replay preview labels unavailable selected-growth metrics rather than substituting calibration", () => {
  const state = createResearchState();
  state.activeSection = "analysis";
  const result = createResearchV2Result();
  result.growthComparison.development.selected = { status: "unavailable", metrics: null, predictions: [] };
  state.replayPreview = { replayable: true, status: "matched", reasons: [], result };
  const html = render(state);
  assert.match(html, /Replay preview metrics/);
  assert.match(html, /training_mean.*unavailable/);
  assert.doesNotMatch(html, /<dd>0\.005<\/dd>/);
  assert.match(html, /<dd>—<\/dd>/);
});

test("v2 results distinguish assessment, training CV selection, frozen development and joint curve bootstrap", () => {
  const state = createResearchState();
  state.activeSection = "results";
  state.selectedDataset = createDatasetRecord();
  state.result = createResearchV2Result();
  const before = structuredClone(state.result);
  const html = render(state);
  for (const label of ["Completed", "Converged", "Identified", "Precision assessed", "Training-only complete-trajectory CV", "logistic", "gompertz", "training_mean", "Frozen development", "Successful joint refits", "BOOTSTRAP_REFIT_FAILURES", "Objective slices", "reoptimized", "Sobol", "WIDE_BOOTSTRAP_INTERVAL"]) assert.ok(html.includes(label), label);
  assert.match(html, /17 \/ 20/);
  assert.match(html, /0\.012/);
  assert.match(html, /0\.023/);
  assert.match(html, /-0\.24/);
  assert.match(html, /-0\.48/);
  assert.match(html, /1\.46/);
  assert.match(html, /95% paired-row bootstrap intervals · 40 replicates/);
  assert.match(html, /source role.*validation/i);
  assert.match(html, /not untouched|not an untouched/i);
  assert.match(html, /independence.*unverified/i);
  assert.doesNotMatch(html, /Locked validation/);
  assert.deepEqual(state.result, before);
});

test("v2 design and result copy is bilingual and avoids legacy validation and independence claims", () => {
  const state = createResearchState();
  for (const locale of ["en", "zh-CN"]) {
    state.activeSection = "design";
    const design = render(state, locale);
    assert.match(design, /logistic/);
    assert.match(design, /Gompertz/);
    assert.match(design, locale === "en" ? /development/i : /开发/);
    assert.doesNotMatch(design, /before validation|see validation values|training or validation|完整独立单元|在验证前锁定|接触验证值/);
    state.activeSection = "results";
    state.selectedDataset = createDatasetRecord();
    state.result = createResearchV2Result();
    const html = render(state, locale);
    assert.doesNotMatch(html, /complete independent units|完整独立单元|Stage 4 results|Stage 4 结果/);
    assert.match(html, locale === "en" ? /failed refits.*excluded/i : /失败重拟合.*排除/);
  }
});

test("bilingual privacy describes persisted QC sourceText and volatile memory-only data", () => {
  for (const locale of ["en", "zh-CN"]) {
    const html = render(createResearchState(), locale);
    assert.match(html, /IndexedDB/);
    assert.match(html, /sourceText/);
    assert.doesNotMatch(html, /Files remain runtime-only|文件只在运行时存在/);
    assert.match(html, locale === "en" ? /memory-only.*lost/i : /仅内存.*丢失/);
    const keys = Object.keys(MESSAGES.en).filter((key) => key.startsWith("research."));
    for (const key of keys) assert.equal(typeof MESSAGES[locale][key], "string", `${locale}: ${key}`);
  }
});

test("legacy 5 results render a historical notice without recomputation or mutation", () => {
  const state = createResearchState();
  state.activeSection = "results";
  state.selectedDataset = createDatasetRecord();
  state.result = createResearchResult();
  state.result.reproducibility.applicationVersion = "5.0.0";
  const before = structuredClone(state.result);
  assert.match(render(state), /Historical result/);
  assert.match(render(state), /not recomputed or rewritten/);
  assert.deepEqual(state.result, before);
});

test("Results section labels training vs validation roles and keeps scientific warnings visible", () => {
  const state = createResearchState();
  state.activeSection = "results";
  state.selectedDataset = createDatasetRecord();
  state.result = createResearchResult();
  state.selectedValidationUnit = "validation-unit";
  const html = render(state);
  assert.match(html, /Capability for this run/);
  assert.match(html, /Training calibration/);
  assert.match(html, /Locked validation/);
  assert.match(html, /Training fit and optimization/);
  assert.match(html, /Training, validation, and predeclared baseline/);
  assert.match(html, /Residuals and identifiability/);
  assert.match(html, /RAW_OD_ABSOLUTE_SCALE_NOT_IDENTIFIED/);
  assert.match(html, /L4_VALIDATION_EVIDENCE_INSUFFICIENT/);
  assert.match(html, /STRONG_PARAMETER_CORRELATION/);
  assert.match(html, /id="research-chart-dashboard"/);
});
