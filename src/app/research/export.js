import { researchEvaluationRole, researchSensitivityRows } from "./state.js";

export const RESEARCH_EXPORT_DISCLOSURES = Object.freeze({
  sourceDoi: "10.6084/m9.figshare.28342064.v1",
  articleDoi: "10.1038/s41597-025-05356-3",
  license: "CC BY 4.0",
  en: Object.freeze({
    measurement: "Raw OD600 is not CFU/mL; no OD-to-CFU conversion was applied.",
    validation: "L4 ineligible: source well/plate independence is incompletely documented; validation uses locked held-out units.",
    uncertainty: "Exploratory quantiles are not confidence intervals.",
    exposure: "The source trajectories have no antibiotic exposure and cannot support antibiotic-effect inference.",
    calibration: "Calibration is transferred across unmatched measurement and medium conditions and must not be interpreted as condition-matched CFU validation.",
  }),
  "zh-CN": Object.freeze({
    measurement: "原始 OD600 不是 CFU/mL，且未应用 OD–CFU 转换。",
    validation: "L4 不合格：源孔/板独立性记录不完整；验证使用锁定留出单元。",
    uncertainty: "探索性分位数不是置信区间。",
    exposure: "源轨迹没有药物暴露，不能支持抗生素效应推断。",
    calibration: "校准跨越不匹配的测量层和培养基条件迁移，不得解释为条件匹配的 CFU 验证。",
  }),
});

const OBSERVATION_HEADERS = Object.freeze([
  "observationId",
  "seriesId",
  "independentUnitId",
  "role",
  "timeHours",
  "drugId",
  "concentrationMgPerL",
  "measurementType",
  "value",
  "censoring",
  "censoringBounds",
  "replicate",
  "conditions",
]);

