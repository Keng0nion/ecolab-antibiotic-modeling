import { sha256Hex } from "../../analysis/index.js";

export const SUPPORTED_DATASET_ID = "figshare-bw25113-growth-v1";
export const SUPPORTED_DATASET_VERSION = "1.0.0";
export const SUPPORTED_DATASET_REF = `${SUPPORTED_DATASET_ID}@${SUPPORTED_DATASET_VERSION}`;

const EXPECTED = Object.freeze({
  contentHash: "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817",
  observations: 528,
  trainingObservations: 352,
  validationObservations: 176,
  units: 12,
  trainingUnits: 8,
  validationUnits: 4,
});

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function observationsFor(dataset, role) {
  return dataset.observations.filter((observation) => observation.role === role);
}

function unitCount(observations) {
  return new Set(observations.map((observation) => observation.independentUnitId)).size;
}

function unsupportedReasons(record, trusted) {
  const dataset = record.normalizedDataset;
  const training = dataset ? observationsFor(dataset, "training") : [];
  const validation = dataset ? observationsFor(dataset, "validation") : [];
  const reasons = [];
  if (!trusted) reasons.push("Only the integrity-verified bundled artifact enables the locked one-click Stage 4 workflow.");
  if (record.registryRef !== SUPPORTED_DATASET_REF) reasons.push(`Registry contract must be exactly ${SUPPORTED_DATASET_REF}.`);
  if (record.contentHash !== EXPECTED.contentHash) reasons.push("Bundled normalized JSON artifact SHA-256 does not match the supported contract.");
  if (dataset?.metadata?.datasetId !== SUPPORTED_DATASET_ID) reasons.push(`Normalized dataset ID must be ${SUPPORTED_DATASET_ID}.`);
  if (dataset?.observations?.length !== EXPECTED.observations) reasons.push("Observation count does not match the supported contract.");
  if (training.length !== EXPECTED.trainingObservations || validation.length !== EXPECTED.validationObservations) {
    reasons.push("Training/validation observation counts do not match the complete-unit split.");
  }
  if (unitCount(dataset?.observations ?? []) !== EXPECTED.units || unitCount(training) !== EXPECTED.trainingUnits || unitCount(validation) !== EXPECTED.validationUnits) {
    reasons.push("Independent-unit counts do not match the 8-training/4-validation contract.");
  }
  if (dataset?.observations?.some((observation) => observation.measurementType !== "od600")) {
    reasons.push("Every observation must retain OD600 semantics.");
  }
  if (dataset?.observations?.some((observation) => observation.timeHours <= 0)) {
    reasons.push("The source contract has no t0 observation; inserted or fabricated t0 values are forbidden.");
  }
  if (record.qualityReport?.valid !== true) reasons.push("Dataset QC must be valid.");
  return reasons;
}

export function bundledDatasetRecord(datasetRegistry) {
  const record = datasetRegistry?.records?.find(
    (candidate) => candidate.id === SUPPORTED_DATASET_ID && candidate.version === SUPPORTED_DATASET_VERSION,
  );
  if (!record?.bundled || !nonEmpty(record.paths?.normalizedJson)) {
    throw new Error(`Bundled dataset ${SUPPORTED_DATASET_REF} is unavailable.`);
  }
  return record;
}

export function bundledDatasetSource(sourceRegistry) {
  return sourceRegistry?.records?.find(
    (candidate) => candidate.id === SUPPORTED_DATASET_ID && candidate.version === SUPPORTED_DATASET_VERSION,
  ) ?? null;
}

export function trustedDatasetUrl(registryRecord, baseUrl = import.meta.url) {
  const path = registryRecord?.paths?.normalizedJson;
  if (!nonEmpty(path) || path.startsWith("/") || path.includes("..") || !path.startsWith("data/datasets/")) {
    throw new Error("Bundled dataset registry path is not trusted.");
  }
  return new URL(`../../../${path}`, baseUrl);
}

