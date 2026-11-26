import { conditionComparison, datasetSummary } from "./dataset-loader.js";
import { researchEvaluationRole, researchSensitivityRows } from "./state.js";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function attr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "about:blank";
  } catch {
    return "about:blank";
  }
}

function format(value, digits = 4) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if ((absolute > 0 && absolute < 0.001) || absolute >= 100_000) return value.toExponential(3).replace("e+", "e");
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatDate(value, locale) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(locale) : "—";
}

function severityClass(value) {
  if (value === "error" || value === "danger") return "danger";
  if (value === "warning") return "warning";
  if (value === "success" || value === "match") return "success";
  return "info";
}

function sectionNavigation(state, t) {
  return `<nav class="research-section-nav" aria-label="${attr(t("research.nav.sections"))}">
    ${["data", "design", "analysis", "results"].map((section, index) => `<button type="button" data-action="research-section" data-section="${section}" data-focus-key="research-section-${section}" aria-current="${state.activeSection === section ? "step" : "false"}"><span>${index + 1}</span>${escapeHtml(t(`research.section.${section}`))}</button>`).join("")}
  </nav>`;
}

function issueList(issues, emptyText) {
  if (!issues?.length) return `<p class="research-empty">${escapeHtml(emptyText)}</p>`;
  return `<ul class="research-issue-list">${issues.map((issue) => `<li class="research-issue research-issue-${severityClass(issue.severity)}"><strong>${escapeHtml(issue.code ?? issue.severity ?? "NOTE")}</strong><span>${escapeHtml(issue.message ?? issue)}</span>${issue.path ? `<small>${escapeHtml(issue.path)}</small>` : ""}</li>`).join("")}</ul>`;
}

function datasetStatus(record, t) {
  if (!record) return `<span class="research-chip research-chip-info">${escapeHtml(t("research.data.noneSelected"))}</span>`;
  if (!record.qualityReport?.valid) return `<span class="research-chip research-chip-danger">${escapeHtml(t("research.data.qcFailed"))}</span>`;
  if (record.workflowEligible) return `<span class="research-chip research-chip-success">${escapeHtml(t("research.data.workflowReady"))}</span>`;
  if (record.killEligible) return `<span class="research-chip research-chip-success">${escapeHtml(t("research.data.killReady"))}</span>`;
  return `<span class="research-chip research-chip-warning">${escapeHtml(t("research.data.qcOnly"))}</span>`;
}

function bundledCard({ registryRecord, sourceRecord, selectedDataset, busy, t }) {
  const selectedBundled = selectedDataset?.registryRef === `${registryRecord.id}@${registryRecord.version}`;
  return `<article class="research-card research-dataset-card" aria-labelledby="research-bundled-title">
    <div class="research-card-heading">
      <div><p class="eyebrow">${escapeHtml(t("research.data.bundledEyebrow"))}</p><h2 id="research-bundled-title">${escapeHtml(t("research.data.bundledTitle"))}</h2></div>
      <span class="research-chip research-chip-warning">${escapeHtml(t("research.data.rawOd"))}</span>
    </div>
    <p>${escapeHtml(t("research.data.bundledSummary"))}</p>
    <dl class="research-fact-grid">
      <div><dt>${escapeHtml(t("research.data.observations"))}</dt><dd>528</dd></div>
      <div><dt>${escapeHtml(t("research.data.units"))}</dt><dd>12</dd></div>
      <div><dt>${escapeHtml(t("research.data.training"))}</dt><dd>352 · 8 ${escapeHtml(t("research.data.unitsLower"))}</dd></div>
      <div><dt>${escapeHtml(t("research.development.label"))}</dt><dd>176 · 4 ${escapeHtml(t("research.data.unitsLower"))}</dd></div>
      <div><dt>${escapeHtml(t("research.data.times"))}</dt><dd>44 · 0.5–22 h · 30 min</dd></div>
      <div><dt>${escapeHtml(t("research.data.split"))}</dt><dd>${escapeHtml(t("research.data.completeUnits"))}</dd></div>
    </dl>
    <div class="research-two-column">
      <section><h3>${escapeHtml(t("research.data.conditions"))}</h3><ul class="research-compact-list"><li><i>Escherichia coli</i> BW25113</li><li>Cond00003 · ${escapeHtml(t("research.data.chemDefined"))}</li><li>37 °C · 96-well · 200 µL · 567 rpm</li><li>1:1000 · Epoch2 · ${escapeHtml(t("research.data.untreated"))}</li><li>${escapeHtml(t("research.data.rawUnblanked"))}</li></ul></section>
      <section><h3>${escapeHtml(t("research.data.provenance"))}</h3><p><a href="${attr(safeUrl(sourceRecord?.url))}" target="_blank" rel="noopener noreferrer">DOI ${escapeHtml(sourceRecord?.doi ?? "10.6084/m9.figshare.28342064.v1")}</a></p><p>${escapeHtml(t("research.data.articleDoi"))}: ${escapeHtml(sourceRecord?.articleDoi ?? "10.1038/s41597-025-05356-3")}</p><p>CC BY 4.0</p><small>${escapeHtml(sourceRecord?.attribution ?? "Aida, Honoka; Ying, Bei-Wen (2025). Bacterial growth profiles across one-thousand chemical-defined media. figshare. Dataset. https://doi.org/10.6084/m9.figshare.28342064.v1")}</small></section>
    </div>
    <section class="research-limitations"><h3>${escapeHtml(t("research.data.limitations"))}</h3><ul><li>${escapeHtml(t("research.limit.odNotCfu"))}</li><li>${escapeHtml(t("research.limit.unblanked"))}</li><li>${escapeHtml(t("research.limit.noT0"))}</li><li>${escapeHtml(t("research.limit.independence"))}</li><li>${escapeHtml(t("research.limit.medium"))}</li><li>${escapeHtml(t("research.limit.noAntibiotic"))}</li><li>${escapeHtml(t("research.limit.zuso4"))}</li></ul></section>
    <div class="research-actions"><button class="primary-button" type="button" data-action="research-load-bundled" ${selectedBundled || busy ? "disabled" : ""}>${escapeHtml(selectedBundled ? t("research.data.loaded") : t("research.data.loadVerify"))}</button><small>${escapeHtml(t("research.data.integrityNote"))}</small></div>
  </article>`;
}

function importCard(state, t) {
  const metadata = state.csvMetadata;
  return `<article class="research-card" aria-labelledby="research-import-title">
    <div class="research-card-heading"><div><p class="eyebrow">${escapeHtml(t("research.data.importEyebrow"))}</p><h2 id="research-import-title">${escapeHtml(t("research.data.importTitle"))}</h2></div></div>
    <p>${escapeHtml(t("research.data.importSummary"))}</p>
    <label class="research-field research-file-field"><span>${escapeHtml(t("research.data.file"))}</span><input type="file" name="research-dataset-file" accept=".json,.csv,.xlsx,application/json,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ${state.busy || state.running || state.packageOperation ? "disabled" : ""}></label>
    <fieldset class="research-fieldset"><legend>${escapeHtml(t("research.data.csvMetadata"))}</legend><p>${escapeHtml(t("research.data.csvMetadataNote"))}</p><div class="research-form-grid">
      <label class="research-field"><span>${escapeHtml(t("research.data.datasetId"))}</span><input name="research-csv-id" value="${attr(metadata.datasetId)}" maxlength="120"></label>
      <label class="research-field"><span>${escapeHtml(t("research.data.title"))}</span><input name="research-csv-title" value="${attr(metadata.title)}" maxlength="240"></label>
      <label class="research-field"><span>${escapeHtml(t("research.data.license"))}</span><input name="research-csv-license" value="${attr(metadata.license)}" maxlength="120"></label>
    </div></fieldset>
    <p class="research-note">${escapeHtml(t("research.data.genericPolicy"))}</p>
  </article>`;
}

