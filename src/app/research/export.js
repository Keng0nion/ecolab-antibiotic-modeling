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
  const source = typeof value === "object" ? JSON.stringify(value) : String(value);
  const text = protectCsvFormula(source);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function disclosureRows(locale = "en") {
  const text = RESEARCH_EXPORT_DISCLOSURES[locale] ?? RESEARCH_EXPORT_DISCLOSURES.en;
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

function csvDisclosurePreamble(locale) {
  return disclosureRows(locale).map(([key, value]) => `# ${key}: ${csvCell(value)}`).join("\n");
}

export function normalizedDatasetToCsv(dataset, locale = "en") {
  if (!dataset?.observations || !Array.isArray(dataset.observations)) {
    throw new TypeError("A normalized observation dataset is required.");
  }
  const rows = dataset.observations.map((observation) => OBSERVATION_HEADERS
    .map((header) => csvCell(observation[header]))
    .join(","));
  return `${csvDisclosurePreamble(locale)}\n${OBSERVATION_HEADERS.join(",")}\n${rows.join("\n")}\n`;
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
  ];
  const rows = validationRows(dataset, result).map(({ observation, prediction, residual }) => [
    "prediction",
    "validation",
    observation.observationId,
    observation.independentUnitId,
    observation.timeHours,
    observation.measurementType,
    observation.value,
    typeof prediction === "number" ? prediction : prediction?.predicted ?? prediction?.value,
    residual?.residual,
    "",
    "",
  ]);
  const metrics = [
    ...metricEntries("training", result?.training?.metrics),
    ...metricEntries("validation", result?.validation?.metrics),
    ...metricEntries(
      `validation.baseline.${result?.validation?.metrics?.baselineComparison?.baselineId ?? "predeclared"}`,
      result?.validation?.metrics?.baselineComparison?.baselineMetrics,
    ),
  ];
  for (const [name, value] of metrics) {
    rows.push(["metric", name.startsWith("training") ? "training" : "validation", "", "", "", "", "", "", "", name, value]);
  }
  return `${csvDisclosurePreamble(locale)}\n${headers.join(",")}\n${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function exportNotice(locale = "en") {
  return Object.fromEntries(disclosureRows(locale));
}

export function analysisManifestJson(result, locale = "en") {
  if (!result?.manifest) throw new Error("No completed Research analysis manifest is available.");
  return JSON.stringify({ ...result.manifest, ecolabExportNotice: exportNotice(locale) }, null, 2);
}

export function researchPackageJson(result, locale = "en") {
  if (!result?.researchPackage) throw new Error("No completed Research package is available.");
  return JSON.stringify({ ...result.researchPackage, ecolabExportNotice: exportNotice(locale) }, null, 2);
}

export function researchMethodsText(result, locale = "en") {
  if (!result?.methodsSummaryMarkdown) throw new Error("No completed Research methods summary is available.");
  const heading = locale === "zh-CN" ? "## 必须保留的来源与限制" : "## Required provenance and limitations";
  const bullets = disclosureRows(locale).map(([key, value]) => `- **${key.replaceAll("_", " ")}**: ${value}`).join("\n");
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
