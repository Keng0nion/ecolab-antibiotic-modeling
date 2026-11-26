import { assessDatasetQuality, importObservationDataset } from "../analysis/index.js";
import { buildDatasetRecord, validateCsvMetadata } from "../app/research/dataset-loader.js";
import { normalizedDatasetToCsv } from "../app/research/export.js";
import { CLI_SCHEMA_VERSION, cliError, readTextInput, safeFileStem, sha256Text, writeArtifact } from "./io.js";

const IMPORT_FORMATS = new Set(["auto", "json", "csv"]);
const CSV_METADATA_KEYS = Object.freeze(["datasetId", "title", "license"]);

function resolvedCsvMetadata({ datasetId = null, title = null, license = null }) {
  const provided = { datasetId, title, license };
  const supplied = CSV_METADATA_KEYS.filter((key) => provided[key] !== null);
  if (supplied.length === 0) return null;
  const missing = CSV_METADATA_KEYS.filter((key) => provided[key] === null);
  if (missing.length > 0) {
    throw cliError(
      "CLI_CSV_METADATA_INCOMPLETE",
      `CSV imports require explicit ${missing.map((key) => `--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`).join(", ")}.`,
      { expected: CSV_METADATA_KEYS, actual: Object.fromEntries(Object.entries(provided).map(([key, value]) => [key, value ?? null])) },
    );
  }
  return provided;
}

/**
 * Dataset QC mirrors the Research Workspace "Data" section: strict import, quality
 * report, and the workflow-eligibility decision. Only bytes identical to the
 * registered bundled artifact count as the trusted bundled source.
 */
export async function runQcCommand({
  datasetPath = null,
  format = "auto",
  datasetId = null,
  title = null,
  license = null,
  locale = "en",
  outDir = null,
  catalog,
}) {
  if (datasetPath === null) throw cliError("CLI_QC_INPUT", "qc requires --dataset <file>.");
  if (!IMPORT_FORMATS.has(format)) {
    throw cliError("CLI_INVALID_FORMAT", "--format must be auto, json, or csv.", { actual: format });
  }
  const datasetMetadata = resolvedCsvMetadata({ datasetId, title, license });
  const { text, path, stdin } = await readTextInput(datasetPath, { label: "dataset" });
  const contentHash = sha256Text(text);
  // Mirror the app's CSV admission: explicit datasetId/title/license are required
  // before import, with the same structured error the browser shows.
  const resolvedFormat = format !== "auto"
    ? format
    : (/^\s*[{[]/u.test(text.replace(/^\ufeff/u, "")) ? "json" : "csv");
  if (resolvedFormat === "csv") validateCsvMetadata(datasetMetadata ?? {});
  const bundledRecord = (catalog.datasetRegistry?.records ?? []).find(
    (record) => record.bundled === true
      && record.artifactIntegrity?.normalizedDataSha256 === contentHash,
  ) ?? null;

  const imported = importObservationDataset(text, {
    format,
    ...(datasetMetadata === null ? {} : { datasetMetadata }),
  });
  if (datasetMetadata !== null && imported.format !== "csv") {
    throw cliError(
      "CLI_CSV_METADATA_UNUSED",
      "CSV metadata options apply only to CSV imports; this input was imported as JSON.",
      { actual: imported.format },
    );
  }
  const qualityReport = assessDatasetQuality(imported.dataset);
  const record = buildDatasetRecord({
    imported: { ...imported, qualityReport },
    sourceText: text,
    contentHash,
    sourceKind: bundledRecord === null ? "file" : "bundled",
    registryRecord: bundledRecord,
    trustedBundledArtifact: bundledRecord !== null,
  });

  const artifacts = [];
  if (outDir !== null) {
    artifacts.push(await writeArtifact(
      "normalized-dataset-csv",
      `${outDir}/${safeFileStem(record.id)}.normalized-dataset.csv`,
      normalizedDatasetToCsv(record.normalizedDataset, locale),
    ));
  }

  const { sourceText: _sourceText, ...recordWithoutSourceText } = record;
  return {
    kind: "ecolab.cli.dataset-qc",
    schemaVersion: CLI_SCHEMA_VERSION,
    source: { path, stdin, bytes: Buffer.byteLength(text, "utf8"), sha256: contentHash },
    format: imported.format,
    stats: imported.stats,
    importWarnings: imported.warnings,
    qualityReport: record.qualityReport,
    record: recordWithoutSourceText,
    sourceTextIncluded: false,
    workflowEligibility: {
      eligible: record.workflowEligible,
      reasons: record.workflowIneligibilityReasons,
      matchedBundledArtifact: bundledRecord !== null,
    },
    artifacts,
  };
}