export function protectCsvFormula(value) {
  const text = String(value);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

export function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const source = typeof value === "object" ? JSON.stringify(value) : String(value);
  const text = protectCsvFormula(source);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function developmentValidationDisclosure(locale) {
  return locale === "zh-CN"
    ? "L4 不合格：已查看的开发曲线，不是未触碰或外部验证。源角色 validation 保留供审计；轨迹间独立性未验证。"
    : "L4 ineligible: previously viewed development curves, not untouched or external validation. Source role validation is retained for audit; between-trajectory independence is unverified.";
}

export function researchExportDisclosures(result, locale = "en") {
  const text = RESEARCH_EXPORT_DISCLOSURES[locale] ?? RESEARCH_EXPORT_DISCLOSURES.en;
  if (researchEvaluationRole(result) !== "development") return text;
  return {
    ...text,
    validation: developmentValidationDisclosure(locale),
    uncertainty: locale === "zh-CN"
      ? "工程范围分位数不是置信区间；完整曲线联合重拟合区间是条件性探索区间，失败重拟合被排除，精度和覆盖率尚未确立。"
      : "Engineering-range quantiles are not confidence intervals; whole-curve joint-refit intervals are conditional and exploratory, exclude failed refits, and do not establish precision or coverage.",
  };
}

function disclosureRows(locale = "en", result) {
  const text = researchExportDisclosures(result, locale);
  return [
    ["source_doi", RESEARCH_EXPORT_DISCLOSURES.sourceDoi],
    ["article_doi", RESEARCH_EXPORT_DISCLOSURES.articleDoi],
    ["license", RESEARCH_EXPORT_DISCLOSURES.license],
    ["measurement_limitation", text.measurement],
    ["validation_limitation", text.validation],
    ["uncertainty_limitation", text.uncertainty],
    ["exposure_limitation", text.exposure],
    ["calibration_limitation", text.calibration],
  ];
}

function csvDisclosurePreamble(dataset, locale, result) {
  const metadata = dataset.metadata ?? {};
  const sourceIds = Array.isArray(metadata.sourceIds) ? metadata.sourceIds : [];
  const rows = sourceIds.includes("figshare-bw25113-growth-v1")
    ? disclosureRows(locale, result).filter(([key]) => key !== "license").map(([key, value]) => [
      key,
      // Standalone source exports disclose current evidence status, not a historical run's role.
      key === "validation_limitation" && result === undefined ? developmentValidationDisclosure(locale) : value,
    ])
    : [];
  if (sourceIds.length) rows.push(["source_ids", sourceIds]);
  if (metadata.license) rows.push(["license", metadata.license]);
  return rows.map(([key, value]) => `# ${key}: ${csvCell(value)}\n`).join("");
}

export function normalizedDatasetToCsv(dataset, locale = "en") {
  if (!dataset?.observations || !Array.isArray(dataset.observations)) {
    throw new TypeError("A normalized observation dataset is required.");
  }
  const rows = dataset.observations.map((observation) => OBSERVATION_HEADERS
    .map((header) => csvCell(observation[header]))
    .join(","));
  return `${csvDisclosurePreamble(dataset, locale)}${OBSERVATION_HEADERS.join(",")}\n${rows.join("\n")}\n`;
}

function validationRows(dataset, result) {
  const observations = dataset?.observations?.filter((observation) => observation.role === "validation") ?? [];
  const predictions = result?.validation?.predictions ?? [];
  const residuals = result?.validation?.residuals ?? [];
  if (observations.length !== predictions.length || observations.length !== residuals.length) {
    throw new Error("Validation observations, predictions, and residuals are not aligned.");
  }
  return observations.map((observation, index) => ({
    observation,
    prediction: predictions[index],
    residual: residuals[index],
  }));
}

function metricEntries(prefix, metrics) {
  const rows = [];
  for (const key of ["macroRmse", "pooledRmse", "mae", "meanResidual", "medianAbsoluteError"]) {
    if (Number.isFinite(metrics?.[key])) rows.push([`${prefix}.${key}`, metrics[key]]);
  }
  return rows;
}

export function predictionsMetricsToCsv(dataset, result, locale = "en") {
  const headers = [
    "row_type",
    "role",
    "observation_id",
    "independent_unit_id",
    "time_h",
    "measurement_type",
    "observed",
    "predicted",
    "residual_observed_minus_predicted",
    "metric_name",
    "metric_value",
    "source_role",
    "model",
  ];
  const evaluationRole = researchEvaluationRole(result);
  const rows = validationRows(dataset, result).map(({ observation, prediction, residual }) => [
    "prediction",
    evaluationRole,
    observation.observationId,
    observation.independentUnitId,
    observation.timeHours,
    observation.measurementType,
    observation.value,
    typeof prediction === "number" ? prediction : prediction?.predicted ?? prediction?.value,
    residual?.residual,
    "",
    "",
    observation.role,
    "calibration",
  ]);
  const metrics = [
    ...metricEntries("training", result?.training?.metrics),
    ...metricEntries(evaluationRole, result?.validation?.metrics),
    ...metricEntries(
      `${evaluationRole}.baseline.${result?.validation?.metrics?.baselineComparison?.baselineId ?? "predeclared"}`,
      result?.validation?.metrics?.baselineComparison?.baselineMetrics,
    ),
  ];
  const append = (type, role, name, value, sourceRole = "", model = "") => rows.push([type, role, "", "", "", "", "", "", "", name, value, sourceRole, model]);
  for (const [name, value] of metrics) {
    const training = name.startsWith("training");
    append("metric", training ? "training" : evaluationRole, name, value, training ? "training" : "validation", "calibration");
  }
  const growth = result?.growthComparison;
  if (growth) {
    for (const [model, candidate] of Object.entries(growth.crossValidation?.candidates ?? {})) {
      append("metric", "training", `growth.cv.${model}.macroRmse`, candidate.score, "training", model);
      append("diagnostic", "training", `growth.cv.${model}.eligible`, candidate.eligible, "training", model);
      append("diagnostic", "training", `growth.cv.${model}.convergence`, candidate.folds?.map((fold) => ({ finite: fold.fit?.finite, converged: fold.fit?.converged })), "training", model);
    }
    for (const [model, fit] of Object.entries(growth.trainingFits ?? {})) {
      for (const [name, value] of metricEntries(`growth.training.${model}`, fit.metrics)) append("metric", "training", name, value, "training", model);
      append("diagnostic", "training", `growth.training.${model}.converged`, fit.converged, "training", model);
    }
    append("diagnostic", "training", "growth.selection", growth.selection, "training");
    for (const variant of ["selected", "baseline"]) {
      const evaluation = growth.development?.[variant];
      const model = variant === "selected" ? growth.selection?.selectedModel : "training_mean";
      for (const [name, value] of metricEntries(`growth.development.${variant}`, evaluation?.metrics)) append("metric", "development", name, value, growth.development?.observationRoleUsed, model);
      append("diagnostic", "development", `growth.development.${variant}.status`, evaluation?.status, growth.development?.observationRoleUsed, model);
      for (const prediction of evaluation?.predictions ?? []) {
        rows.push(["growth_prediction", "development", prediction.observationId, prediction.independentUnitId, prediction.timeHours, "od600", prediction.observed, prediction.predicted, prediction.residual, "", "", growth.development?.observationRoleUsed, model]);
      }
    }
    append("metric", "development", "growth.development.deltaMacroRmseVsBaseline", growth.development?.deltaMacroRmseVsBaseline, growth.development?.observationRoleUsed);
    for (const key of ["requestedSamples", "successfulSamples", "jointSamplesRetained", "resamplingUnit", "independenceAssumption", "intervals", "failures", "warnings"]) {
      append("diagnostic", "training", `growth.bootstrap.${key}`, growth.bootstrap?.[key], "training");
    }
    append("diagnostic", "", "growth.warnings", growth.warnings);
  }
  for (const [key, value] of Object.entries(result?.researchAssessment ?? {})) append("diagnostic", "", `researchAssessment.${key}`, value);
  for (const row of researchSensitivityRows(result)) {
    append("sensitivity", "", `local.${row.name}.derivative`, row.local);
    append("sensitivity", "", `morris.${row.name}.muStar`, row.morris.muStar);
    for (const key of ["firstOrder", "totalOrder", "firstOrderInterval", "totalOrderInterval", "precision"]) append("sensitivity", "", `sobol.${row.name}.${key}`, row.sobol[key]);
  }
  append("diagnostic", "", "sobol.bootstrap", result?.analyses?.sensitivity?.sobolJansen?.bootstrap);
  const morris = result?.analyses?.sensitivity?.morris;
  append("diagnostic", "", "morris.effectScale", morris?.effectScale);
  append("diagnostic", "", "morris.normalization", morris?.normalization);
  for (const slice of result?.identifiability?.objectiveSlices ?? result?.identifiability?.profiles ?? []) {
    append("diagnostic", "training", `objective_slice.${slice.parameter}.interpretation`, slice.interpretation, "training");
    for (const entry of slice.values ?? []) append("objective_slice", "training", slice.parameter, entry, "training");
  }
  return `${csvDisclosurePreamble(dataset, locale, result)}${headers.join(",")}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

export function analysisManifestJson(result) {
  if (!result?.manifest) throw new Error("No completed Research analysis manifest is available.");
  return JSON.stringify(result.manifest, null, 2);
}

export function researchPackageJson(result) {
  if (!result?.researchPackage) throw new Error("No completed Research package is available.");
  return JSON.stringify(result.researchPackage, null, 2);
}

export function researchMethodsText(result, locale = "en") {
  if (!result?.methodsSummaryMarkdown) throw new Error("No completed Research methods summary is available.");
  const heading = locale === "zh-CN" ? "## 必须保留的来源与限制" : "## Required provenance and limitations";
  const bullets = disclosureRows(locale, result).map(([key, value]) => `- **${key.replaceAll("_", " ")}**: ${value}`).join("\n");
  return `${result.methodsSummaryMarkdown.trim()}\n\n${heading}\n\n${bullets}\n`;
}

export function researchExportAvailability(datasetRecord, result) {
  const dataset = Boolean(datasetRecord?.normalizedDataset && datasetRecord?.qualityReport?.valid === true);
  const validationCount = datasetRecord?.normalizedDataset?.observations?.filter((observation) => observation.role === "validation").length ?? 0;
  const predictions = result?.validation?.predictions;
  const residuals = result?.validation?.residuals;
  return {
    dataset,
    manifest: Boolean(dataset && result?.manifest),
    package: Boolean(dataset && result?.researchPackage),
    predictions: Boolean(dataset && Array.isArray(predictions) && Array.isArray(residuals) && predictions.length === validationCount && residuals.length === validationCount),
    methods: Boolean(dataset && result?.methodsSummaryMarkdown),
    svg: Boolean(dataset && result),
  };
}

export { OBSERVATION_HEADERS };
