import { assessDatasetQuality, importObservationDataset, runEcolabResearchWorkflow } from "../analysis/index.js";
import { serializeResearchDashboard } from "../app/research/charts.js";
import { buildDatasetRecord } from "../app/research/dataset-loader.js";
import {
  analysisManifestJson,
  normalizedDatasetToCsv,
  predictionsMetricsToCsv,
  researchMethodsText,
  researchPackageJson,
} from "../app/research/export.js";
import {
  RESEARCH_PRESETS,
  buildResearchWorkflowOptions,
  captureResearchRun,
  normalizeResearchSeed,
} from "../app/research/state.js";
import { APPLICATION_VERSION } from "../app/version.js";
import { progressFromEntry, CLI_SCHEMA_VERSION, cliError, safeFileStem, writeArtifact } from "./io.js";
import { readBundledDataset } from "./catalog.js";

export const DEFAULT_RESEARCH_SEED = 0x5e4c0ab1;
const RESEARCH_LOCALES = new Set(["en", "zh-CN"]);

export function researchPresetNames() {
  return Object.keys(RESEARCH_PRESETS);
}

/**
 * The locked one-click Research Workspace run on the bundled dataset only. The
 * browser workspace offers QC-only admission for other imports; the terminal
 * research command keeps the same boundary and refuses anything else.
 */
export async function runResearchCommand({
  preset = "small",
  seed = null,
  runId = null,
  createdAt = null,
  locale = "en",
  outDir = null,
  reportProgress,
  catalog,
}) {
  if (!researchPresetNames().includes(preset)) {
    throw cliError(
      "CLI_UNKNOWN_RESEARCH_PRESET",
      `Unknown research preset: ${String(preset)}. Expected ${researchPresetNames().join(" or ")}.`,
      { actual: preset },
    );
  }
  if (!RESEARCH_LOCALES.has(locale)) {
    throw cliError("CLI_UNKNOWN_LOCALE", '--locale must be "en" or "zh-CN".', { actual: locale });
  }
  if (runId !== null && (typeof runId !== "string" || runId.trim() === "")) {
    throw cliError("CLI_INVALID_RUN_ID", "--run-id must be a non-empty string.", { actual: runId });
  }
  let normalizedSeed;
  try {
    normalizedSeed = seed === null ? DEFAULT_RESEARCH_SEED : normalizeResearchSeed(seed);
  } catch {
    throw cliError("CLI_INVALID_SEED", "--seed must be an unsigned 32-bit integer.", { actual: seed });
  }
  const timestamp = createdAt ?? new Date().toISOString();

  const bundled = await readBundledDataset(catalog);
  const imported = importObservationDataset(bundled.text, { format: "json" });
  const record = buildDatasetRecord({
    imported: { ...imported, qualityReport: assessDatasetQuality(imported.dataset) },
    sourceText: bundled.text,
    contentHash: bundled.contentHash,
    sourceKind: "bundled",
    registryRecord: bundled.registryRecord,
    trustedBundledArtifact: true,
    updatedAt: timestamp,
  });
  if (!record.workflowEligible) {
    throw cliError(
      "CLI_DATASET_NOT_WORKFLOW_ELIGIBLE",
      `The bundled dataset does not satisfy the locked workflow contract: ${record.workflowIneligibilityReasons.join(" ")}`,
      { actual: record.workflowIneligibilityReasons },
    );
  }

  const captured = captureResearchRun({
    dataset: record,
    seed: normalizedSeed,
    preset,
    applicationVersion: APPLICATION_VERSION,
    now: () => timestamp,
  });
  const run = runId === null ? captured : { ...captured, runId };
  const result = await runEcolabResearchWorkflow({
    ...buildResearchWorkflowOptions({ run, dataset: record, resolvedModel: catalog.resolvedModel }),
    onProgress: progressFromEntry(reportProgress),
  });

  const dataset = record.normalizedDataset;
  const validationUnits = [...new Set(
    dataset.observations
      .filter((observation) => observation.role === "validation")
      .map((observation) => observation.independentUnitId),
  )].sort();
  const selectedValidationUnit = validationUnits[0] ?? null;

  const artifacts = [];
  if (outDir !== null) {
    const stem = safeFileStem(run.runId);
    artifacts.push(
      await writeArtifact("research-package-json", `${outDir}/${stem}.research-package.json`, researchPackageJson(result)),
      await writeArtifact("analysis-manifest-json", `${outDir}/${stem}.analysis-manifest.json`, analysisManifestJson(result)),
      await writeArtifact("predictions-residuals-metrics-csv", `${outDir}/${stem}.predictions-residuals-metrics.csv`, predictionsMetricsToCsv(dataset, result, locale)),
      await writeArtifact("normalized-dataset-csv", `${outDir}/${stem}.normalized-dataset.csv`, normalizedDatasetToCsv(dataset, locale)),
      await writeArtifact("methods-markdown", `${outDir}/${stem}.methods.md`, researchMethodsText(result, locale)),
      await writeArtifact("research-dashboard-svg", `${outDir}/${stem}.research-dashboard.svg`, serializeResearchDashboard({
        dataset,
        result,
        selectedValidationUnit,
        locale,
      })),
    );
  }

  return {
    kind: "ecolab.cli.research",
    schemaVersion: CLI_SCHEMA_VERSION,
    locale,
    run: {
      runId: run.runId,
      createdAt: run.createdAt,
      applicationVersion: run.applicationVersion,
      datasetVersion: run.datasetVersion,
      contentHash: run.contentHash,
      seed: run.seed,
      preset: run.preset,
    },
    qualityReport: {
      valid: record.qualityReport.valid,
      summary: record.qualityReport.summary,
    },
    result,
    artifacts,
  };
}
