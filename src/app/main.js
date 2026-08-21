import {
  evaluateRegoesNetGrowth,
  simulatePiecewise,
} from "../model.js";
import { loadScientificCatalog } from "./catalog-loader.browser.js?v=startup-fix-1";
import { renderLinkedCharts, serializeChartDashboard } from "./charts.js";
import { COURSE_STEPS, coursePreset, courseStep } from "./course.js";
import {
  advanceProject,
  compileSimulationRequest,
  createProject,
  diluteDrugConcentration,
  effectiveConcentration,
  hydrateProject,
  renameProject,
  resetProject,
  selectDrug,
  setInitialConditions,
  setPendingDose,
  washout,
} from "./experiment.js";
import {
  buildRunManifest,
  downloadText,
  trajectoryToCsv,
} from "./export.js";
import { createI18n } from "./i18n.js";
import { createProjectRepository } from "./persistence.js?v=startup-fix-1";
import { createResearchController } from "./research/controller.js";
import { routeFromHashValue } from "./research/state.js";
import { captureScrollPositions, restoreScrollPositions } from "./ui-state.js";
import { APPLICATION_VERSION } from "./version.js";

const app = document.querySelector("#app");
const TABLE_PAGE_SIZE = 12;
const LOCALE_STORAGE_KEY = "ecolab.locale";
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let pendingFocusKey = null;

const state = {
  catalog: null,
  repository: null,
  project: null,
  research: null,
  route: routeFromHash(),
  mobilePanel: "charts",
  explainTab: "formula",
  courseIndex: 0,
  populationScale: "log",
  concentrationScale: "xzmic",
  concentrationInputUnit: "xzmic",
  doseValue: 1,
  dilutionFold: 2,
  advanceValue: 30,
  advanceUnit: "minutes",
  selectedIndex: Number.MAX_SAFE_INTEGER,
  tablePage: 0,
  playing: false,
  playTimer: null,
  status: { key: "status.loading", tone: "info", params: {} },
  compareRows: null,
  exportOpen: false,
};

const i18n = createI18n(readInitialLocale());

syncDocumentMetadata();
window.addEventListener("hashchange", () => {
  const nextRoute = routeFromHash();
  if (nextRoute === state.route) return;
  stopPlayback(false);
  state.route = nextRoute;
  pendingFocusKey = routeHeadingFocusKey(nextRoute);
  if (nextRoute === "research") void state.research?.enter();
  else render();
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPlayback();
});
const handleReducedMotionChange = (event) => {
  if (event.matches) stopPlayback();
};
if (typeof reducedMotionQuery.addEventListener === "function") reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
else reducedMotionQuery.addListener?.(handleReducedMotionChange);
app.addEventListener("click", handleClick);
app.addEventListener("change", handleChange);
app.addEventListener("keydown", (event) => {
  const row = event.target.closest?.('[data-action="select-row"]');
  if (row && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    selectPoint(Number(row.dataset.index));
    return;
  }
  const tab = event.target.closest?.('[role="tab"]');
  if (tab) handleTabKeydown(event, tab);
});

initialize();

async function initialize() {
  try {
    const [catalog, repository] = await Promise.all([
      loadScientificCatalog(),
      createProjectRepository(),
    ]);
    state.catalog = catalog;
    state.repository = repository;
    state.project = newProject();
    state.research = createResearchController({
      app,
      catalog,
      repository,
      applicationVersion: APPLICATION_VERSION,
      downloadText,
      t: (...args) => i18n.t(...args),
      getLocale: () => i18n.locale,
      requestRender: render,
      requestFocus(key) {
        pendingFocusKey = key;
      },
      setStatus(status) {
        state.status = status;
      },
    });
    await state.research.initialize();
    state.status = { key: "status.loaded", tone: "success", params: {} };
    render();
  } catch (error) {
    console.error(error);
    state.status = {
      key: "status.fatal",
      tone: "danger",
      params: { message: errorMessage(error) },
    };
    renderFatal();
  }
}

function routeHeadingFocusKey(route) {
  return route === "research" ? "page-heading-research" : `page-heading-${route}`;
}

function syncDocumentMetadata(mode = "app") {
  document.documentElement.lang = i18n.locale;
  const skipLink = document.querySelector(".skip-link");
  if (skipLink) skipLink.textContent = i18n.t("app.skipToMain");
  const routeLabel = mode === "fatal"
    ? i18n.t("fatal.heading")
    : i18n.t(state.route === "research" ? "nav.research" : state.route === "sandbox" ? "nav.sandbox" : "nav.learn");
  document.title = `${i18n.t("app.title")} · ${routeLabel}`;
}

function assignStableFocusKeys(root) {
  const counts = new Map();
  for (const element of root.querySelectorAll("a[href], button, input, select, summary, [tabindex]")) {
    if (element.dataset.focusKey) continue;
    const base = element.id
      ? `id-${element.id}`
      : element.getAttribute("name")
        ? `name-${element.getAttribute("name")}`
        : element.dataset.action
          ? `action-${element.dataset.action}-${element.dataset.id ?? element.dataset.section ?? element.dataset.panel ?? element.dataset.index ?? element.dataset.value ?? "default"}`
          : element.getAttribute("href")
            ? `href-${element.getAttribute("href")}`
            : element.tagName.toLowerCase();
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    element.dataset.focusKey = count === 0 ? base : `${base}-${count + 1}`;
  }
}

function replaceAppHtml(markup) {
  const previousFocusKey = app.contains(document.activeElement) ? document.activeElement?.dataset?.focusKey : null;
  const focusKey = pendingFocusKey ?? previousFocusKey;
  const scrollPositions = captureScrollPositions(app);
  pendingFocusKey = null;
  app.innerHTML = markup;
  assignStableFocusKeys(app);

  let restored = false;
  return function restoreViewState() {
    if (restored) return;
    restored = true;
    restoreScrollPositions(app, scrollPositions);
    if (!focusKey) return;
    const target = [...app.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
    const fallback = [...app.querySelectorAll("[data-focus-key]")].find((element) => element.dataset.focusKey === routeHeadingFocusKey(state.route));
    const focusTarget = target && !target.disabled ? target : fallback;
    focusTarget?.focus({ preventScroll: true });
  };
}

function setExplainTab(tab, { focusTab = false } = {}) {
  state.explainTab = tab;
  if (focusTab) pendingFocusKey = `explain-tab-${tab}`;
  render();
}

function handleTabKeydown(event, tab) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabList = tab.closest('[role="tablist"]');
  const tabs = [...tabList?.querySelectorAll('[role="tab"]') ?? []].filter((candidate) => !candidate.disabled);
  const currentIndex = tabs.indexOf(tab);
  if (currentIndex < 0 || tabs.length === 0) return;
  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[nextIndex].click();
}