function killFitReadiness(record, t) {
  const observations = record?.normalizedDataset?.observations;
  if (!record?.killEligible || !Array.isArray(observations)) return "";
  const byStrain = new Map();
  const byUnit = new Map();
  for (const row of observations) {
    const strain = String(row.conditions?.strain ?? record.normalizedDataset.metadata?.conditions?.strain ?? "unknown");
    if (!byStrain.has(strain)) byStrain.set(strain, []);
    byStrain.get(strain).push(row);
    if (!byUnit.has(row.independentUnitId)) byUnit.set(row.independentUnitId, []);
    byUnit.get(row.independentUnitId).push(row);
  }
  const strainRows = [...byStrain].map(([strain, rows]) => {
    const exactTrainingCount = rows.filter((row) => row.role === "training" && row.censoring !== "left").length;
    const ready = exactTrainingCount >= 7;
    return `<tr><th scope="row">${escapeHtml(strain)}</th><td>${exactTrainingCount} / 7</td><td><span class="research-chip research-chip-${ready ? "success" : "warning"}">${escapeHtml(t(ready ? "research.kill.readiness.fitReady" : "research.kill.readiness.statusOnly"))}</span></td></tr>`;
  }).join("");
  const unitRows = [...byUnit].map(([unitId, rows]) => {
    const postBaseline = rows.filter((row) => row.timeHours > 0);
    const limits = rows.map((row) => row.censoringBounds?.upper).filter(Number.isFinite);
    const lod = limits.length ? Math.min(...limits) : null;
    const exactInformativeCount = postBaseline.filter((row) => row.censoring !== "left" && (lod === null || row.value > lod + 1e-9)).length;
    const ready = exactInformativeCount >= 2;
    return `<tr><th scope="row">${escapeHtml(unitId)}</th><td>${exactInformativeCount} / 2</td><td><span class="research-chip research-chip-${ready ? "success" : "warning"}">${escapeHtml(t(ready ? "research.kill.readiness.groupReady" : "research.kill.readiness.statusOnly"))}</span></td></tr>`;
  }).join("");
  return `<section class="research-fit-readiness" aria-labelledby="research-fit-readiness-heading"><h3 id="research-fit-readiness-heading">${escapeHtml(t("research.kill.readiness.heading"))}</h3><p class="research-note">${escapeHtml(t("research.kill.readiness.note"))}</p><div class="research-table-scroll"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.kill.strain"))}</th><th scope="col">${escapeHtml(t("research.kill.readiness.exact"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th></tr></thead><tbody>${strainRows}</tbody></table></div><details><summary>${escapeHtml(t("research.kill.readiness.units"))}</summary><div class="research-table-scroll"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.kill.unitGroup"))}</th><th scope="col">${escapeHtml(t("research.kill.readiness.exact"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th></tr></thead><tbody>${unitRows}</tbody></table></div></details></section>`;
}

function qcPanel(state, t) {
  const record = state.selectedDataset;
  if (!record) return `<article class="research-card"><h2>${escapeHtml(t("research.data.selected"))}</h2><p class="research-empty">${escapeHtml(t("research.data.selectPrompt"))}</p></article>`;
  const summary = datasetSummary(record);
  const quality = record.qualityReport;
  return `<article class="research-card" aria-labelledby="research-selected-title">
    <div class="research-card-heading"><div><p class="eyebrow">${escapeHtml(t("research.data.selected"))}</p><h2 id="research-selected-title">${escapeHtml(record.title)}</h2></div>${datasetStatus(record, t)}</div>
    <dl class="research-fact-grid"><div><dt>ID</dt><dd>${escapeHtml(record.normalizedDataset.metadata.datasetId)}</dd></div><div><dt>${escapeHtml(t("research.data.artifactSha256"))}</dt><dd class="research-hash">${escapeHtml(record.contentHash)}</dd></div><div><dt>${escapeHtml(t("research.data.observations"))}</dt><dd>${summary.observationCount}</dd></div><div><dt>${escapeHtml(t("research.data.units"))}</dt><dd>${summary.independentUnitCount}</dd></div><div><dt>${escapeHtml(t("research.data.errors"))}</dt><dd>${quality.summary.errorCount}</dd></div><div><dt>${escapeHtml(t("research.data.warnings"))}</dt><dd>${quality.summary.warningCount + (record.importWarnings?.length ?? 0)}</dd></div></dl>
    <div class="research-two-column"><section><h3>${escapeHtml(t("research.data.qcErrors"))}</h3>${issueList(quality.errors, t("research.data.noErrors"))}</section><section><h3>${escapeHtml(t("research.data.qcWarnings"))}</h3>${issueList([...(record.importWarnings ?? []), ...(quality.warnings ?? [])], t("research.data.noWarnings"))}</section></div>
    ${record.workflowEligible ? `<p class="research-callout research-callout-success">${escapeHtml(t("research.data.exactContract"))}</p>` : `<div class="research-callout research-callout-warning"><strong>${escapeHtml(t("research.data.workflowDisabled"))}</strong><ul>${(record.workflowIneligibilityReasons ?? []).map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></div>`}
    ${killFitReadiness(record, t)}
  </article>`;
}

function comparisonPanel(registryRecord, resolvedModel, selectedDataset, t) {
  const rows = conditionComparison(registryRecord, resolvedModel, selectedDataset);
  return `<article class="research-card" aria-labelledby="research-condition-title"><div class="research-card-heading"><div><p class="eyebrow">${escapeHtml(t("research.data.noScore"))}</p><h2 id="research-condition-title">${escapeHtml(t("research.data.conditionComparison"))}</h2></div></div><p>${escapeHtml(t("research.data.comparisonNote"))}</p><div class="research-table-scroll" data-scroll-key="research-condition-table"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.table.field"))}</th><th scope="col">${escapeHtml(t("research.table.dataset"))}</th><th scope="col">${escapeHtml(t("research.table.target"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th><th scope="col">${escapeHtml(t("research.table.interpretation"))}</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(t(`research.condition.${row.field}`))}</th><td>${escapeHtml(row.dataset === "unknown" ? t("research.condition.unknownValue") : row.dataset)}</td><td>${escapeHtml(row.target === "unknown" ? t("research.condition.unknownValue") : row.target)}</td><td><span class="research-chip research-chip-${severityClass(row.status)}">${escapeHtml(t(`research.condition.${row.status}`))}</span></td><td>${escapeHtml(t(`research.condition.detail.${row.detailKey ?? row.status}`))}</td></tr>`).join("")}</tbody></table></div><p class="research-callout research-callout-warning"><strong>${escapeHtml(t("research.data.overall"))}:</strong> ${escapeHtml(t(selectedDataset?.workflowEligible ? "research.condition.overallBundled" : "research.condition.overallGeneric"))}</p></article>`;
}

function savedDatasets(state, t) {
  if (!state.datasets.length) return "";
  return `<article class="research-card"><h2>${escapeHtml(t("research.data.savedDatasets"))}</h2><div class="research-table-scroll" data-scroll-key="research-saved-datasets"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.data.title"))}</th><th scope="col">ID</th><th scope="col">${escapeHtml(t("research.table.status"))}</th><th scope="col">${escapeHtml(t("research.table.updated"))}</th><th scope="col">${escapeHtml(t("research.table.actions"))}</th></tr></thead><tbody>${state.datasets.map((record) => `<tr><th scope="row">${escapeHtml(record.title)}</th><td>${escapeHtml(record.normalizedDataset?.metadata?.datasetId ?? record.id)}</td><td>${datasetStatus(record, t)}</td><td>${escapeHtml(formatDate(record.updatedAt, state.locale))}</td><td><button type="button" data-action="research-select-dataset" data-id="${attr(record.id)}" aria-label="${attr(t("research.action.selectDataset", { title: record.title }))}">${escapeHtml(t("research.action.select"))}</button></td></tr>`).join("")}</tbody></table></div></article>`;
}

function renderData(context) {
  const { state, catalog, registryRecord, sourceRecord, t } = context;
  return `<section class="research-section" id="research-data-section" aria-labelledby="research-data-heading"><div class="research-section-heading"><p class="eyebrow">01 · ${escapeHtml(t("research.section.data"))}</p><h2 id="research-data-heading" tabindex="-1" data-focus-key="research-section-heading-data">${escapeHtml(t("research.data.heading"))}</h2><p>${escapeHtml(t("research.data.lead"))}</p></div><div class="research-grid research-grid-data">${bundledCard({ registryRecord, sourceRecord, selectedDataset: state.selectedDataset, busy: state.busy || state.running || state.packageOperation, t })}${importCard(state, t)}</div>${state.datasetError ? `<div class="research-callout research-callout-danger" role="alert">${escapeHtml(state.datasetError)}</div>` : ""}${qcPanel(state, t)}${comparisonPanel(registryRecord, catalog.resolvedModel, state.selectedDataset, t)}${savedDatasets(state, t)}</section>`;
}

