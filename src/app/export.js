import { createRunManifest, log10PopulationToLinear } from "../model.js";

export function buildRunManifest({ project, resolvedModel, request, result, applicationVersion }) {
  return createRunManifest({
    runId: `${project.id}-${Math.round(project.currentTimeMinutes * 60_000)}`,
    createdAt: new Date().toISOString(),
    applicationVersion,
    resolvedModel,
    request,
    result,
  });
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const protectedText = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(protectedText)
    ? `"${protectedText.replaceAll('"', '""')}"`
    : protectedText;
}

export function trajectoryToCsv(result, resolvedModel) {
  const zMic = result.protocol.drugId === "none"
    ? null
    : resolvedModel.parameters.drugs[result.protocol.drugId].zMicMgPerL;
  const warningCodes = resolvedModel.warnings.map((warning) => warning.code).join("|");
  const headers = [
    "time_h",
    "time_min",
    "drug_id",
    "concentration_mg_per_L",
    "concentration_x_zMIC",
    "net_growth_log10_fold_per_h",
    "latent_population_log10_CFU_per_mL",
    "population_CFU_per_mL",
    "below_detection_limit",
    "detection_limit_log10_CFU_per_mL",
    "model_id",
    "model_version",
    "parameter_set_id",
    "parameter_set_version",
    "warning_codes",
  ];
  const rows = result.trajectory.map((row) => {
    const linear = log10PopulationToLinear(row.latentLog10PopulationDensity);
    return [
      row.timeHours,
      row.timeHours * 60,
      row.drugId,
      row.concentrationMgPerL,
      zMic ? row.concentrationMgPerL / zMic : 0,
      row.netGrowthLog10PerHour,
      row.latentLog10PopulationDensity,
      linear.value,
      row.belowDetectionLimit,
      row.detectionLimitLog10,
      resolvedModel.ref.id,
      resolvedModel.ref.version,
      resolvedModel.ref.parameterSetId,
      resolvedModel.ref.parameterSetVersion,
      warningCodes,
    ].map(csvCell).join(",");
  });
  return `${headers.join(",")}\n${rows.join("\n")}\n`;
}

export function projectToJson(project) {
  return JSON.stringify(
    {
      schemaVersion: "1.0.0",
      kind: "ecolab.project-export",
      exportedAt: new Date().toISOString(),
      project,
    },
    null,
    2,
  );
}

export function downloadBlob(blob, filename) {
  const safeFilename = filename.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = safeFilename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(text, filename, type) {
  downloadBlob(new Blob([text], { type }), filename);
}