function readInitialLocale() {
  try {
    const saved = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (saved === "en" || saved === "zh-CN") return saved;
  } catch {
    // Locale persistence is optional.
  }
  return navigator.language?.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

function routeFromHash() {
  return routeFromHashValue(location.hash);
}

function newProject(id) {
  const { resolvedModel } = state.catalog;
  return createProject({
    id,
    modelRef: { id: resolvedModel.ref.id, version: resolvedModel.ref.version },
    parameterSetRef: {
      id: resolvedModel.ref.parameterSetId,
      version: resolvedModel.ref.parameterSetVersion,
    },
  });
}

function availableDrugIds() {
  return state.catalog.drugRegistry.records.map((drug) => drug.id);
}

function drugRecord(drugId = state.project.drugId) {
  return state.catalog.drugRegistry.records.find((drug) => drug.id === drugId);
}

function zMicFor(drugId = state.project.drugId) {
  return state.catalog.resolvedModel.parameters.drugs[drugId]?.zMicMgPerL ?? null;
}

function deriveScientificView() {
  const project = state.project;
  const model = state.catalog.resolvedModel;
  let request = null;
  let result = null;

  if (project.currentTimeMinutes > 0 && project.segments.length > 0) {
    const committedProject = project.pendingAction
      ? { ...project, pendingAction: null }
      : project;
    request = compileSimulationRequest(committedProject);
    result = simulatePiecewise(model, request);
  }

  const concentrationMgPerL = effectiveConcentration(project);
  const previewGrowth = evaluateRegoesNetGrowth(
    model.parameters,
    project.drugId,
    concentrationMgPerL,
  );
  const chartTrajectory = result?.trajectory ?? [
    {
      timeHours: 0,
      drugId: project.drugId,
      concentrationMgPerL,
      netGrowthLog10PerHour: previewGrowth,
      latentLog10PopulationDensity: Math.log10(project.initialPopulationCfuPerMl),
      belowDetectionLimit: project.initialPopulationCfuPerMl < project.detectionLimitCfuPerMl,
      detectionLimitLog10: Math.log10(project.detectionLimitCfuPerMl),
    },
  ];
  const selectedIndex = Math.max(
    0,
    Math.min(chartTrajectory.length - 1, Number.isFinite(state.selectedIndex) ? state.selectedIndex : 0),
  );

  return { request, result, chartTrajectory, selectedIndex };
}

function render() {
  if (!state.catalog || !state.project || !state.research) return;
  if (state.route === "research") {
    renderResearchShell();
    return;
  }
  const science = deriveScientificView();
  state.selectedIndex = science.selectedIndex;
  state.tablePage = Math.max(
    0,
    Math.min(
      Math.ceil(science.chartTrajectory.length / TABLE_PAGE_SIZE) - 1,
      state.tablePage,
    ),
  );

  const currentDrug = drugRecord();
  const zMic = zMicFor();
  const concentration = effectiveConcentration(state.project);
  const concentrationRatio = zMic ? concentration / zMic : 0;
  const routeIsLearn = state.route === "learn";
  const currentCourseStep = courseStep(state.courseIndex);

  syncDocumentMetadata();
  const restoreViewState = replaceAppHtml(`
    <div class="app-shell">
      ${renderHeader()}
      <div class="evidence-banner" role="note">
        <strong>${escapeHtml(i18n.t("badge.validation"))}</strong>
        <span>${escapeHtml(i18n.t("warning.transfer"))}</span>
      </div>
      ${!state.repository.persistent ? `<div class="memory-banner" role="alert">${escapeHtml(i18n.t("warning.memory"))}</div>` : ""}
      ${routeIsLearn ? renderCourse(currentCourseStep) : ""}
      <main class="workspace" id="main-content" role="tabpanel" aria-labelledby="${routeIsLearn ? "learn-route-tab" : "sandbox-route-tab"}" tabindex="0">
        ${routeIsLearn ? "" : `<h1 class="visually-hidden" id="sandbox-page-heading" tabindex="-1" data-focus-key="page-heading-sandbox">${escapeHtml(i18n.t("nav.sandbox"))}</h1>`}
        <section class="workspace-panel experiment-panel ${mobileClass("experiment")}" aria-labelledby="experiment-heading" data-scroll-key="experiment-panel">
          ${renderExperimentPanel(currentDrug, zMic, concentration, concentrationRatio)}
        </section>
        <section class="workspace-panel charts-panel ${mobileClass("charts")}" aria-labelledby="charts-heading">
          ${renderChartsPanel(science, currentDrug, zMic)}
        </section>
        <aside class="workspace-panel explain-panel ${mobileClass("explain")}" aria-labelledby="explain-heading" data-scroll-key="explain-panel">
          ${renderExplainPanel(science, currentDrug, zMic)}
        </aside>
      </main>
      ${renderMobileNavigation()}
      <div class="status-bar status-${state.status.tone}" role="status" aria-live="polite">
        ${escapeHtml(i18n.t(state.status.key, state.status.params))}
      </div>
      <footer class="app-footer">
        <span>Ecolab ${APPLICATION_VERSION}</span>
        <span>${escapeHtml(i18n.t("badge.level"))}</span>
        <span>${escapeHtml(localText("本地优先 · 零运行时依赖", "Local-first · zero runtime dependencies"))}</span>
      </footer>
    </div>
  `);

  const chartContainer = app.querySelector("#linked-chart-container");
  try {
    renderLinkedCharts(chartContainer, {
      trajectory: science.chartTrajectory,
      selectedIndex: science.selectedIndex,
      populationScale: state.populationScale,
      concentrationScale: state.concentrationScale,
      zMic,
      drugColor: currentDrug?.color,
      locale: i18n.locale,
      onSelect(index) {
        state.selectedIndex = index;
        state.tablePage = Math.floor(index / TABLE_PAGE_SIZE);
        render();
      },
    });
  } finally {
    restoreViewState();
  }
}

function renderResearchShell() {
  syncDocumentMetadata();
  const restoreViewState = replaceAppHtml(`
    <div class="app-shell">
      ${renderHeader()}
      <div class="evidence-banner" role="note">
        <strong>${escapeHtml(i18n.t("research.badge.stage4"))}</strong>
        <span>${escapeHtml(i18n.t("research.banner"))}</span>
      </div>
      ${!state.repository.persistent ? `<div class="memory-banner" role="alert">${escapeHtml(i18n.t("warning.memory"))}</div>` : ""}
      ${state.research.render()}
      <div class="status-bar status-${state.status.tone}" role="status" aria-live="polite">
        ${escapeHtml(i18n.t(state.status.key, state.status.params))}
      </div>
      <footer class="app-footer">
        <span>Ecolab ${APPLICATION_VERSION}</span>
        <span>${escapeHtml(i18n.t("research.footer.level"))}</span>
        <span>${escapeHtml(localText("本地优先 · 专用工作线程", "Local-first · dedicated Worker"))}</span>
      </footer>
    </div>
  `);
  try {
    state.research.afterRender();
  } finally {
    restoreViewState();
  }
}

function renderHeader() {
  return `
    <header class="topbar">
      <a class="brand" href="#/learn" aria-label="Ecolab" data-focus-key="brand">
        <span class="brand-mark" aria-hidden="true">E</span>
        <span>
          <strong>${escapeHtml(i18n.t("app.title"))}</strong>
          <small>${escapeHtml(i18n.t("app.subtitle"))}</small>
        </span>
      </a>
      <nav class="primary-nav" aria-label="${escapeAttribute(localText("主导航", "Primary navigation"))}">
        <div class="route-tab-list" role="tablist" aria-label="${escapeAttribute(i18n.t("nav.learningModes"))}">
          <a id="learn-route-tab" href="#/learn" role="tab" data-route-tab="learn" data-focus-key="route-learn" aria-controls="main-content" aria-selected="${state.route === "learn"}" tabindex="${state.route === "learn" ? "0" : "-1"}">${escapeHtml(i18n.t("nav.learn"))}</a>
          <a id="sandbox-route-tab" href="#/sandbox" role="tab" data-route-tab="sandbox" data-focus-key="route-sandbox" aria-controls="main-content" aria-selected="${state.route === "sandbox"}" tabindex="${state.route === "sandbox" ? "0" : "-1"}">${escapeHtml(i18n.t("nav.sandbox"))}</a>
        </div>
        <a href="#/research" data-focus-key="route-research" aria-current="${state.route === "research" ? "page" : "false"}">${escapeHtml(i18n.t("nav.research"))}</a>
      </nav>
      <div class="top-actions">
        <button class="quiet-button" type="button" data-action="save" data-focus-key="action-save">${icon("save")}${escapeHtml(i18n.t("nav.save"))}</button>
        <button class="quiet-button" type="button" data-action="restore" data-focus-key="action-restore">${icon("restore")}${escapeHtml(i18n.t("nav.restore"))}</button>
        ${state.route === "research" ? state.research.renderExportMenu() : `<details class="export-menu" ${state.exportOpen ? "open" : ""}>
          <summary>${icon("export")}${escapeHtml(i18n.t("nav.export"))}</summary>
          <div class="export-popover">
            <button type="button" data-action="export-json">${escapeHtml(i18n.t("action.exportJson"))}</button>
            <button type="button" data-action="export-csv">${escapeHtml(i18n.t("action.exportCsv"))}</button>
            <button type="button" data-action="export-svg">${escapeHtml(i18n.t("action.exportSvg"))}</button>
            <p>${escapeHtml(localText("导出需要已提交、非空的实验协议。", "Exports require a committed, non-empty protocol."))}</p>
          </div>
        </details>`}
        <button class="language-button" type="button" data-action="language" data-focus-key="action-language">${escapeHtml(i18n.t("nav.language"))}</button>
      </div>
    </header>
  `;
}

function renderCourse(step) {
  const compare = state.compareRows ? renderComparison() : "";
  return `
    <section class="course-strip" aria-labelledby="course-title">
      <div class="course-progress" aria-hidden="true" data-scroll-key="course-progress">
        ${COURSE_STEPS.map((item, index) => `<span class="${index === state.courseIndex ? "active" : index < state.courseIndex ? "complete" : ""}">${index + 1}</span>`).join("")}
      </div>
      <div class="course-copy">
        <p class="eyebrow">${escapeHtml(i18n.t("course.step", { current: state.courseIndex + 1, total: COURSE_STEPS.length }))}</p>
        <h1 id="course-title" tabindex="-1" data-focus-key="page-heading-learn">${escapeHtml(i18n.t(step.titleKey))}</h1>
        <p>${escapeHtml(i18n.t(step.bodyKey))}</p>
        ${compare}
      </div>
      <div class="course-actions">
        <button type="button" class="quiet-button" data-action="course-previous" ${state.courseIndex === 0 ? "disabled" : ""}>${escapeHtml(i18n.t("course.previous"))}</button>
        <button type="button" class="primary-button" data-action="course-apply">${escapeHtml(step.action === "open-sources" ? i18n.t("action.openSources") : i18n.t("course.apply"))}</button>
        <button type="button" class="quiet-button" data-action="course-next" ${state.courseIndex === COURSE_STEPS.length - 1 ? "disabled" : ""}>${escapeHtml(i18n.t("course.next"))}</button>
      </div>
    </section>
  `;
}

function renderComparison() {
  return `
    <div class="comparison-grid" aria-label="${escapeAttribute(localText("三种抗生素比较", "Three-antibiotic comparison"))}">
      ${state.compareRows.map((row) => `
        <article style="--drug-color:${escapeAttribute(row.color)}">
          <span>${escapeHtml(row.short)}</span>
          <strong>${escapeHtml(i18n.text(row.name))}</strong>
          <dl>
            <div><dt>4×zMIC</dt><dd>${formatNumber(row.concentrationMgPerL, 4)} mg/L</dd></div>
            <div><dt>ψ</dt><dd>${formatSigned(row.netGrowthLog10PerHour, 3)} log₁₀/h</dd></div>
            <div><dt>60 min</dt><dd>${formatNumber(row.finalPopulationLog10, 3)} log₁₀ CFU/mL</dd></div>
          </dl>
        </article>
      `).join("")}
    </div>
  `;
}

function renderExperimentPanel(currentDrug, zMic, concentration, concentrationRatio) {
  const locked = state.project.currentTimeMinutes > 0 || state.project.segments.length > 0;
  const control = state.project.drugId === "none";
  const pending = state.project.pendingAction;
  return `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">${escapeHtml(i18n.t("panel.experiment"))}</p>
        <h2 id="experiment-heading">${escapeHtml(i18n.t("section.setup"))}</h2>
      </div>
      <span class="drug-chip" style="--drug-color:${escapeAttribute(currentDrug.color)}">${escapeHtml(currentDrug.short)}</span>
    </div>

    <div class="control-section">
      <label class="field full-field">
        <span>${escapeHtml(i18n.t("field.projectName"))}</span>
        <input name="project-name" maxlength="80" value="${escapeAttribute(state.project.name)}">
      </label>
      <label class="field full-field">
        <span>${escapeHtml(i18n.t("field.drug"))}</span>
        <select name="drug" ${locked ? "disabled" : ""}>
          ${state.catalog.drugRegistry.records.map((drug) => `<option value="${escapeAttribute(drug.id)}" ${drug.id === state.project.drugId ? "selected" : ""}>${escapeHtml(i18n.text(drug.name))} · ${escapeHtml(drug.short)}</option>`).join("")}
        </select>
      </label>
      <div class="drug-context">
        <span class="kind-label">${escapeHtml(kindLabel(currentDrug.kind))}</span>
        <p>${escapeHtml(i18n.text(currentDrug.mechanism))}</p>
        ${zMic ? `<dl><div><dt>zMIC</dt><dd>${formatNumber(zMic, 4)} mg/L</dd></div><div><dt>κ</dt><dd>${formatNumber(state.catalog.resolvedModel.parameters.drugs[state.project.drugId].hillKappa, 3)}</dd></div><div><dt>ψmin</dt><dd>${formatSigned(state.catalog.resolvedModel.parameters.drugs[state.project.drugId].psiMinLog10PerHour, 2)}</dd></div></dl>` : ""}
      </div>
      <div class="field-grid">
        <label class="field">
          <span>${escapeHtml(i18n.t("field.initialPopulation"))}</span>
          <span class="input-with-unit"><input type="number" name="initial-population" min="1" step="any" value="${escapeAttribute(state.project.initialPopulationCfuPerMl)}" ${locked ? "disabled" : ""}><small>${escapeHtml(i18n.t("unit.cfu"))}</small></span>
        </label>
        <label class="field">
          <span>${escapeHtml(i18n.t("field.detectionLimit"))}</span>
          <span class="input-with-unit"><input type="number" name="detection-limit" min="1e-300" step="any" value="${escapeAttribute(state.project.detectionLimitCfuPerMl)}" ${locked ? "disabled" : ""}><small>${escapeHtml(i18n.t("unit.cfu"))}</small></span>
        </label>
      </div>
      ${locked ? `<p class="field-hint">${escapeHtml(i18n.t("hint.lockedDrug"))}</p>` : ""}
    </div>

    <div class="control-section">
      <h3>${escapeHtml(i18n.t("section.operations"))}</h3>
      <div class="metric-pair">
        <div><span>${escapeHtml(i18n.t("field.currentTime"))}</span><strong>${formatDuration(state.project.currentTimeMinutes)}</strong></div>
        <div><span>${escapeHtml(i18n.t("field.currentConcentration"))}</span><strong>${formatNumber(concentration, 4)} mg/L${zMic ? `<small>${formatNumber(concentrationRatio, 3)}×zMIC</small>` : ""}</strong></div>
      </div>
      ${pending ? `<div class="pending-note" role="note"><strong>${escapeHtml(localText("边界操作待提交", "Boundary action pending"))}</strong><span>${escapeHtml(i18n.t("hint.pending"))}</span></div>` : ""}
      <div class="segmented-control" aria-label="${escapeAttribute(i18n.t("field.concentrationUnit"))}">
        <label><input type="radio" name="concentration-unit" value="mg" ${state.concentrationInputUnit === "mg" ? "checked" : ""}><span>${escapeHtml(i18n.t("unit.mg"))}</span></label>
        <label><input type="radio" name="concentration-unit" value="xzmic" ${state.concentrationInputUnit === "xzmic" ? "checked" : ""} ${control ? "disabled" : ""}><span>${escapeHtml(i18n.t("unit.xzmic"))}</span></label>
      </div>
      <div class="operation-row">
        <label class="field operation-input">
          <span>${escapeHtml(i18n.t("field.doseValue"))}</span>
          <input type="number" name="dose-value" min="0" step="any" value="${escapeAttribute(state.doseValue)}" ${control ? "disabled" : ""}>
        </label>
        <button class="primary-button" type="button" data-action="dose" ${control ? "disabled" : ""}>${escapeHtml(i18n.t("action.dose"))}</button>
      </div>
      <div class="preset-row" aria-label="${escapeAttribute(localText("教学浓度预设", "Educational concentration presets"))}">
        ${[0.25, 1, 4, 16].map((multiple) => `<button type="button" data-action="dose-preset" data-value="${multiple}" ${control ? "disabled" : ""}>${multiple}×</button>`).join("")}
      </div>
      <p class="field-hint">${escapeHtml(control ? i18n.t("hint.none") : i18n.t("hint.preset"))}</p>
      <div class="operation-row">
        <label class="field operation-input">
          <span>${escapeHtml(i18n.t("field.dilutionFold"))}</span>
          <input type="number" name="dilution-fold" min="1.0000001" step="any" value="${escapeAttribute(state.dilutionFold)}" ${control ? "disabled" : ""}>
        </label>
        <button class="secondary-button" type="button" data-action="dilute" ${control ? "disabled" : ""}>${escapeHtml(i18n.t("action.dilute"))}</button>
      </div>
      <button class="washout-button" type="button" data-action="washout" ${control ? "disabled" : ""}>${escapeHtml(i18n.t("action.washout"))}<small>→ 0 mg/L</small></button>
      <p class="field-hint">${escapeHtml(i18n.t("hint.dilution"))}</p>
    </div>

    <div class="control-section">
      <h3>${escapeHtml(i18n.t("section.time"))}</h3>
      <div class="operation-row time-operation">
        <label class="field operation-input">
          <span>${escapeHtml(i18n.t("field.advance"))}</span>
          <input type="number" name="advance-value" min="0.000001" step="any" value="${escapeAttribute(state.advanceValue)}">
        </label>
        <select name="advance-unit" aria-label="${escapeAttribute(localText("推进时间单位", "Advance time unit"))}">
          <option value="minutes" ${state.advanceUnit === "minutes" ? "selected" : ""}>${escapeHtml(i18n.t("unit.minutes"))}</option>
          <option value="hours" ${state.advanceUnit === "hours" ? "selected" : ""}>${escapeHtml(i18n.t("unit.hours"))}</option>
        </select>
        <button class="primary-button" type="button" data-action="advance">${escapeHtml(i18n.t("action.advance"))}</button>
      </div>
      <div class="transport-controls">
        <button type="button" data-action="previous-point" aria-label="${escapeAttribute(i18n.t("action.previousPoint"))}">${icon("previous")}</button>
        <button class="play-button" type="button" data-action="${state.playing ? "pause" : "play"}">${icon(state.playing ? "pause" : "play")}${escapeHtml(i18n.t(state.playing ? "action.pause" : "action.play"))}</button>
        <button type="button" data-action="next-point" aria-label="${escapeAttribute(i18n.t("action.nextPoint"))}">${icon("next")}</button>
        <button class="danger-button" type="button" data-action="reset">${escapeHtml(i18n.t("action.reset"))}</button>
      </div>
    </div>

    <div class="control-section timeline-section">
      <h3>${escapeHtml(i18n.t("section.timeline"))}</h3>
      ${renderTimeline()}
    </div>
  `;
}

function renderTimeline() {
  const rows = [
    { kind: "start", timeMinutes: 0, concentrationMgPerL: state.project.segments[0]?.concentrationMgPerL ?? 0 },
    ...state.project.actions,
  ];
  return `
    <ol class="operation-timeline">
      ${rows.map((action) => `
        <li>
          <span class="timeline-dot" aria-hidden="true"></span>
          <time>${formatDuration(action.timeMinutes)}</time>
          <strong>${escapeHtml(actionLabel(action))}</strong>
          ${action.kind !== "start" ? `<small>${formatNumber(action.concentrationMgPerL, 4)} mg/L</small>` : ""}
        </li>
      `).join("")}
      ${state.project.actions.length === 0 ? `<li class="timeline-empty">${escapeHtml(i18n.t("timeline.empty"))}</li>` : ""}
      ${state.project.pendingAction ? `<li class="pending"><span class="timeline-dot" aria-hidden="true"></span><time>${formatDuration(state.project.pendingAction.timeMinutes)}</time><strong>${escapeHtml(localText("待提交", "Pending"))}: ${escapeHtml(actionLabel(state.project.pendingAction))}</strong><small>${formatNumber(state.project.pendingAction.concentrationMgPerL, 4)} mg/L</small></li>` : ""}
    </ol>
  `;
}

function renderChartsPanel(science, currentDrug, zMic) {
  const total = science.chartTrajectory.length;
  const selected = science.chartTrajectory[science.selectedIndex];
  return `
    <div class="panel-heading chart-heading">
      <div>
        <p class="eyebrow">${escapeHtml(i18n.t("panel.charts"))}</p>
        <h2 id="charts-heading">${escapeHtml(i18n.text(currentDrug.name))} · ${formatDuration(selected.timeHours * 60)}</h2>
      </div>
      <div class="chart-settings">
        <label>${escapeHtml(i18n.t("field.populationScale"))}
          <select name="population-scale">
            <option value="log" ${state.populationScale === "log" ? "selected" : ""}>log₁₀</option>
            <option value="linear" ${state.populationScale === "linear" ? "selected" : ""}>${escapeHtml(localText("线性", "Linear"))}</option>
          </select>
        </label>
        <label>${escapeHtml(i18n.t("field.concentrationScale"))}
          <select name="concentration-scale">
            <option value="mg" ${state.concentrationScale === "mg" ? "selected" : ""}>mg/L</option>
            <option value="xzmic" ${state.concentrationScale === "xzmic" ? "selected" : ""} ${!zMic ? "disabled" : ""}>×zMIC</option>
          </select>
        </label>
      </div>
    </div>
    <div class="chart-summary-cards">
      <article><span>${escapeHtml(localText("选中时间", "Selected time"))}</span><strong>${formatDuration(selected.timeHours * 60)}</strong></article>
      <article><span>${escapeHtml(i18n.t("field.currentConcentration"))}</span><strong>${formatNumber(selected.concentrationMgPerL, 4)} mg/L</strong></article>
      <article><span>ψ</span><strong class="${selected.netGrowthLog10PerHour < 0 ? "negative" : "positive"}">${formatSigned(selected.netGrowthLog10PerHour, 3)} log₁₀/h</strong></article>
      <article><span>${escapeHtml(i18n.t("field.initialPopulation").replace(localText("初始", "Initial "), ""))}</span><strong>${formatNumber(selected.latentLog10PopulationDensity, 3)} log₁₀</strong></article>
    </div>
    <div id="linked-chart-container" class="linked-chart-container"></div>
    <div class="point-navigation">
      <button type="button" data-action="previous-point" ${science.selectedIndex === 0 ? "disabled" : ""}>${icon("previous")}${escapeHtml(i18n.t("action.previousPoint"))}</button>
      <span>${science.selectedIndex + 1} / ${total}</span>
      <button type="button" data-action="next-point" ${science.selectedIndex === total - 1 ? "disabled" : ""}>${escapeHtml(i18n.t("action.nextPoint"))}${icon("next")}</button>
    </div>
    ${renderDataTable(science.chartTrajectory)}
  `;
}

function renderDataTable(trajectory) {
  const pageCount = Math.max(1, Math.ceil(trajectory.length / TABLE_PAGE_SIZE));
  const start = state.tablePage * TABLE_PAGE_SIZE;
  const rows = trajectory.slice(start, start + TABLE_PAGE_SIZE);
  return `
    <section class="data-table-section" aria-labelledby="table-title">
      <div class="table-heading">
        <h3 id="table-title">${escapeHtml(i18n.t("table.title"))}</h3>
        <span>${escapeHtml(i18n.t("table.page", { current: state.tablePage + 1, total: pageCount }))}</span>
      </div>
      <div class="table-scroll" data-scroll-key="trajectory-table">
        <table>
          <thead><tr><th scope="col">${escapeHtml(i18n.t("table.time"))}</th><th scope="col">${escapeHtml(i18n.t("table.concentration"))}</th><th scope="col">${escapeHtml(i18n.t("table.growth"))}</th><th scope="col">${escapeHtml(i18n.t("table.population"))}</th><th scope="col">${escapeHtml(i18n.t("table.detected"))}</th></tr></thead>
          <tbody>
            ${rows.map((row, offset) => {
              const index = start + offset;
              return `<tr class="${index === state.selectedIndex ? "selected" : ""}" data-action="select-row" data-index="${index}" tabindex="0"><td>${formatNumber(row.timeHours * 60, 2)}</td><td>${formatNumber(row.concentrationMgPerL, 5)}</td><td>${formatSigned(row.netGrowthLog10PerHour, 4)}</td><td>${formatNumber(row.latentLog10PopulationDensity, 4)}</td><td><span class="observation ${row.belowDetectionLimit ? "censored" : "detected"}">${escapeHtml(i18n.t(row.belowDetectionLimit ? "formula.below" : "formula.above"))}</span></td></tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
      <div class="table-pagination">
        <button type="button" data-action="table-previous" ${state.tablePage === 0 ? "disabled" : ""}>${escapeHtml(i18n.t("action.tablePrevious"))}</button>
        <button type="button" data-action="table-next" ${state.tablePage === pageCount - 1 ? "disabled" : ""}>${escapeHtml(i18n.t("action.tableNext"))}</button>
      </div>
    </section>
  `;
}

function renderExplainPanel(science, currentDrug, zMic) {
  return `
    <div class="panel-heading">
      <div>
        <p class="eyebrow">${escapeHtml(i18n.t("panel.explain"))}</p>
        <h2 id="explain-heading">${escapeHtml(i18n.t(state.explainTab === "formula" ? "inspector.formula" : "inspector.sources"))}</h2>
      </div>
    </div>
    <div class="tab-list" role="tablist" aria-label="${escapeAttribute(i18n.t("panel.explain"))}">
      <button id="formula-tab" type="button" role="tab" data-action="formula-tab" data-tab="formula" data-focus-key="explain-tab-formula" aria-controls="formula-panel" aria-selected="${state.explainTab === "formula"}" tabindex="${state.explainTab === "formula" ? "0" : "-1"}">${escapeHtml(i18n.t("inspector.formula"))}</button>
      <button id="sources-tab" type="button" role="tab" data-action="sources-tab" data-tab="sources" data-focus-key="explain-tab-sources" aria-controls="sources-panel" aria-selected="${state.explainTab === "sources"}" tabindex="${state.explainTab === "sources" ? "0" : "-1"}">${escapeHtml(i18n.t("inspector.sources"))}</button>
    </div>
    <div id="${state.explainTab}-panel" role="tabpanel" aria-labelledby="${state.explainTab}-tab" tabindex="0" data-focus-key="explain-panel-${state.explainTab}">${state.explainTab === "formula" ? renderFormulaInspector(science, currentDrug, zMic) : renderSourcesPanel(currentDrug)}</div>
  `;
}

function renderFormulaInspector(science, currentDrug, zMic) {
  const selected = science.chartTrajectory[science.selectedIndex];
  const selectedMinutes = selected.timeHours * 60;
  const instantConcentration = science.selectedIndex === science.chartTrajectory.length - 1 && state.project.pendingAction
    ? effectiveConcentration(state.project)
    : selected.concentrationMgPerL;
  const instantPsi = evaluateRegoesNetGrowth(
    state.catalog.resolvedModel.parameters,
    state.project.drugId,
    instantConcentration,
  );
  const leadingSegment = state.project.segments.find(
    (segment) => selectedMinutes > segment.startMinutes + 1e-9 && selectedMinutes <= segment.endMinutes + 1e-9,
  );
  const leadingPsi = leadingSegment
    ? evaluateRegoesNetGrowth(
      state.catalog.resolvedModel.parameters,
      state.project.drugId,
      leadingSegment.concentrationMgPerL,
    )
    : null;
  const doublingMinutes = state.catalog.resolvedModel.parameterSet.parameters.growth.doublingTime.value;
  const psiMax = state.catalog.resolvedModel.parameters.psiMaxLog10PerHour;
  const drugParameters = state.catalog.resolvedModel.parameters.drugs[state.project.drugId];
  const ratio = zMic ? instantConcentration / zMic : 0;

  return `
    <div class="inspector-stack">
      <article class="formula-card derivation-card">
        <p class="eyebrow">ψmax</p>
        <h3>${escapeHtml(localText("由倍增时间推导", "Derived from doubling time"))}</h3>
        <div class="equation">ψ<sub>max</sub> = log<sub>10</sub>(2) / (${formatNumber(doublingMinutes, 2)}/60 h)</div>
        <output>${formatNumber(psiMax, 5)} log₁₀-fold/h</output>
      </article>
      <article class="formula-card active-formula">
        <p class="eyebrow">${escapeHtml(i18n.t("formula.instant"))}</p>
        <h3>t = ${formatDuration(selectedMinutes)}</h3>
        ${state.project.drugId === "none" ? `
          <div class="equation">ψ(0) = ψ<sub>max</sub></div>
        ` : `
          <dl class="parameter-list">
            <div><dt>a</dt><dd>${formatNumber(instantConcentration, 6)} mg/L</dd></div>
            <div><dt>a / zMIC</dt><dd>${formatNumber(ratio, 5)}</dd></div>
            <div><dt>κ</dt><dd>${formatNumber(drugParameters.hillKappa, 4)}</dd></div>
            <div><dt>ψ<sub>min</sub></dt><dd>${formatSigned(drugParameters.psiMinLog10PerHour, 4)}</dd></div>
          </dl>
          <div class="equation multiline">ψ(a) = ψ<sub>max</sub> − (ψ<sub>max</sub> − ψ<sub>min</sub>) · (a/zMIC)<sup>κ</sup> / ((a/zMIC)<sup>κ</sup> − ψ<sub>min</sub>/ψ<sub>max</sub>)</div>
        `}
        <output class="${instantPsi < 0 ? "negative" : "positive"}">ψ = ${formatSigned(instantPsi, 6)} log₁₀-fold/h</output>
        ${state.project.pendingAction ? `<p class="pending-note compact">${escapeHtml(i18n.t("hint.pending"))}</p>` : ""}
      </article>
      <article class="formula-card">
        <p class="eyebrow">${escapeHtml(i18n.t("formula.leading"))}</p>
        ${leadingSegment ? `
          <h3>${formatDuration(leadingSegment.startMinutes)} → ${formatDuration(leadingSegment.endMinutes)}</h3>
          <p>${formatNumber(leadingSegment.concentrationMgPerL, 6)} mg/L · ψ = ${formatSigned(leadingPsi, 6)} log₁₀/h</p>
          <div class="branch-badge ${leadingPsi > 0 ? "positive" : "non-positive"}">${escapeHtml(i18n.t(leadingPsi > 0 ? "formula.branchPositive" : "formula.branchNonPositive"))}</div>
          <div class="equation multiline">${leadingPsi > 0 ? "dN/dt = ln(10) · ψ · N · (1 − N/K)" : "d log₁₀(N)/dt = ψ"}</div>
        ` : `<p>${escapeHtml(i18n.t("formula.noPrevious"))}</p>`}
      </article>
      <article class="formula-card observation-card">
        <p class="eyebrow">${escapeHtml(localText("观测层", "Observation layer"))}</p>
        <h3>${escapeHtml(i18n.t(selected.belowDetectionLimit ? "formula.below" : "formula.above"))}</h3>
        <p>log₁₀ N = ${formatNumber(selected.latentLog10PopulationDensity, 5)} · ${escapeHtml(localText("检测限", "detection limit"))} = ${formatNumber(selected.detectionLimitLog10, 5)}</p>
        <p>${escapeHtml(i18n.t("sources.detection"))}</p>
      </article>
      <button class="source-link-button" type="button" data-action="sources-tab">${escapeHtml(i18n.t("action.openSources"))} ${icon("next")}</button>
    </div>
  `;
}

function renderSourcesPanel(currentDrug) {
  const model = state.catalog.resolvedModel;
  const conditions = model.parameterSet.conditions;
  const primarySources = model.sourceIds
    .map((id) => state.catalog.sourceRegistry.records.find((source) => source.id === id))
    .filter(Boolean);
  const mechanismSources = currentDrug.mechanismSourceIds
    .map((id) => state.catalog.sourceRegistry.records.find((source) => source.id === id))
    .filter(Boolean);
  return `
    <div class="sources-stack">
      <article class="evidence-card critical">
        <span>${escapeHtml(i18n.t("sources.current"))}</span>
        <strong>${escapeHtml(model.conditionMatch.replaceAll("_", " "))}</strong>
        <p>${escapeHtml(i18n.t("warning.transfer"))}</p>
      </article>
      <article class="source-card">
        <h3>${escapeHtml(i18n.t("sources.target"))}</h3>
        ${definitionList(conditions.target)}
      </article>
      <article class="source-card">
        <h3>${escapeHtml(i18n.t("sources.drug"))}</h3>
        ${definitionList(conditions.drugParameterSource)}
      </article>
      <article class="source-card limitation-card">
        <h3>${escapeHtml(localText("关键解释限制", "Key interpretation limits"))}</h3>
        <ul>
          <li>${escapeHtml(i18n.t("sources.noData"))}</li>
          <li>${escapeHtml(i18n.t("sources.capacity"))}</li>
          <li>${escapeHtml(i18n.t("sources.zmic"))}</li>
          <li>${escapeHtml(i18n.t("sources.detection"))}</li>
        </ul>
      </article>
      <article class="source-card">
        <h3>${escapeHtml(i18n.t("sources.notModeled"))}</h3>
        <div class="tag-cloud">${model.definition.notModeled.map((item) => `<span>${escapeHtml(humanize(item))}</span>`).join("")}</div>
      </article>
      <article class="source-card">
        <h3>${escapeHtml(i18n.t("sources.references"))}</h3>
        <ul class="reference-list">
          ${[...primarySources, ...mechanismSources].map((source) => `
            <li>
              <strong>${escapeHtml(source.title)}</strong>
              <small>${escapeHtml(source.organization)}${source.doi ? ` · DOI ${escapeHtml(source.doi)}` : ""}</small>
              <a href="${escapeAttribute(safeExternalUrl(source.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(i18n.t("sources.external"))} ${icon("external")}</a>
            </li>
          `).join("")}
        </ul>
      </article>
    </div>
  `;
}

function renderMobileNavigation() {
  return `
    <nav class="mobile-panel-nav" aria-label="${escapeAttribute(localText("工作区面板", "Workspace panels"))}">
      ${["experiment", "charts", "explain"].map((panel) => `<button type="button" data-action="mobile-panel" data-panel="${panel}" data-focus-key="mobile-${panel}" aria-current="${state.mobilePanel === panel ? "page" : "false"}">${icon(panel)}<span>${escapeHtml(i18n.t(`mobile.${panel}`))}</span></button>`).join("")}
    </nav>
  `;
}

function renderFatal() {
  syncDocumentMetadata("fatal");
  const restoreViewState = replaceAppHtml(`
    <main class="fatal-screen" id="main-content">
      <div class="brand-mark" aria-hidden="true">E</div>
      <p class="eyebrow">Ecolab</p>
      <h1 tabindex="-1" data-focus-key="page-heading-fatal">${escapeHtml(i18n.t("fatal.heading"))}</h1>
      <p>${escapeHtml(i18n.t(state.status.key, state.status.params))}</p>
      <button class="primary-button" type="button" data-action="reload" data-focus-key="fatal-reload">${escapeHtml(i18n.t("fatal.reload"))}</button>
    </main>
  `);
  restoreViewState();
}

async function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;

  try {
    if (action === "language") {
      i18n.locale = i18n.locale === "zh-CN" ? "en" : "zh-CN";
      try { localStorage.setItem(LOCALE_STORAGE_KEY, i18n.locale); } catch { /* optional */ }
      render();
      return;
    }
    if (action === "reload") {
      location.reload();
      return;
    }
    if (state.route === "research" && await state.research.handleClick(action, target)) return;
    switch (action) {
      case "save":
        await saveProject();
        break;
      case "restore":
        await restoreProject();
        break;
      case "export-json":
        exportRun("json");
        break;
      case "export-csv":
        exportRun("csv");
        break;
      case "export-svg":
        exportRun("svg");
        break;
      case "dose":
        applyDose(state.doseValue, state.concentrationInputUnit);
        break;
      case "dose-preset":
        state.doseValue = Number(target.dataset.value);
        state.concentrationInputUnit = "xzmic";
        applyDose(state.doseValue, "xzmic");
        break;
      case "dilute":
        updateProject(diluteDrugConcentration(state.project, Number(state.dilutionFold)));
        break;
      case "washout":
        updateProject(washout(state.project));
        break;
      case "advance":
        advanceFromControls();
        break;
      case "play":
        startPlayback();
        break;
      case "pause":
        stopPlayback();
        break;
      case "reset":
        if (confirm(i18n.t("confirm.reset"))) {
          stopPlayback(false);
          state.compareRows = null;
          updateProject(resetProject(state.project), { key: "status.reset", tone: "success" });
        }
        break;
      case "previous-point":
        selectPoint(state.selectedIndex - 1);
        break;
      case "next-point":
        selectPoint(state.selectedIndex + 1);
        break;
      case "select-row":
        selectPoint(Number(target.dataset.index));
        break;
      case "table-previous":
        state.tablePage -= 1;
        render();
        break;
      case "table-next":
        state.tablePage += 1;
        render();
        break;
      case "formula-tab":
        setExplainTab("formula", { focusTab: target.getAttribute("role") === "tab" });
        break;
      case "sources-tab":
        setExplainTab("sources", { focusTab: target.getAttribute("role") === "tab" });
        break;
      case "mobile-panel":
        state.mobilePanel = target.dataset.panel;
        pendingFocusKey = `mobile-${state.mobilePanel}`;
        render();
        break;
      case "course-previous":
        state.courseIndex = Math.max(0, state.courseIndex - 1);
        state.compareRows = null;
        render();
        break;
      case "course-next":
        state.courseIndex = Math.min(COURSE_STEPS.length - 1, state.courseIndex + 1);
        state.compareRows = null;
        render();
        break;
      case "course-apply":
        await applyCourseAction(courseStep(state.courseIndex).action);
        break;
      default:
        break;
    }
  } catch (error) {
    showError(error);
  }
}

async function handleChange(event) {
  const input = event.target;
  try {
    if (state.route === "research" && await state.research.handleChange(input)) return;
    switch (input.name) {
      case "project-name":
        updateProject(renameProject(state.project, input.value));
        break;
      case "drug":
        updateProject(selectDrug(state.project, input.value, availableDrugIds()));
        if (input.value === "none") state.concentrationInputUnit = "mg";
        state.compareRows = null;
        break;
      case "initial-population":
        updateInitialConditions({ initialPopulationCfuPerMl: Number(input.value) });
        break;
      case "detection-limit":
        updateInitialConditions({ detectionLimitCfuPerMl: Number(input.value) });
        break;
      case "concentration-unit":
        state.concentrationInputUnit = input.value;
        render();
        break;
      case "dose-value":
        state.doseValue = Number(input.value);
        break;
      case "dilution-fold":
        state.dilutionFold = Number(input.value);
        break;
      case "advance-value":
        state.advanceValue = Number(input.value);
        break;
      case "advance-unit":
        state.advanceUnit = input.value;
        break;
      case "population-scale":
        state.populationScale = input.value;
        render();
        break;
      case "concentration-scale":
        state.concentrationScale = input.value;
        render();
        break;
      default:
        break;
    }
  } catch (error) {
    showError(error);
  }
}

function updateInitialConditions(patch) {
  const initialPopulationCfuPerMl = patch.initialPopulationCfuPerMl ?? state.project.initialPopulationCfuPerMl;
  const maximumPopulation = 10 ** state.catalog.resolvedModel.parameters.carryingCapacityLog10CfuPerMl;
  if (initialPopulationCfuPerMl > maximumPopulation) {
    throw new Error(localText(
      `初始种群不能超过承载量 ${formatNumber(maximumPopulation, 0)} CFU/mL。`,
      `Initial population cannot exceed the carrying capacity of ${formatNumber(maximumPopulation, 0)} CFU/mL.`,
    ));
  }
  updateProject(setInitialConditions(state.project, {
    initialPopulationCfuPerMl,
    detectionLimitCfuPerMl: patch.detectionLimitCfuPerMl ?? state.project.detectionLimitCfuPerMl,
  }));
}

function applyDose(value, unit) {
  let concentrationMgPerL = Number(value);
  if (unit === "xzmic") {
    const zMic = zMicFor();
    if (!zMic) throw new Error("zMIC is unavailable for the no-antibiotic control.");
    concentrationMgPerL *= zMic;
  }
  updateProject(setPendingDose(state.project, concentrationMgPerL, { value: Number(value), unit }));
}

function advanceFromControls() {
  const minutes = Number(state.advanceValue) * (state.advanceUnit === "hours" ? 60 : 1);
  updateProject(advanceProject(state.project, minutes));
}

function updateProject(project, status = null) {
  state.project = project;
  state.selectedIndex = Number.MAX_SAFE_INTEGER;
  if (status) state.status = { params: {}, ...status };
  render();
}

function selectPoint(index) {
  const length = deriveScientificView().chartTrajectory.length;
  state.selectedIndex = Math.max(0, Math.min(length - 1, index));
  state.tablePage = Math.floor(state.selectedIndex / TABLE_PAGE_SIZE);
  render();
}

function startPlayback() {
  if (state.playing) return;
  if (reducedMotionQuery.matches) {
    state.status = { key: "status.reducedMotionPlayback", tone: "info", params: {} };
    render();
    return;
  }
  state.playing = true;
  render();
  state.playTimer = setInterval(() => {
    try {
      state.project = advanceProject(state.project, state.project.sampleIntervalMinutes);
      state.selectedIndex = Number.MAX_SAFE_INTEGER;
      render();
    } catch (error) {
      stopPlayback(false);
      showError(error);
    }
  }, 650);
}

function stopPlayback(shouldRender = true) {
  if (state.playTimer) clearInterval(state.playTimer);
  state.playTimer = null;
  const changed = state.playing;
  state.playing = false;
  if (shouldRender && changed && state.catalog) render();
}

async function saveProject() {
  const saved = await state.repository.saveProject(state.project);
  state.project = saved;
  state.status = { key: "status.saved", tone: "success", params: {} };
  render();
}

async function restoreProject() {
  stopPlayback(false);
  const projects = await state.repository.listProjects();
  if (projects.length === 0) {
    state.status = { key: "status.noSaved", tone: "info", params: {} };
    render();
    return;
  }
  state.project = hydrateProject(projects[0]);
  state.selectedIndex = Number.MAX_SAFE_INTEGER;
  state.compareRows = null;
  state.status = { key: "status.restored", tone: "success", params: {} };
  render();
}

function strictExportPayload() {
  if (state.project.pendingAction) {
    state.status = { key: "status.pendingExport", tone: "warning", params: {} };
    render();
    return null;
  }
  const request = compileSimulationRequest(state.project);
  const result = simulatePiecewise(state.catalog.resolvedModel, request);
  const manifest = buildRunManifest({
    project: state.project,
    resolvedModel: state.catalog.resolvedModel,
    request,
    result,
    applicationVersion: APPLICATION_VERSION,
  });
  return { request, result, manifest };
}

function exportRun(format) {
  const payload = strictExportPayload();
  if (!payload) return;
  const base = slugify(state.project.name) || "ecolab-run";
  if (format === "json") {
    downloadText(JSON.stringify(payload.manifest, null, 2), `${base}.manifest.json`, "application/json;charset=utf-8");
  } else if (format === "csv") {
    downloadText(trajectoryToCsv(payload.result, state.catalog.resolvedModel), `${base}.trajectory.csv`, "text/csv;charset=utf-8");
  } else {
    const chartContainer = app.querySelector("#linked-chart-container");
    const svg = serializeChartDashboard(chartContainer, payload.manifest);
    downloadText(svg, `${base}.charts.svg`, "image/svg+xml;charset=utf-8");
  }
  state.status = { key: "status.exported", tone: "success", params: {} };
  state.exportOpen = false;
  render();
}

async function applyCourseAction(action) {
  if (action === "open-sources") {
    state.explainTab = "sources";
    state.mobilePanel = "explain";
    pendingFocusKey = "explain-panel-sources";
    render();
    return;
  }
  if (action === "save-export") {
    await saveProject();
    state.exportOpen = true;
    render();
    return;
  }
  if (action === "compare-drugs") {
    state.compareRows = buildComparisonRows(4, 60);
    state.project = buildProjectFromPreset(coursePreset(action, state.catalog.resolvedModel));
    state.selectedIndex = Number.MAX_SAFE_INTEGER;
    render();
    return;
  }
  const preset = coursePreset(action, state.catalog.resolvedModel);
  if (preset) {
    state.compareRows = null;
    state.project = buildProjectFromPreset(preset);
    state.selectedIndex = Number.MAX_SAFE_INTEGER;
    state.mobilePanel = "charts";
    render();
  }
}

function buildProjectFromPreset(preset) {
  let project = newProject(state.project.id);
  project = { ...project, name: state.project.name, revision: state.project.revision };
  project = setInitialConditions(project, {
    initialPopulationCfuPerMl: preset.initialPopulationCfuPerMl,
    detectionLimitCfuPerMl: preset.detectionLimitCfuPerMl,
  });
  project = { ...project, sampleIntervalMinutes: preset.sampleIntervalMinutes };
  project = selectDrug(project, preset.drugId, availableDrugIds());
  for (const [index, segment] of preset.segments.entries()) {
    if (preset.drugId !== "none") {
      if (segment.operation === "dilute") {
        const before = effectiveConcentration(project);
        project = diluteDrugConcentration(project, before / segment.concentrationMgPerL);
      } else if (segment.operation === "washout") {
        project = washout(project);
      } else if (index === 0 || segment.concentrationMgPerL !== effectiveConcentration(project)) {
        project = setPendingDose(project, segment.concentrationMgPerL, { course: true });
      }
    }
    project = advanceProject(project, segment.durationMinutes);
  }
  return project;
}

function buildComparisonRows(multiple, durationMinutes) {
  return state.catalog.drugRegistry.records
    .filter((drug) => drug.id !== "none")
    .map((drug) => {
      const zMic = zMicFor(drug.id);
      const concentrationMgPerL = zMic * multiple;
      const project = buildProjectFromPreset({
        drugId: drug.id,
        initialPopulationCfuPerMl: 1_000_000,
        detectionLimitCfuPerMl: 10,
        sampleIntervalMinutes: 5,
        segments: [{ durationMinutes, concentrationMgPerL }],
      });
      const result = simulatePiecewise(
        state.catalog.resolvedModel,
        compileSimulationRequest(project),
      );
      return {
        ...drug,
        concentrationMgPerL,
        netGrowthLog10PerHour: result.trajectory.at(-1).netGrowthLog10PerHour,
        finalPopulationLog10: result.trajectory.at(-1).latentLog10PopulationDensity,
      };
    });
}

function showError(error) {
  console.error(error);
  state.status = {
    key: "status.error",
    tone: "danger",
    params: { message: errorMessage(error) },
  };
  render();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function mobileClass(panel) {
  return state.mobilePanel === panel ? "mobile-active" : "";
}

function localText(zh, en) {
  return i18n.locale === "zh-CN" ? zh : en;
}

function kindLabel(kind) {
  if (kind === "control") return i18n.t("drug.control");
  if (kind === "bacteriostatic") return i18n.t("drug.bacteriostatic");
  return i18n.t("drug.bactericidal");
}

function actionLabel(action) {
  if (action.kind === "start") return i18n.t("timeline.start");
  if (action.kind === "washout") return i18n.t("timeline.washout");
  if (action.kind === "dilute_drug_concentration") return i18n.t("timeline.dilute");
  return i18n.t("timeline.dose");
}

function formatDuration(minutes) {
  if (minutes >= 60) {
    const hours = minutes / 60;
    return `${formatNumber(hours, Number.isInteger(hours) ? 0 : 2)} h`;
  }
  return `${formatNumber(minutes, 2)} min`;
}

function formatNumber(value, maximumFractionDigits = 3) {
  if (!Number.isFinite(value)) return "—";
  const absolute = Math.abs(value);
  if (absolute >= 100_000 || (absolute > 0 && absolute < 0.001)) {
    return value.toExponential(2).replace("e+", "e");
  }
  return i18n.number(value, { maximumFractionDigits });
}

function formatSigned(value, digits = 3) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
}

function definitionList(value) {
  return `<dl class="condition-list">${Object.entries(value).map(([key, item]) => {
    const display = item && typeof item === "object" && "value" in item
      ? `${item.value} ${item.unit ?? ""}`
      : item;
    return `<div><dt>${escapeHtml(humanize(key))}</dt><dd>${escapeHtml(display)}</dd></div>`;
  }).join("")}</dl>`;
}

function humanize(value) {
  return String(value).replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
}

function safeExternalUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "about:blank";
  } catch {
    return "about:blank";
  }
}

function slugify(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function icon(name) {
  const paths = {
    save: '<path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-8h8v8"/>',
    restore: '<path d="M4 8V3m0 0h5M4 3l4 4a8 8 0 1 1-2 9"/>',
    export: '<path d="M12 3v12m0-12 4 4m-4-4L8 7M5 13v8h14v-8"/>',
    previous: '<path d="m15 6-6 6 6 6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
    play: '<path d="m8 5 11 7-11 7z"/>',
    pause: '<path d="M9 5v14M15 5v14"/>',
    experiment: '<path d="M9 3h6M10 3v5l-5 9a3 3 0 0 0 3 4h8a3 3 0 0 0 3-4l-5-9V3M8 15h8"/>',
    charts: '<path d="M4 20V10m6 10V4m6 16v-7m4 7H2"/>',
    explain: '<circle cx="12" cy="12" r="9"/><path d="M9.8 9a2.3 2.3 0 1 1 3.4 2c-.8.5-1.2 1-1.2 2M12 17h.01"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 13v7H4V6h7"/>',
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] ?? ""}</svg>`;
}