function renderDesign(context) {
  const { state, catalog, t } = context;
  const carryingCapacity = catalog.resolvedModel.parameters.carryingCapacityLog10CfuPerMl;
  const parameterSetNotice = catalog.resolvedModel.researchFitEligible === false
    ? `<p class="research-callout research-callout-warning">${escapeHtml(t("research.design.parameterSetTeachingOnly"))}</p>`
    : "";
  return `<section class="research-section" id="research-design-section" aria-labelledby="research-design-heading"><div class="research-section-heading"><p class="eyebrow">02 · ${escapeHtml(t("research.section.design"))}</p><h2 id="research-design-heading" tabindex="-1" data-focus-key="research-section-heading-design">${escapeHtml(t("research.design.heading"))}</h2><p>${escapeHtml(t("research.design.lead"))}</p></div>
    ${parameterSetNotice}
    <div class="research-grid research-grid-design"><article class="research-card"><h2>${escapeHtml(t("research.design.parameters"))}</h2><dl class="research-definition-list"><div><dt>psiMaxLog10PerHour</dt><dd>${escapeHtml(t("research.design.psi"))}</dd></div><div><dt>initialStates.pooled.log10PopulationDensity</dt><dd>${escapeHtml(t("research.design.initial"))}</dd></div><div><dt>${escapeHtml(t("research.design.capacity"))}</dt><dd>${format(carryingCapacity, 3)} log10 CFU/mL · ${escapeHtml(t("research.design.fixed"))}</dd></div></dl></article>
    <article class="research-card"><h2>${escapeHtml(t("research.design.observationModel"))}</h2><p class="research-equation">OD600 = baselineOd + scaleOd × (N/K)</p><p>${escapeHtml(t("research.design.profiled"))}</p></article></div>
    <article class="research-card"><h2>${escapeHtml(t("research.design.lockedPlan"))}</h2><div class="research-principles"><div><strong>${escapeHtml(t("research.design.trainingOnly"))}</strong><span>${escapeHtml(t("research.design.trainingOnlyBody"))}</span></div><div><strong>${escapeHtml(t("research.design.completeSplit"))}</strong><span>${escapeHtml(t("research.design.completeSplitBody"))}</span></div><div><strong>${escapeHtml(t("research.design.noT0"))}</strong><span>${escapeHtml(t("research.design.noT0Body"))}</span></div><div><strong>${escapeHtml(t("research.design.baseline"))}</strong><span>training-unit-mean-od-by-exact-source-time</span></div><div><strong>${escapeHtml(t("research.design.noAntibiotic"))}</strong><span>${escapeHtml(t("research.design.noAntibioticBody"))}</span></div></div></article>
    <article class="research-card"><h2>${escapeHtml(t("research.growth.heading"))}</h2><p>${escapeHtml(t("research.growth.design"))}</p><p class="research-callout research-callout-warning">${escapeHtml(t("research.development.note"))}</p><p>${escapeHtml(t("research.growth.warning"))}</p></article>
    <article class="research-card"><h2>${escapeHtml(t("research.design.repro"))}</h2><div class="research-form-grid"><label class="research-field"><span>${escapeHtml(t("research.design.seed"))}</span><input type="number" name="research-seed" min="0" max="4294967295" step="1" value="${attr(state.seed)}"></label><label class="research-field"><span>${escapeHtml(t("research.design.preset"))}</span><select name="research-preset"><option value="small" ${state.preset === "small" ? "selected" : ""}>${escapeHtml(t("research.design.small"))}</option><option value="standard" ${state.preset === "standard" ? "selected" : ""}>${escapeHtml(t("research.design.standard"))}</option><option value="precision" ${state.preset === "precision" ? "selected" : ""}>${escapeHtml(t("research.design.precision"))}</option></select></label></div><p class="research-note">${escapeHtml(t("research.design.presetNote"))}</p></article>
  </section>`;
}

function analysisStatus(record, t) {
  const status = record.status === "running" ? "interrupted" : record.status;
  return `<span class="research-chip research-chip-${status === "completed" ? "success" : status === "failed" ? "danger" : "warning"}">${escapeHtml(t(`research.analysis.status.${status}`))}</span>`;
}

function priorAnalyses(state, t) {
  if (!state.analyses.length) return `<p class="research-empty">${escapeHtml(t("research.analysis.noneSaved"))}</p>`;
  return `<div class="research-table-scroll" data-scroll-key="research-prior-analyses"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.analysis.run"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th><th scope="col">${escapeHtml(t("research.analysis.datasetRevision"))}</th><th scope="col">${escapeHtml(t("research.table.updated"))}</th><th scope="col">${escapeHtml(t("research.table.actions"))}</th></tr></thead><tbody>${state.analyses.map((record) => `<tr><th scope="row">${escapeHtml(record.id)}</th><td>${analysisStatus(record, t)}</td><td>${escapeHtml(`${record.datasetRef?.id ?? "—"} · r${record.datasetRef?.revision ?? "—"}`)}</td><td>${escapeHtml(formatDate(record.updatedAt ?? record.completedAt, state.locale))}</td><td><button type="button" data-action="research-select-analysis" data-id="${attr(record.id)}" aria-label="${attr(t("research.action.openAnalysis", { runId: record.id }))}" ${record.status !== "completed" || !record.result ? "disabled" : ""}>${escapeHtml(t("research.action.open"))}</button></td></tr>`).join("")}</tbody></table></div>`;
}

function jsonDetails(heading, value) {
  return `<details><summary>${escapeHtml(heading)}</summary><pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre></details>`;
}

function packagePanel(state, t) {
  const preview = state.replayPreview;
  const busy = state.running || state.busy || Boolean(state.packageOperation);
  const progress = state.packageProgress;
  const manifest = preview?.researchPackage?.contents?.analysisManifest;
  const growth = preview?.result?.growthComparison;
  const metrics = growth ? growth.development?.selected?.metrics : preview?.result?.validation?.metrics;
  return `<article class="research-card" aria-labelledby="research-package-heading"><h2 id="research-package-heading">${escapeHtml(t("research.package.heading"))}</h2>
    <p>${escapeHtml(t("research.package.policy"))}</p><p class="research-note">${escapeHtml(t("research.package.preview"))}</p>
    <label class="research-field research-file-field"><span>${escapeHtml(t("research.package.file"))}</span><input type="file" name="research-package-file" accept=".json,application/json" ${busy ? "disabled" : ""}></label>
    <div class="research-progress" role="status" aria-live="polite" aria-busy="${Boolean(state.packageOperation)}"><label id="research-package-phase" for="research-package-progress">${escapeHtml(t(`research.progress.${state.packageCancelling ? "cancelling" : progress.phase}`))}</label><progress id="research-package-progress" max="1" value="${attr(progress.fraction)}" aria-labelledby="research-package-phase"></progress></div>
    ${state.packageError ? `<p class="research-callout research-callout-danger" role="alert">${escapeHtml(state.packageError)}</p>` : ""}
    ${preview ? `<p><strong>${escapeHtml(t(`research.package.${preview.status}`))}</strong> · ${escapeHtml(preview.fileName ?? preview.researchPackage?.packageId)}</p>${issueList(preview.reasons, t("research.data.noWarnings"))}${jsonDetails(t("research.package.manifest"), manifest)}${preview.comparison ? jsonDetails(t("research.package.report"), preview.comparison) : ""}` : ""}
    ${preview?.result ? `<h3>${escapeHtml(t("research.package.metrics"))} · ${escapeHtml(t(researchEvaluationRole(preview.result) === "development" ? "research.development.label" : "research.data.validation"))}</h3><p>${growth ? `${escapeHtml(growth.selection?.selectedModel)} · ${escapeHtml(growth.development?.selected?.status)}` : escapeHtml(t("research.results.trainingRole"))}</p><dl class="research-fact-grid">${metricRows(metrics).map(([name, value]) => `<div><dt>${escapeHtml(name)}</dt><dd>${format(value)}</dd></div>`).join("")}</dl>${assessmentPanel(preview.result, t)}` : ""}
    <div class="research-actions"><button type="button" data-action="research-package-replay" ${preview?.replayable === true && !busy ? "" : "disabled"}>${escapeHtml(t("research.package.replay"))}</button><button type="button" data-action="research-package-cancel" ${state.packageOperation && !state.packageCancelling ? "" : "disabled"}>${escapeHtml(t(state.packageCancelling ? "research.analysis.cancelling" : "research.analysis.cancel"))}</button></div>
  </article>`;
}