export async function fetchBundledDatasetText({ registryRecord, fetchImpl = fetch, hashImpl = sha256Hex }) {
  const response = await fetchImpl(trustedDatasetUrl(registryRecord));
  if (!response?.ok) throw new Error(`BUNDLED_DATASET_HTTP_ERROR:${response?.status ?? "unknown"}`);
  const text = await response.text();
  const actualHash = await hashImpl(text);
  const expectedHash = registryRecord.artifactIntegrity?.normalizedDataSha256;
  if (!nonEmpty(expectedHash) || actualHash !== expectedHash) {
    const error = new Error("Bundled dataset SHA-256 verification failed.");
    error.code = "BUNDLED_DATASET_HASH_MISMATCH";
    error.expected = expectedHash;
    error.actual = actualHash;
    throw error;
  }
  return { text, contentHash: actualHash };
}

export function assessWorkflowEligibility(record, { trustedBundledArtifact = false } = {}) {
  const reasons = unsupportedReasons(record, trustedBundledArtifact);
  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

export function buildDatasetRecord({
  imported,
  sourceText,
  contentHash,
  sourceKind,
  registryRecord = null,
  trustedBundledArtifact = false,
  updatedAt = new Date().toISOString(),
}) {
  if (!imported?.dataset || !imported?.qualityReport) throw new TypeError("A parsed dataset and QC report are required.");
  const dataset = imported.dataset;
  const datasetVersion = registryRecord?.version ?? "unversioned-import";
  const stableSourceId = sourceKind === "bundled"
    ? SUPPORTED_DATASET_REF
    : `import:${dataset.metadata.datasetId}:${contentHash.slice(0, 16)}`;
  const record = {
    id: stableSourceId,
    revision: 0,
    updatedAt,
    datasetVersion,
    title: dataset.metadata.title,
    license: dataset.metadata.license ?? "",
    sourceKind,
    sourceFormat: imported.format,
    sourceText,
    normalizedDataset: dataset,
    contentHash,
    registryRef: registryRecord ? `${registryRecord.id}@${registryRecord.version}` : null,
    integrityVerified: trustedBundledArtifact,
    qualityReport: imported.qualityReport,
    importWarnings: imported.warnings ?? [],
    importStats: imported.stats ?? null,
  };
  const eligibility = assessWorkflowEligibility(record, { trustedBundledArtifact });
  record.workflowEligible = eligibility.eligible;
  record.workflowIneligibilityReasons = eligibility.reasons;
  return record;
}

export async function createGenericDatasetRecord({ imported, sourceText, sourceFormat, hashImpl = sha256Hex, updatedAt }) {
  const contentHash = await hashImpl(sourceText);
  return buildDatasetRecord({
    imported: { ...imported, format: imported.format ?? sourceFormat },
    sourceText,
    contentHash,
    sourceKind: "file",
    trustedBundledArtifact: false,
    updatedAt,
  });
}

export function validateCsvMetadata(metadata) {
  const missing = ["datasetId", "title", "license"].filter((key) => !nonEmpty(metadata?.[key]));
  if (missing.length > 0) {
    const error = new Error(`CSV import requires explicit ${missing.join(", ")}.`);
    error.code = "CSV_METADATA_REQUIRED";
    error.missing = missing;
    throw error;
  }
  return {
    datasetId: metadata.datasetId.trim(),
    title: metadata.title.trim(),
    license: metadata.license.trim(),
  };
}

function selectedDatasetParts(selectedDataset) {
  if (selectedDataset?.normalizedDataset) {
    return { record: selectedDataset, dataset: selectedDataset.normalizedDataset };
  }
  return { record: null, dataset: selectedDataset };
}

function isTrustedBundledSelection(record, dataset, registryRecord) {
  return record?.sourceKind === "bundled"
    && record.integrityVerified === true
    && record.registryRef === SUPPORTED_DATASET_REF
    && dataset?.metadata?.datasetId === SUPPORTED_DATASET_ID
    && registryRecord?.id === SUPPORTED_DATASET_ID
    && registryRecord?.version === SUPPORTED_DATASET_VERSION;
}

function documentedValue(value) {
  return value !== undefined && value !== null && value !== "";
}

function displayCondition(value) {
  if (!documentedValue(value)) return "unknown";
  if (typeof value === "object" && !Array.isArray(value)) {
    return value.conditionId ?? value.name ?? value.label ?? JSON.stringify(value);
  }
  return String(value);
}

function comparisonStatus(datasetValue, targetValue) {
  if (!documentedValue(datasetValue)) return "unknown";
  if (!documentedValue(targetValue)) return "unknown";
  return displayCondition(datasetValue).trim().toLowerCase()
    === displayCondition(targetValue).trim().toLowerCase()
    ? "match"
    : "mismatch";
}

function measurementComparison(dataset) {
  const measurementTypes = [...new Set(
    (dataset?.observations ?? [])
      .map((observation) => observation?.measurementType)
      .filter(documentedValue)
      .map((value) => String(value).trim().toLowerCase()),
  )].sort();
  if (measurementTypes.length === 0) {
    return { status: "unknown", dataset: "unknown", detailKey: "unknown" };
  }
  if (measurementTypes.length > 1) {
    return {
      status: "mixed",
      dataset: measurementTypes.join(", "),
      detailKey: "measurementMixed",
    };
  }
  const [measurement] = measurementTypes;
  if (measurement === "log10_cfu_per_ml" || measurement === "cfu_per_ml") {
    return { status: "match", dataset: measurement, detailKey: "measurementMatch" };
  }
  if (measurement === "od600" || measurement === "od" || measurement.includes("optical_density")) {
    const blankCorrection = dataset?.metadata?.conditions?.rawOdBlankCorrection;
    const label = measurement === "od600" ? "OD600" : measurement;
    const semantics = documentedValue(blankCorrection)
      ? `${label} (${String(blankCorrection)})`
      : `${label} (blank-correction status unknown)`;
    return { status: "incompatible", dataset: semantics, detailKey: "measurementIncompatible" };
  }
  return { status: "incompatible", dataset: measurement, detailKey: "measurementIncompatible" };
}

export function conditionComparison(registryRecord, resolvedModel, selectedDataset = null) {
  const target = resolvedModel?.parameterSet?.conditions?.target
    ?? resolvedModel?.provenance?.parameterSet?.conditions?.target
    ?? resolvedModel?.conditions?.target
    ?? null;
  const { record, dataset } = selectedDatasetParts(selectedDataset);
  const trustedBundledSelection = isTrustedBundledSelection(record, dataset, registryRecord);
  const datasetConditions = dataset?.metadata?.conditions ?? {};
  const strain = datasetConditions.strain
    ?? (trustedBundledSelection ? registryRecord?.strain : undefined);
  const medium = datasetConditions.medium;
  const measurement = measurementComparison(dataset);
  const strainStatus = comparisonStatus(strain, target?.strain);
  const mediumStatus = comparisonStatus(medium, target?.medium);
  return [
    {
      field: "strain",
      status: strainStatus,
      dataset: displayCondition(strain),
      target: displayCondition(target?.strain),
      detailKey: strainStatus,
    },
    {
      field: "medium",
      status: mediumStatus,
      dataset: displayCondition(medium),
      target: displayCondition(target?.medium),
      detailKey: mediumStatus,
    },
    {
      field: "measurement",
      status: measurement.status,
      dataset: measurement.dataset,
      target: "latent/direct CFU per mL model output",
      detailKey: measurement.detailKey,
    },
  ];
}

export function datasetSummary(record) {
  const observations = record?.normalizedDataset?.observations ?? [];
  const training = observationsFor(record.normalizedDataset ?? { observations: [] }, "training");
  const validation = observationsFor(record.normalizedDataset ?? { observations: [] }, "validation");
  return {
    observationCount: observations.length,
    independentUnitCount: unitCount(observations),
    trainingObservationCount: training.length,
    validationObservationCount: validation.length,
    trainingUnitCount: unitCount(training),
    validationUnitCount: unitCount(validation),
  };
}
