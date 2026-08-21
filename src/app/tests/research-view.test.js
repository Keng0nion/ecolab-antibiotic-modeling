import test from "node:test";
import assert from "node:assert/strict";
import { MESSAGES } from "../i18n.js";
import { createResearchState } from "../research/state.js";
import { escapeHtml, renderResearchWorkspace } from "../research/view.js";
import {
  createCatalogFixture,
  createDatasetRecord,
  createResearchResult,
} from "./research-test-fixtures.js";

function t(key, params = {}) {
  const template = MESSAGES.en[key] ?? key;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    template,
  );
}

function render(state) {
  const catalog = createCatalogFixture();
  return renderResearchWorkspace({
    state,
    catalog,
    registryRecord: catalog.datasetRegistry.records[0],
    sourceRecord: catalog.sourceRegistry.records[0],
    t,
    locale: "en",
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