function renderKillUnitIdentifiability(strains, t) {
  const rows = strains.flatMap(([strain, entry]) => (entry.unitGrowthRateIdentifiability?.units ?? []).map((unit) => ({ strain, unit })));
  if (!rows.length) return "";
  const criterionNotes = strains.flatMap(([strain, entry]) => {
    const criterion = entry.unitGrowthRateIdentifiability?.criterion;
    return typeof criterion === "string" && criterion.length
      ? [`<p class="research-note"><strong>${escapeHtml(t("research.kill.unitCriterion"))}</strong> · ${escapeHtml(strain)}: ${escapeHtml(criterion)}</p>`]
      : [];
  }).join("");
  const unidentified = rows.filter(({ unit }) => unit.status !== "identified");
  const statusLabel = (status) => t(`research.kill.unitStatus.${status}`);
  const summary = unidentified.length
    ? t("research.kill.unitSummary", {
      unidentified: unidentified.length,
      units: rows.length,
      list: unidentified.map(({ strain, unit }) => `${strain} @ ${unit.concentrationMgPerL}`).join("; "),
    })
    : t("research.kill.unitAllIdentified", { units: rows.length });
  const table = `<div class="research-table-scroll"><table class="research-table"><thead><tr>
      <th scope="col">${escapeHtml(t("research.kill.strain"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitGroup"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitConcentration"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitModelRate"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitStatus"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitBound"))}</th>
      <th scope="col">${escapeHtml(t("research.kill.unitAtLimit"))}</th>
    </tr></thead><tbody>${rows.map(({ strain, unit }) => {
    const bound = unit.status === "identified" || !Number.isFinite(unit.oneSided95Bound)
      ? "—"
      : `${unit.relation ?? ""} ${format(unit.oneSided95Bound, 3)}`;
    return `<tr><th scope="row">${escapeHtml(strain)}</th>
        <td>${escapeHtml(unit.independentUnitId)}</td>
        <td>${escapeHtml(format(unit.concentrationMgPerL, 6))}</td>
        <td>${escapeHtml(format(unit.modelNetGrowthRateLog10PerHour, 3))}</td>
        <td>${escapeHtml(statusLabel(unit.status))}</td>
        <td>${escapeHtml(bound)}</td>
        <td>${unit.postBaselineObservationCount
    ? `${unit.censoredObservationCount + unit.exactAtDetectionLimitCount}/${unit.postBaselineObservationCount}`
    : "—"}</td></tr>`;
  }).join("")}</tbody></table></div>`;
  return `<h3>${escapeHtml(t("research.kill.unitHeading"))}</h3>
    <p class="research-note">${escapeHtml(t("research.kill.unitNote"))}</p>
    ${criterionNotes}
    <p class="research-callout ${unidentified.length ? "research-callout-warning" : "research-note"}">${escapeHtml(summary)}</p>
    <details><summary>${escapeHtml(t("research.kill.unitTableHeading"))}</summary>${table}</details>`;
}

function renderKillResult(result, t) {
  const strains = Object.entries(result.strains ?? {});
  const fitDiagnostics = strains.map(([strain, entry]) => ({ strain, diagnostics: entry.fitDiagnostics ?? {} }));
  const parameterBoundaryRows = fitDiagnostics.flatMap(({ strain, diagnostics }) => (diagnostics.boundary?.parametersAtBound ?? []).map((hit) => ({ strain, ...hit })))
    .map((hit) => `<tr><th scope="row">${escapeHtml(hit.strain)}</th><td>${escapeHtml(hit.parameter)}</td><td>${escapeHtml(hit.side)}</td><td>${format(hit.value)}</td><td>${format(hit.bound)}</td></tr>`).join("");
  const diagnosticSummaryRows = fitDiagnostics.map(({ strain, diagnostics }) => `<tr><th scope="row">${escapeHtml(strain)}</th><td>${escapeHtml(diagnostics.convergence?.status ?? "NOT_ASSESSED")}</td><td>${escapeHtml(diagnostics.profileLikelihood?.status ?? "NOT_ASSESSED")}</td><td>${diagnostics.sigmaAtLowerBound === true ? "true" : diagnostics.sigmaAtLowerBound === false ? "false" : "—"}</td></tr>`).join("");
  const rows = strains.map(([strain, entry]) => {
    const p = entry.fittedParameters ?? {};
    const e = entry.standardErrors ?? {};
    const cell = (v, s) => `${format(v, 4)}${s === null || s === undefined ? "" : ` ± ${format(s, 3)}`}`;
    const val = (m) => (m === null || m === undefined ? "—" : format(m, 4));
    const ci = entry.confidenceIntervals95?.zMicMgPerL;
    const temporal = entry.validationMetrics?.temporalResidualDiagnostics;
    const temporalTrend = temporal
      ? t("research.kill.temporalTrendValue", {
        flagged: temporal.highMagnitudeTrendTrajectoryCount,
        evaluated: temporal.evaluatedTrajectoryCount,
      })
      : "—";
    return `<tr><th scope="row">${escapeHtml(strain)}</th><td><span class="research-chip research-chip-${entry.status === "FIT_COMPLETED" ? "success" : "warning"}">${escapeHtml(t(`research.kill.fitStatus.${entry.status}`))}</span></td><td>${escapeHtml(entry.drugId ?? "—")}</td>
      <td>${cell(p.psiMaxLog10PerHour, e.psiMaxLog10PerHour)}</td><td>${cell(p.psiMinLog10PerHour, e.psiMinLog10PerHour)}</td>
      <td>${cell(p.zMicMgPerL, e.zMicMgPerL)}</td><td>${ci ? `[${format(ci[0], 4)}, ${format(ci[1], 4)}]` : "—"}</td><td>${cell(p.hillKappa, e.hillKappa)}</td>
      <td>${cell(p.initialLog10PopulationDensity, e.initialLog10PopulationDensity)}</td><td>${cell(p.sigmaLog10Residual, e.sigmaLog10Residual)}</td>
      <td>${val(entry.trainingMetrics?.rmseLog10)}</td><td>${val(entry.validationMetrics?.rmseLog10)}</td>
      <td>${entry.validationMetrics?.censoredPredictionHitRate === null || entry.validationMetrics?.censoredPredictionHitRate === undefined ? "—" : `${Math.round(entry.validationMetrics.censoredPredictionHitRate * 100)}%`}</td>
      <td>${escapeHtml(temporalTrend)}</td></tr>`;
  }).join("");
  const temporalReference = strains.map(([, entry]) => entry.validationMetrics?.temporalResidualDiagnostics).find(Boolean);
  const temporalNote = temporalReference
    ? t("research.kill.temporalTrendNote", {
      minimum: temporalReference.minimumExactPointCount,
      threshold: format(temporalReference.strongCorrelationThreshold, 2),
    })
    : t("research.kill.temporalTrendNoteDefault");
  const temporalTrajectoryRows = strains.flatMap(([strain, entry]) => (
    entry.validationMetrics?.temporalResidualDiagnostics?.trajectories ?? []
  ).map((trajectory) => {
    const status = t(`research.kill.temporalTrendStatus.${trajectory.status}`);
    const signal = trajectory.highMagnitudeTrend ? t("research.kill.temporalTrendSignal") : "—";
    return `<tr><th scope="row">${escapeHtml(strain)}</th>
      <td>${escapeHtml(trajectory.independentUnitId ?? "—")}</td>
      <td>${escapeHtml(String(trajectory.exactObservationCount ?? 0))}</td>
      <td>${escapeHtml(String(trajectory.leftCensoredObservationCount ?? 0))}</td>
      <td>${Number.isFinite(trajectory.spearmanRho) ? trajectory.spearmanRho.toFixed(3) : "—"}</td>
      <td>${escapeHtml(status)}</td><td>${escapeHtml(signal)}</td></tr>`;
  }));
  const temporalDetails = temporalTrajectoryRows.length
    ? `<details><summary>${escapeHtml(t("research.kill.temporalTrendTableHeading"))}</summary>
      <div class="research-table-scroll"><table class="research-table"><thead><tr>
        <th scope="col">${escapeHtml(t("research.kill.strain"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendUnit"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendExactCount"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendCensoredCount"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendRho"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendStatusHeading"))}</th>
        <th scope="col">${escapeHtml(t("research.kill.temporalTrendSignalHeading"))}</th>
      </tr></thead><tbody>${temporalTrajectoryRows.join("")}</tbody></table></div></details>`
    : "";
  const ciKeys = [
    ["psiMaxLog10PerHour", "ψmax log10/h"],
    ["psiMinLog10PerHour", "ψmin log10/h"],
    ["zMicMgPerL", "zMIC mg/L"],
    ["hillKappa", "κ"],
    ["initialLog10PopulationDensity", "N0 log10"],
    ["sigmaLog10Residual", "σ"],
  ];
  const ciRows = strains.map(([strain, entry]) => {
    const ci = entry.confidenceIntervals95 ?? {};
    return `<tr><th scope="row">${escapeHtml(strain)}</th>${ciKeys.map(([key]) => {
      const v = ci[key];
      return `<td>${Array.isArray(v) ? `[${format(v[0], 4)}, ${format(v[1], 4)}]` : "—"}</td>`;
    }).join("")}</tr>`;
  }).join("");
  return `<article class="research-card" aria-labelledby="research-kill-result-title"><div class="research-card-heading"><div><p class="eyebrow">kill workflow</p><h2 id="research-kill-result-title">${escapeHtml(t("research.kill.resultHeading"))}</h2></div><span class="research-chip research-chip-${result.status === "FIT_COMPLETED" ? "success" : "warning"}">${escapeHtml(t(`research.kill.fitStatus.${result.status}`))}</span></div>
    <p class="research-note">${escapeHtml(t("research.kill.resultNote"))}</p><details><summary>${escapeHtml(t("research.kill.runMetadata"))}</summary><pre>${escapeHtml(JSON.stringify(result.runMetadata, null, 2))}</pre></details>
    <h3>${escapeHtml(t("research.kill.fitDiagnosticHeading"))}</h3><div class="research-table-scroll"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.kill.strain"))}</th><th scope="col">${escapeHtml(t("research.results.converged"))}</th><th scope="col">${escapeHtml(t("research.results.profileStatusLabel"))}</th><th scope="col">${escapeHtml(t("research.kill.sigmaLowerBound"))}</th></tr></thead><tbody>${diagnosticSummaryRows}</tbody></table></div>
    <h3>${escapeHtml(t("research.kill.boundaryParameters"))}</h3>${parameterBoundaryRows ? `<div class="research-table-scroll"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.kill.strain"))}</th><th scope="col">${escapeHtml(t("research.results.parameter"))}</th><th scope="col">${escapeHtml(t("research.results.boundSide"))}</th><th scope="col">${escapeHtml(t("research.results.boundValue"))}</th><th scope="col">${escapeHtml(t("research.results.boundLimit"))}</th></tr></thead><tbody>${parameterBoundaryRows}</tbody></table></div>` : `<p class="research-empty">${escapeHtml(t("research.results.noBoundaryParameters"))}</p>`}
    <div class="research-table-scroll"><table class="research-table"><thead><tr>
      <th scope="col">${escapeHtml(t("research.kill.strain"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th><th scope="col">${escapeHtml(t("research.kill.drug"))}</th>
      <th scope="col">ψmax log10/h</th><th scope="col">ψmin log10/h</th><th scope="col">zMIC mg/L</th><th scope="col">zMIC 95% CI</th><th scope="col">κ</th>
      <th scope="col">N0 log10</th><th scope="col">σ</th>
      <th scope="col">${escapeHtml(t("research.kill.trainRmse"))}</th><th scope="col">${escapeHtml(t("research.kill.valRmse"))}</th><th scope="col">${escapeHtml(t("research.kill.censoredHit"))}</th><th scope="col">${escapeHtml(t("research.kill.temporalTrend"))}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="research-note">${escapeHtml(temporalNote)}</p>
    ${temporalDetails}
    <h3>${escapeHtml(t("research.kill.fullCi"))}</h3>
    <div class="research-table-scroll"><table class="research-table"><thead><tr>
      <th scope="col">${escapeHtml(t("research.kill.strain"))}</th>${ciKeys.map(([, label]) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}
    </tr></thead><tbody>${ciRows}</tbody></table></div>
    ${strains.flatMap(([, entry]) => (entry.incompleteUnits ?? []).map((unit) => `<p class="research-note">${escapeHtml(t("research.kill.incompleteUnit", { unit: unit.independentUnitId, times: unit.missingTimes.join(", ") }))}</p>`)).join("")}
    ${renderKillUnitIdentifiability(strains, t)}</article>`;
}

function renderAnalysis(context) {
  const { state, t } = context;
  const dataset = state.selectedDataset;
  const killMode = Boolean(dataset?.killEligible && !dataset?.workflowEligible);
  const ready = (dataset?.workflowEligible || dataset?.killEligible) && dataset?.qualityReport?.valid;
  const progress = state.progress;
  return `<section class="research-section" id="research-analysis-section" aria-labelledby="research-analysis-heading"><div class="research-section-heading"><p class="eyebrow">03 · ${escapeHtml(t("research.section.analysis"))}</p><h2 id="research-analysis-heading" tabindex="-1" data-focus-key="research-section-heading-analysis">${escapeHtml(t("research.analysis.heading"))}</h2><p>${escapeHtml(t("research.analysis.lead"))}</p></div>
    <article class="research-card research-run-card"><div class="research-card-heading"><div><h2>${escapeHtml(t("research.analysis.runLocked"))}</h2><p>${escapeHtml(state.selectedDataset?.title ?? t("research.data.noneSelected"))}</p></div>${datasetStatus(state.selectedDataset, t)}</div>
      <div class="research-progress" role="status" aria-live="polite" aria-atomic="true" aria-busy="${state.running}"><div class="research-progress-row"><label id="research-progress-phase" for="research-progress-bar">${escapeHtml(t(`research.progress.${state.cancelling ? "cancelling" : progress.phase}`))}</label><span id="research-progress-value">${Math.round(progress.fraction * 100)}%</span></div><progress id="research-progress-bar" max="1" value="${attr(progress.fraction)}" aria-labelledby="research-progress-phase research-progress-value">${Math.round(progress.fraction * 100)}%</progress></div>
      ${state.analysisError ? `<div class="research-callout research-callout-danger" role="alert">${escapeHtml(state.analysisError)}</div>` : ""}
      ${!ready ? `<p class="research-callout research-callout-warning">${escapeHtml(t("research.analysis.disabledReason"))}</p>` : ""}
      ${killMode ? `<p class="research-note">${escapeHtml(t("research.kill.engineNote"))}</p>` : ""}
      <div class="research-actions"><button class="primary-button" type="button" data-action="research-run" ${!ready || state.running || state.busy || state.packageOperation ? "disabled" : ""}>${escapeHtml(t(killMode ? "research.kill.run" : "research.analysis.run"))}</button><button class="danger-button" type="button" data-action="research-cancel" ${state.running && !state.cancelling ? "" : "disabled"}>${escapeHtml(t(state.cancelling ? "research.analysis.cancelling" : "research.analysis.cancel"))}</button></div>
      <p class="research-note">${escapeHtml(t("research.analysis.workerNote"))}</p>
    </article>
    ${state.killResult ? renderKillResult(state.killResult, t) : ""}
    ${packagePanel(state, t)}
    <article class="research-card"><h2>${escapeHtml(t("research.analysis.saved"))}</h2><p>${escapeHtml(t("research.analysis.savedNote"))}</p>${priorAnalyses(state, t)}</article>
  </section>`;
}

function metricRows(metrics) {
  return [
    ["macro RMSE", metrics?.macroRmse],
    ["pooled RMSE", metrics?.pooledRmse],
    ["MAE", metrics?.mae],
    ["mean residual", metrics?.meanResidual],
    ["median absolute error", metrics?.medianAbsoluteError],
  ];
}

function metricsTable(result, t) {
  const training = result.training?.metrics;
  const validation = result.validation?.metrics;
  const baseline = validation?.baselineComparison?.baselineMetrics;
  return `<div class="research-table-scroll" data-scroll-key="research-metrics"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.results.metric"))}</th><th scope="col">${escapeHtml(t("research.data.training"))}</th><th scope="col">${escapeHtml(t(researchEvaluationRole(result) === "development" ? "research.development.label" : "research.data.validation"))}</th><th scope="col">${escapeHtml(t("research.results.baseline"))}</th></tr></thead><tbody>${metricRows(training).map(([name, value], index) => `<tr><th scope="row">${escapeHtml(name)}</th><td>${format(value)}</td><td>${format(metricRows(validation)[index][1])}</td><td>${format(metricRows(baseline)[index][1])}</td></tr>`).join("")}</tbody></table></div>`;
}

function booleanText(value) {
  return typeof value === "boolean" ? String(value) : "—";
}

function assessmentPanel(result, t) {
  const assessment = result?.researchAssessment;
  if (!assessment) return "";
  return `<article class="research-card"><h2>${escapeHtml(t("research.assessment.heading"))}</h2><dl class="research-fact-grid">${["completed", "converged", "identified", "precisionAssessed"].map((key) => `<div><dt>${escapeHtml(t(`research.assessment.${key}`))}</dt><dd>${booleanText(assessment[key])}</dd></div>`).join("")}</dl><p>${escapeHtml(t("research.assessment.note"))}</p>${jsonDetails(t("research.results.precision"), { convergence: assessment.convergence, identification: assessment.identification, precision: assessment.precision })}</article>`;
}

function trajectoryPredictionPanel(prediction, t) {
  if (!prediction) return "";
  const statusKey = `research.growth.predictionStatus.${prediction.status ?? "unavailable"}`;
  const fitIds = prediction.fit?.trainingIndependentUnitIds ?? [];
  const calibrationIds = prediction.calibration?.calibrationIndependentUnitIds ?? [];
  const bands = Object.entries(prediction.bands ?? {}).map(([level, band]) => ({ level: Number(level), band }));
  const rows = bands.map(({ level, band }) => `<tr><th scope="row">${format(level * 100, 0)}%</th>
      <td>${escapeHtml(t(`research.growth.predictionStatus.${band.status}`))}</td>
      <td>${format(band.radius)}</td><td>${format(band.predictions?.length ?? 0, 0)}</td></tr>`).join("");
  return `<h3>${escapeHtml(t("research.growth.prediction"))}</h3>
    <p>${escapeHtml(t("research.growth.predictionNote"))}</p>
    <p class="research-callout ${prediction.status === "available" ? "research-callout-info" : "research-callout-warning"}"><strong>${escapeHtml(t(statusKey))}</strong>
      · ${escapeHtml(prediction.fit?.model ?? "—")} · ${escapeHtml(t("research.growth.predictionFitUnits"))}: ${fitIds.length}
      · ${escapeHtml(t("research.growth.predictionCalibrationUnits"))}: ${calibrationIds.length}</p>
    <div class="research-table-scroll"><table class="research-table"><thead><tr>
      <th scope="col">${escapeHtml(t("research.growth.predictionLevel"))}</th>
      <th scope="col">${escapeHtml(t("research.table.status"))}</th>
      <th scope="col">${escapeHtml(t("research.growth.predictionRadius"))}</th>
      <th scope="col">${escapeHtml(t("research.growth.predictionTimeCount"))}</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <p class="research-callout research-callout-warning">${escapeHtml(t("research.growth.predictionLimitation"))}</p>
    ${jsonDetails(t("research.growth.predictionDetails"), {
    split: prediction.split,
    calibrationSelection: prediction.calibrationSelection,
    fit: prediction.fit,
    calibration: prediction.calibration,
    predictionTimeHours: prediction.predictionTimeHours,
    bands: prediction.bands,
  })}`;
}

function growthPanel(result, t) {
  const growth = result.growthComparison;
  if (!growth) return "";
  const selection = growth.selection;
  const bootstrap = growth.bootstrap;
  const intervals = bootstrap?.intervals;
  return `<article class="research-card"><h2>${escapeHtml(t("research.growth.heading"))}</h2><p>${escapeHtml(t("research.growth.design"))}</p>
    <div class="research-table-scroll" data-scroll-key="research-growth-cv"><table class="research-table"><thead><tr>${["model", "cv", "fit", "eligible", "convergence"].map((key) => `<th scope="col">${escapeHtml(t(`research.growth.${key}`))}</th>`).join("")}</tr></thead><tbody>${Object.entries(growth.crossValidation?.candidates ?? {}).map(([name, candidate]) => {
      const fit = growth.trainingFits?.[name];
      const folds = candidate.folds ?? [];
      return `<tr><th scope="row">${escapeHtml(name)}</th><td>${format(candidate.score)}</td><td>${format(fit?.metrics?.macroRmse)}</td><td>${booleanText(candidate.eligible)} · finite: ${booleanText(fit?.finite)}</td><td>${booleanText(fit?.converged)} / ${folds.filter((fold) => fold.fit?.converged === true).length} / ${folds.length}</td></tr>`;
    }).join("")}</tbody></table></div>
    <h3>${escapeHtml(t("research.growth.selection"))}</h3><p>${escapeHtml(selection?.selectedModel)} · ${escapeHtml(selection?.sourceRole)} · ${escapeHtml(selection?.metric)}: ${format(selection?.selectedScore)} · frozenBeforeDevelopment: ${booleanText(selection?.frozenBeforeDevelopment)}</p>
    <p>${escapeHtml(t("research.growth.tie"))}: ${escapeHtml(selection?.tieOrder?.join(" → "))} / ${format(selection?.tieTolerance)}</p>
    <h3>${escapeHtml(t("research.growth.development"))}</h3><p>${escapeHtml(t("research.development.note"))}</p>
    <div class="research-table-scroll" data-scroll-key="research-growth-development"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.results.metric"))}</th><th scope="col">${escapeHtml(selection?.selectedModel)} · ${escapeHtml(growth.development?.selected?.status)}</th><th scope="col">${escapeHtml(t("research.results.baseline"))} · ${escapeHtml(growth.development?.baseline?.status)}</th></tr></thead><tbody>${metricRows(growth.development?.selected?.metrics).map(([name, value], index) => `<tr><th scope="row">${escapeHtml(name)}</th><td>${format(value)}</td><td>${format(metricRows(growth.development?.baseline?.metrics)[index][1])}</td></tr>`).join("")}</tbody></table></div><p>Δ macro RMSE: ${format(growth.development?.deltaMacroRmseVsBaseline)} · ${escapeHtml(t("research.development.baselineNote"))}</p>
    <h3>${escapeHtml(t("research.growth.bootstrap"))}</h3><dl class="research-fact-grid"><div><dt>${escapeHtml(t("research.growth.refits"))}</dt><dd>${format(bootstrap?.successfulSamples, 0)} / ${format(bootstrap?.requestedSamples, 0)}</dd></div><div><dt>${escapeHtml(t("research.growth.failures"))}</dt><dd>${format(bootstrap?.failures?.length, 0)}</dd></div><div><dt>jointSamplesRetained</dt><dd>${booleanText(bootstrap?.jointSamplesRetained)}</dd></div><div><dt>${escapeHtml(t("research.assessment.precisionAssessed"))}</dt><dd>${booleanText(intervals?.precisionAssessed)}</dd></div><div><dt>tailResolutionAdequate</dt><dd>${booleanText(intervals?.tailResolutionAdequate)}</dd></div></dl>
    <p class="research-callout research-callout-warning">${escapeHtml(t("research.growth.warning"))}</p>${jsonDetails(t("research.growth.intervals"), intervals)}
    ${trajectoryPredictionPanel(growth.trajectoryPrediction, t)}${issueList([...(growth.warnings ?? []), ...(bootstrap?.warnings ?? [])], t("research.data.noWarnings"))}
  </article>`;
}

function sensitivityPanel(result, t) {
  const rows = researchSensitivityRows(result);
  if (!rows.length) return "";
  const interval = (value) => Array.isArray(value) ? `[${value.map((entry) => format(entry)).join(", ")}]` : "—";
  const morris = result.analyses.sensitivity.morris;
  const bootstrap = result.analyses.sensitivity.sobolJansen?.bootstrap;
  return `<article class="research-card"><h2>${escapeHtml(t("research.results.sobol"))}</h2><p>${escapeHtml(t("research.results.sobolNote"))}</p>${bootstrap ? `<p>${escapeHtml(t("research.results.sobolBootstrap", { level: format(bootstrap.confidenceLevel * 100, 1), replicates: format(bootstrap.replicates, 0) }))}</p>` : ""}<p>Morris: ${escapeHtml(morris?.effectScale ?? "—")} · ${escapeHtml(morris?.normalization ?? "")}</p><div class="research-table-scroll" data-scroll-key="research-sobol"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.table.field"))}</th><th scope="col">Morris μ*</th><th scope="col">Sobol S1</th><th scope="col">Sobol ST</th><th scope="col">${escapeHtml(t("research.results.precision"))}</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row">${escapeHtml(row.name)}</th><td>${format(row.morris.muStar)}</td><td>${format(row.sobol.firstOrder)} ${interval(row.sobol.firstOrderInterval)}</td><td>${format(row.sobol.totalOrder)} ${interval(row.sobol.totalOrderInterval)}</td><td>${escapeHtml(JSON.stringify(row.sobol.precision ?? null))}</td></tr>`).join("")}</tbody></table></div></article>`;
}

function objectiveSlicesPanel(result, t) {
  const slices = result.identifiability?.objectiveSlices ?? result.identifiability?.profiles ?? [];
  if (!slices.length) return "";
  return `<article class="research-card"><h2>${escapeHtml(t("research.results.slices"))}</h2><p>${escapeHtml(t("research.results.slicesNote"))}</p>${slices.map((slice, index) => `<h3>${escapeHtml(slice.parameter)}</h3><p>${escapeHtml(slice.interpretation)}</p><div class="research-table-scroll" data-scroll-key="research-slice-${index}"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(slice.parameter)}</th><th scope="col">${escapeHtml(t("research.results.objective"))}</th><th scope="col">${escapeHtml(t("research.table.status"))}</th></tr></thead><tbody>${(slice.values ?? []).map((entry) => `<tr><th scope="row">${format(entry.parameterValue)}</th><td>${format(entry.objectiveValue)}</td><td>${escapeHtml(entry.status)}</td></tr>`).join("")}</tbody></table></div>`).join("")}</article>`;
}

function warningCollection(record, result) {
  const quality = record?.qualityReport;
  const capabilityGates = (result?.capability?.gates ?? [])
    .filter((gate) => gate.passed === false)
    .map((gate) => ({ severity: "warning", code: gate.code, message: gate.message }));
  return [
    ...(record?.importWarnings ?? []),
    ...(quality?.warnings ?? []),
    ...(result?.dataset?.importWarnings ?? []),
    ...(result?.dataset?.quality?.warnings ?? []),
    ...(result?.warnings ?? []),
    ...(result?.capability?.warnings ?? []),
    ...capabilityGates,
    ...(result?.identifiability?.warnings ?? []),
    ...(result?.analyses?.parameterScan?.warnings ?? []),
    ...(result?.analyses?.monteCarlo?.warnings ?? []),
    ...(result?.analyses?.sensitivity?.morris?.warnings ?? []),
    ...(result?.analyses?.sensitivity?.sobolJansen?.warnings ?? []),
  ];
}

function resultSummary(state, t) {
  const result = state.result;
  const development = researchEvaluationRole(result) === "development";
  const evaluationKey = (newKey, oldKey) => development ? `research.development.${newKey}` : `research.results.${oldKey}`;
  const training = result.training;
  const biological = training.fittedBiologicalParameters;
  const psi = biological.psiMaxLog10PerHour;
  const doubling = Number.isFinite(psi) && psi > 0 ? (Math.log10(2) / psi) * 60 : NaN;
  const initial = biological["initialStates.pooled.log10PopulationDensity"];
  const nuisance = training.profiledObservationLayer;
  const optimization = training.optimization;
  const comparison = result.validation?.metrics?.baselineComparison;
  const diagnostics = training.fitDiagnostics ?? {};
  const profileLikelihood = diagnostics.profileLikelihood ?? {};
  const boundaryHits = diagnostics.boundary?.parametersAtBound ?? [];
  const fitStatusText = t(`research.results.fitStatus.${result.status ?? training.status ?? "FIT_COMPLETED"}`);
  const profileStatusText = t(`research.results.profileStatus.${profileLikelihood.status ?? "NOT_ASSESSED"}`);
  const boundaryRows = boundaryHits.map((hit) => `<tr><th scope="row">${escapeHtml(hit.parameter)}</th><td>${escapeHtml(hit.side)}</td><td>${format(hit.value)}</td><td>${format(hit.bound)}</td></tr>`).join("");
  return `<div class="research-results-stack"><article class="research-card"><h2>${escapeHtml(t("research.results.diagnosticsHeading"))}</h2><dl class="research-fact-grid"><div><dt>${escapeHtml(t("research.results.fitStatusLabel"))}</dt><dd>${escapeHtml(fitStatusText)}</dd></div><div><dt>${escapeHtml(t("research.results.profileStatusLabel"))}</dt><dd>${escapeHtml(profileStatusText)}</dd></div><div><dt>${escapeHtml(t("research.results.boundaryCount"))}</dt><dd>${boundaryHits.length}</dd></div><div><dt>${escapeHtml(t("research.results.sigmaAtLowerBound"))}</dt><dd>${booleanText(diagnostics.sigmaAtLowerBound)}</dd></div></dl>${boundaryHits.length ? `<h3>${escapeHtml(t("research.results.boundaryParameters"))}</h3><div class="research-table-scroll"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.results.parameter"))}</th><th scope="col">${escapeHtml(t("research.results.boundSide"))}</th><th scope="col">${escapeHtml(t("research.results.boundValue"))}</th><th scope="col">${escapeHtml(t("research.results.boundLimit"))}</th></tr></thead><tbody>${boundaryRows}</tbody></table></div>` : `<p class="research-empty">${escapeHtml(t("research.results.noBoundaryParameters"))}</p>`}<details><summary>${escapeHtml(t("research.results.profileDetails"))}</summary><pre>${escapeHtml(JSON.stringify(profileLikelihood, null, 2))}</pre></details></article>${!development ? `<p class="research-callout research-callout-warning">${escapeHtml(t("research.results.historical"))}</p>` : ""}${assessmentPanel(result, t)}<article class="research-card research-capability-card"><div><p class="eyebrow">${escapeHtml(t("research.results.runCapability"))}</p><h2>${escapeHtml(result.capability?.level ?? "L3")}</h2></div><p>${escapeHtml(t("research.results.capabilityNote"))}</p><span class="research-chip research-chip-warning">${escapeHtml(t("research.results.l4Ineligible"))}</span></article>
    <article class="research-card"><h2>${escapeHtml(t(evaluationKey("roles", "roles")))}</h2><div class="research-role-grid"><section><span class="research-chip research-chip-info">${escapeHtml(t("research.data.training"))}</span><h3>${escapeHtml(t("research.results.trainingRole"))}</h3><p>${escapeHtml(t(evaluationKey("trainingNote", "trainingRoleNote")))}</p><dl><div><dt>${escapeHtml(t("research.data.observations"))}</dt><dd>${format(training.observationCount, 0)}</dd></div><div><dt>${escapeHtml(t("research.data.units"))}</dt><dd>${format(training.independentUnitCount, 0)}</dd></div></dl></section><section><span class="research-chip research-chip-warning">${escapeHtml(t(development ? "research.development.label" : "research.data.validation"))}</span><h3>${escapeHtml(t(evaluationKey("role", "validationRole")))}</h3><p>${escapeHtml(t(evaluationKey("note", "validationRoleNote")))}</p><dl><div><dt>${escapeHtml(t("research.data.observations"))}</dt><dd>${format(result.validation?.observationCount, 0)}</dd></div><div><dt>${escapeHtml(t("research.data.units"))}</dt><dd>${format(result.validation?.independentUnits?.validation?.length, 0)}</dd></div></dl></section></div></article>
    <article class="research-card"><h2>${escapeHtml(t("research.results.fit"))}</h2><dl class="research-fact-grid"><div><dt>psiMax</dt><dd>${format(psi)} log10/h</dd></div><div><dt>${escapeHtml(t("research.results.doubling"))}</dt><dd>${format(doubling, 2)} min</dd></div><div><dt>${escapeHtml(t("research.results.initial"))}</dt><dd>${format(initial)} log10 CFU/mL</dd></div><div><dt>baselineOd</dt><dd>${format(nuisance.baselineOd)}</dd></div><div><dt>scaleOd</dt><dd>${format(nuisance.scaleOd)}</dd></div><div><dt>${escapeHtml(t("research.results.converged"))}</dt><dd>${escapeHtml(String(training.converged))}</dd></div><div><dt>${escapeHtml(t("research.results.evaluations"))}</dt><dd>${escapeHtml(optimization.evaluationCount)}</dd></div><div><dt>${escapeHtml(t("research.results.termination"))}</dt><dd>${escapeHtml(optimization.terminationReason)}</dd></div></dl><p class="research-note">${escapeHtml(t(evaluationKey("profiled", "profiledTraining")))}</p></article>
    <article class="research-card"><h2>${escapeHtml(t(evaluationKey("metrics", "metrics")))}</h2>${metricsTable(result, t)}<p class="research-note"><strong>${escapeHtml(t("research.results.predeclared"))}:</strong> ${escapeHtml(comparison?.baselineId ?? "training-unit-mean-od-by-exact-source-time")}. ${escapeHtml(t(evaluationKey("baselineNote", "baselineNote")))}</p></article>
    <article class="research-card"><h2>${escapeHtml(t("research.results.identifiability"))}</h2><dl class="research-fact-grid"><div><dt>${escapeHtml(t("research.results.rank"))}</dt><dd>${escapeHtml(`${result.identifiability?.rank ?? "—"}/${result.identifiability?.parameterNames?.length ?? "—"}`)}</dd></div><div><dt>${escapeHtml(t("research.results.conditionNumber"))}</dt><dd>${format(result.identifiability?.conditionNumber)}</dd></div><div><dt>${escapeHtml(t("research.results.trainingResidualRms"))}</dt><dd>${format(training.residualSummary?.rootMeanSquare)}</dd></div><div><dt>${escapeHtml(t(evaluationKey("residual", "validationResidualRms")))}</dt><dd>${format(result.validation?.metrics?.pooledRmse)}</dd></div></dl>${result.identifiability?.correlations?.length ? `<div class="research-table-scroll" data-scroll-key="research-identifiability-correlations"><table class="research-table"><thead><tr><th scope="col">${escapeHtml(t("research.results.parameterPair"))}</th><th scope="col">${escapeHtml(t("research.results.correlation"))}</th></tr></thead><tbody>${result.identifiability.correlations.map((row) => `<tr><th scope="row">${escapeHtml(row.parameters.join(" ↔ "))}</th><td>${format(row.correlation)}</td></tr>`).join("")}</tbody></table></div>` : ""}</article>
  </div>`;
}

function resultCharts(state, t) {
  const units = state.result?.validation?.independentUnits?.validation ?? [];
  return `<article class="research-card"><div class="research-card-heading"><div><h2>${escapeHtml(t("research.results.charts"))}</h2><p>${escapeHtml(t("research.results.chartsNote"))}</p></div><label class="research-field research-unit-field"><span>${escapeHtml(t(researchEvaluationRole(state.result) === "development" ? "research.development.unit" : "research.results.validationUnit"))}</span><select name="research-validation-unit">${units.map((unit) => `<option value="${attr(unit)}" ${unit === state.selectedValidationUnit ? "selected" : ""}>${escapeHtml(unit)}</option>`).join("")}</select></label></div><div id="research-chart-dashboard" class="research-chart-dashboard"></div></article>`;
}

function resultWarnings(state, t) {
  const warnings = warningCollection(state.selectedDataset, state.result);
  return `<article class="research-card research-warning-card"><h2>${escapeHtml(t("research.results.warnings"))}</h2><p>${escapeHtml(t("research.results.warningNote"))}</p>${issueList(warnings, t("research.data.noWarnings"))}<div class="research-callout research-callout-warning"><strong>${escapeHtml(t(researchEvaluationRole(state.result) === "development" ? "research.development.label" : "research.results.validationBoundary"))}</strong><p>${escapeHtml(state.result.validation?.l4IneligibilityReason ?? t("research.limit.independence"))}</p></div></article>`;
}

function renderResults(context) {
  const { state, t } = context;
  if (!state.result) return `<section class="research-section" id="research-results-section" aria-labelledby="research-results-heading"><div class="research-section-heading"><p class="eyebrow">04 · ${escapeHtml(t("research.section.results"))}</p><h2 id="research-results-heading" tabindex="-1" data-focus-key="research-section-heading-results">${escapeHtml(t("research.results.heading"))}</h2><p>${escapeHtml(t("research.results.lead"))}</p></div><article class="research-card"><p class="research-empty">${escapeHtml(t("research.results.empty"))}</p></article></section>`;
  if (state.result.status === "NOT_IDENTIFIABLE" && !state.result.training?.fittedBiologicalParameters) {
    const result = state.result;
    const diagnostics = result.training?.fitDiagnostics ?? {};
    const identifiability = diagnostics.identifiability ?? result.identifiability;
    return `<section class="research-section" id="research-results-section" aria-labelledby="research-results-heading"><div class="research-section-heading"><p class="eyebrow">04 · ${escapeHtml(t("research.section.results"))}</p><h2 id="research-results-heading" tabindex="-1" data-focus-key="research-section-heading-results">${escapeHtml(t("research.results.heading"))}</h2><p>${escapeHtml(t("research.results.runLabel", { runId: result.runMetadata?.runId ?? "—" }))}</p></div><article class="research-card"><div class="research-card-heading"><h2>${escapeHtml(t("research.results.statusOnly"))}</h2><span class="research-chip research-chip-warning">${escapeHtml(t("research.results.fitStatus.NOT_IDENTIFIABLE"))}</span></div><p class="research-callout research-callout-warning">${escapeHtml(t("research.results.noEstimates"))}</p><dl class="research-fact-grid"><div><dt>${escapeHtml(t("research.results.exactTrainingCount"))}</dt><dd>${format(result.dataset?.exactTrainingObservationCount, 0)}</dd></div><div><dt>${escapeHtml(t("research.results.requiredExactCount"))}</dt><dd>${format(identifiability?.requiredExactObservationCount, 0)}</dd></div><div><dt>${escapeHtml(t("research.results.profileStatus"))}</dt><dd>${escapeHtml(t("research.results.profileStatus.NOT_ASSESSED"))}</dd></div><div><dt>${escapeHtml(t("research.design.seed"))}</dt><dd>${format(result.runMetadata?.seed, 0)}</dd></div><div><dt>${escapeHtml(t("research.export.version"))}</dt><dd>${escapeHtml(result.runMetadata?.applicationVersion ?? result.applicationVersion ?? "unknown")}</dd></div></dl><details><summary>${escapeHtml(t("research.results.diagnosticDetails"))}</summary><pre>${escapeHtml(JSON.stringify({ identifiability, profileLikelihood: diagnostics.profileLikelihood, settings: result.runMetadata?.settings }, null, 2))}</pre></details></article></section>`;
  }
  return `<section class="research-section" id="research-results-section" aria-labelledby="research-results-heading"><div class="research-section-heading"><p class="eyebrow">04 · ${escapeHtml(t("research.section.results"))}</p><h2 id="research-results-heading" tabindex="-1" data-focus-key="research-section-heading-results">${escapeHtml(t("research.results.heading"))}</h2><p>${escapeHtml(t("research.results.runLabel", { runId: state.result.reproducibility?.runId ?? state.selectedAnalysis?.id ?? "—" }))}</p></div>${resultSummary(state, t)}${growthPanel(state.result, t)}${sensitivityPanel(state.result, t)}${objectiveSlicesPanel(state.result, t)}${resultCharts(state, t)}${resultWarnings(state, t)}</section>`;
}

export function renderResearchWorkspace({ state, catalog, registryRecord, sourceRecord, t, locale }) {
  state.locale = locale;
  const context = { state, catalog, registryRecord, sourceRecord, t, locale };
  const section = state.activeSection === "data"
    ? renderData(context)
    : state.activeSection === "design"
      ? renderDesign(context)
      : state.activeSection === "analysis"
        ? renderAnalysis(context)
        : renderResults(context);
  const resultStatus = state.result?.status;
  const resultStatusChip = !state.result ? ""
    : resultStatus === "NOT_IDENTIFIABLE" || resultStatus === "FIT_NOT_CONVERGED"
      ? `<span class="research-chip research-chip-warning">${escapeHtml(t(`research.results.fitStatus.${resultStatus}`))}</span>`
      : resultStatus === "FIT_COMPLETED" || !resultStatus
        ? `<span class="research-chip research-chip-success">${escapeHtml(t("research.results.capability", { level: state.result.capability?.level ?? "L3" }))}</span>`
        : `<span class="research-chip research-chip-warning">${escapeHtml(resultStatus)}</span>`;
  return `<main class="research-workspace" id="main-content" aria-labelledby="research-page-heading"><div class="research-hero"><div><p class="eyebrow">${escapeHtml(t("research.eyebrow"))}</p><h1 id="research-page-heading" tabindex="-1" data-focus-key="page-heading-research">${escapeHtml(t("research.title"))}</h1><p>${escapeHtml(t("research.subtitle"))}</p></div><div class="research-hero-status">${datasetStatus(state.selectedDataset, t)}${resultStatusChip}</div></div>${sectionNavigation(state, t)}${section}</main>`;
}

export { escapeHtml };
