import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { importObservationDataset } from "../src/analysis/dataset-import.js";
import { resolveModelFromRegistries } from "../src/registry/resolve.js";

const root = new URL("../", import.meta.url);

async function readJson(relativePath) {
  const text = await readFile(new URL(relativePath, root), "utf8");
  const value = JSON.parse(text);
  assertFiniteJson(value, relativePath);
  return value;
}

function assertFiniteJson(value, path) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${path} contains a non-finite number.`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFiniteJson(item, `${path}.${index}`));
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      assertFiniteJson(child, `${path}.${key}`);
    }
  }
}

function assertUnique(records, label) {
  const seen = new Set();
  for (const record of records) {
    const key = `${record.id}@${record.version}`;
    if (seen.has(key)) throw new Error(`${label} has duplicate ${key}.`);
    seen.add(key);
  }
}

function assertSafeBundledPath(relativePath, label) {
  if (
    typeof relativePath !== "string" ||
    relativePath === "" ||
    relativePath.startsWith("/") ||
    relativePath.includes("\\") ||
    relativePath.split("/").includes("..") ||
    !relativePath.startsWith("data/")
  ) {
    throw new Error(`${label} has unsafe bundled path ${JSON.stringify(relativePath)}.`);
  }
}

async function readBundledFile(relativePath, label) {
  assertSafeBundledPath(relativePath, label);
  try {
    return await readFile(new URL(relativePath, root));
  } catch (error) {
    throw new Error(`${label} cannot read ${relativePath}: ${error.message}`);
  }
}

function digest(algorithm, buffer) {
  return createHash(algorithm).update(buffer).digest("hex");
}

function requireString(value, label) {
  if (typeof value !== "string" || value === "") throw new Error(`${label} must be a non-empty string.`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer.`);
}

function requireArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must be a non-empty array.`);
}

async function auditBundledDataset(dataset, sourceById) {
  requireString(dataset.licenseStatus, `${dataset.id}.licenseStatus`);
  if (!dataset.licenseStatus.includes("redistribut")) {
    throw new Error(`${dataset.id} is bundled without an explicit redistribution license status.`);
  }
  const redistributionLicense = dataset.redistributionLicense;
  requireString(redistributionLicense?.spdx, `${dataset.id}.redistributionLicense.spdx`);
  requireString(redistributionLicense?.url, `${dataset.id}.redistributionLicense.url`);
  if (redistributionLicense.attributionRequired !== true || redistributionLicense.sourceLicenseVerified !== true) {
    throw new Error(`${dataset.id} must explicitly record verified source licensing and attribution requirements.`);
  }
  requireArray(dataset.allowedUse, `${dataset.id}.allowedUse`);
  requireArray(dataset.prohibitedUse, `${dataset.id}.prohibitedUse`);
  requireArray(dataset.knownLimitations, `${dataset.id}.knownLimitations`);
  for (const key of ["strain", "medium", "measurement", "overall"]) {
    requireString(dataset.conditionMatch?.[key], `${dataset.id}.conditionMatch.${key}`);
  }

  requireArray(dataset.sourceIds, `${dataset.id}.sourceIds`);
  for (const sourceId of dataset.sourceIds) {
    const source = sourceById.get(sourceId);
    if (!source) throw new Error(`${dataset.id} references unknown source ${sourceId}.`);
    if (!source.license?.status?.includes("redistribut")) {
      throw new Error(`${dataset.id} source ${sourceId} lacks explicit redistribution permission.`);
    }
    if (source.license.spdx !== redistributionLicense.spdx || source.license.url !== redistributionLicense.url) {
      throw new Error(`${dataset.id} source and dataset license metadata disagree.`);
    }
    if (source.license.attributionRequired !== true) {
      throw new Error(`${dataset.id} source ${sourceId} must record its attribution requirement.`);
    }
    requireString(source.attribution, `${sourceId}.attribution`);
  }

  const requiredPaths = ["normalizedJson", "normalizedCsv", "dataCard", "checksums", "acquisitionMetadata"];
  for (const key of requiredPaths) requireString(dataset.paths?.[key], `${dataset.id}.paths.${key}`);
  const requiredIntegrity = [
    "normalizedDataSha256",
    "normalizedCsvSha256",
    "dataCardSha256",
    "checksumsSha256",
    "acquisitionMetadataSha256",
  ];
  for (const key of requiredIntegrity) {
    if (!/^[0-9a-f]{64}$/.test(dataset.artifactIntegrity?.[key] ?? "")) {
      throw new Error(`${dataset.id}.artifactIntegrity.${key} must be a lowercase SHA-256.`);
    }
  }
  for (const key of ["observationCount", "trainingObservationCount", "validationObservationCount", "independentUnitCount"]) {
    requirePositiveInteger(dataset.artifactIntegrity?.[key], `${dataset.id}.artifactIntegrity.${key}`);
  }

  const pathBuffers = {};
  for (const key of requiredPaths) pathBuffers[key] = await readBundledFile(dataset.paths[key], `${dataset.id}.paths.${key}`);
  const registryHashPairs = [
    ["normalizedJson", "normalizedDataSha256"],
    ["normalizedCsv", "normalizedCsvSha256"],
    ["dataCard", "dataCardSha256"],
    ["checksums", "checksumsSha256"],
    ["acquisitionMetadata", "acquisitionMetadataSha256"],
  ];
  for (const [pathKey, hashKey] of registryHashPairs) {
    const actual = digest("sha256", pathBuffers[pathKey]);
    if (actual !== dataset.artifactIntegrity[hashKey]) {
      throw new Error(`${dataset.id} ${pathKey} SHA-256 mismatch: expected ${dataset.artifactIntegrity[hashKey]}, received ${actual}.`);
    }
  }

  const checksums = JSON.parse(pathBuffers.checksums.toString("utf8"));
  const acquisition = JSON.parse(pathBuffers.acquisitionMetadata.toString("utf8"));
  assertFiniteJson(checksums, dataset.paths.checksums);
  assertFiniteJson(acquisition, dataset.paths.acquisitionMetadata);
  if (checksums.datasetId !== dataset.id || checksums.datasetVersion !== dataset.version) {
    throw new Error(`${dataset.id} checksum manifest identity does not match the registry.`);
  }
  if (acquisition.datasetId !== dataset.id) throw new Error(`${dataset.id} acquisition metadata identity does not match the registry.`);
  if (checksums.normalizedDataSha256 !== dataset.artifactIntegrity.normalizedDataSha256) {
    throw new Error(`${dataset.id} normalizedDataSha256 disagrees between registry and checksum manifest.`);
  }
  const source = sourceById.get(dataset.sourceIds[0]);
  if (
    checksums.source?.license?.id !== redistributionLicense.spdx ||
    checksums.source?.license?.url !== redistributionLicense.url ||
    acquisition.source?.license?.id !== redistributionLicense.spdx ||
    acquisition.source?.license?.url !== redistributionLicense.url
  ) {
    throw new Error(`${dataset.id} manifest licenses do not match the registry.`);
  }
  if (
    checksums.source?.datasetDoi !== source?.doi ||
    checksums.source?.articleDoi !== source?.articleDoi ||
    checksums.source?.url !== source?.url ||
    checksums.source?.attribution !== source?.attribution ||
    acquisition.source?.datasetDoi !== source?.doi ||
    acquisition.source?.articleDoi !== source?.articleDoi ||
    acquisition.source?.url !== source?.url
  ) {
    throw new Error(`${dataset.id} manifest provenance does not match the source registry.`);
  }

  const artifactByPath = new Map((checksums.artifacts ?? []).map((artifact) => [artifact.path, artifact]));
  for (const key of ["normalizedJson", "normalizedCsv", "dataCard"]) {
    const relativePath = dataset.paths[key];
    const artifact = artifactByPath.get(relativePath);
    if (!artifact) throw new Error(`${dataset.id} checksum manifest omits ${relativePath}.`);
    const buffer = pathBuffers[key];
    if (artifact.bytes !== buffer.length || artifact.sha256 !== digest("sha256", buffer)) {
      throw new Error(`${dataset.id} checksum manifest does not match ${relativePath}.`);
    }
  }

  const acquisitionByName = new Map((acquisition.files ?? []).map((file) => [file.name, file]));
  for (const sourceFile of checksums.source?.files ?? []) {
    const buffer = await readBundledFile(sourceFile.path, `${dataset.id} source file`);
    if (
      buffer.length !== sourceFile.bytes ||
      digest("md5", buffer) !== sourceFile.md5 ||
      digest("sha256", buffer) !== sourceFile.sha256
    ) {
      throw new Error(`${dataset.id} source file ${sourceFile.path} failed size/hash verification.`);
    }
    const acquired = acquisitionByName.get(sourceFile.path.split("/").at(-1));
    if (
      !acquired ||
      acquired.url !== sourceFile.sourceUrl ||
      acquired.bytes !== sourceFile.bytes ||
      acquired.md5 !== sourceFile.md5 ||
      acquired.sha256 !== sourceFile.sha256
    ) {
      throw new Error(`${dataset.id} acquisition metadata disagrees for ${sourceFile.path}.`);
    }
  }
  if ((checksums.source?.files ?? []).length !== acquisitionByName.size) {
    throw new Error(`${dataset.id} source-file counts disagree between manifests.`);
  }

  const jsonResult = importObservationDataset(pathBuffers.normalizedJson.toString("utf8"), { format: "json" });
  const normalized = jsonResult.dataset;
  const expected = dataset.artifactIntegrity;
  if (
    normalized.metadata.datasetId !== dataset.id ||
    normalized.metadata.sourceIds?.length !== dataset.sourceIds.length ||
    !normalized.metadata.sourceIds.every((id, index) => id === dataset.sourceIds[index])
  ) {
    throw new Error(`${dataset.id} normalized metadata does not match its registry source identity.`);
  }
  if (normalized.metadata.license !== redistributionLicense.spdx) {
    throw new Error(`${dataset.id} normalized metadata license does not match the registry.`);
  }
  if (normalized.observations.length !== expected.observationCount) {
    throw new Error(`${dataset.id} has ${normalized.observations.length} observations; expected ${expected.observationCount}.`);
  }
  const trainingCount = normalized.observations.filter((observation) => observation.role === "training").length;
  const validationCount = normalized.observations.filter((observation) => observation.role === "validation").length;
  if (trainingCount !== expected.trainingObservationCount || validationCount !== expected.validationObservationCount) {
    throw new Error(`${dataset.id} training/validation counts do not match the registry.`);
  }
  const roleByUnit = new Map();
  for (const observation of normalized.observations) {
    const previousRole = roleByUnit.get(observation.independentUnitId);
    if (previousRole && previousRole !== observation.role) {
      throw new Error(`${dataset.id} splits independent unit ${observation.independentUnitId} across roles.`);
    }
    roleByUnit.set(observation.independentUnitId, observation.role);
  }
  if (roleByUnit.size !== expected.independentUnitCount) {
    throw new Error(`${dataset.id} has ${roleByUnit.size} independent units; expected ${expected.independentUnitCount}.`);
  }

  const csvResult = importObservationDataset(pathBuffers.normalizedCsv.toString("utf8"), {
    format: "csv",
    datasetMetadata: normalized.metadata,
  });
  if (csvResult.dataset.observations.length !== expected.observationCount) {
    throw new Error(`${dataset.id} CSV row count does not match the registry.`);
  }
  for (let index = 0; index < normalized.observations.length; index += 1) {
    if (JSON.stringify(csvResult.dataset.observations[index]) !== JSON.stringify(normalized.observations[index])) {
      throw new Error(`${dataset.id} CSV and JSON differ at observation ${index}.`);
    }
  }

  const jsonArtifact = artifactByPath.get(dataset.paths.normalizedJson);
  const csvArtifact = artifactByPath.get(dataset.paths.normalizedCsv);
  if (
    jsonArtifact?.observationCount !== expected.observationCount ||
    jsonArtifact?.trainingObservationCount !== expected.trainingObservationCount ||
    jsonArtifact?.validationObservationCount !== expected.validationObservationCount ||
    jsonArtifact?.independentUnitCount !== expected.independentUnitCount ||
    csvArtifact?.dataRowCount !== expected.observationCount
  ) {
    throw new Error(`${dataset.id} checksum-manifest row counts do not match the registry.`);
  }
}

const [models, parameters, sources, datasets, drugs] = await Promise.all([
  readJson("data/registry/model-definitions.json"),
  readJson("data/registry/parameter-sets.json"),
  readJson("data/registry/sources.json"),
  readJson("data/registry/datasets.json"),
  readJson("data/registry/drugs.json"),
]);

assertUnique(models.records, "model registry");
assertUnique(parameters.records, "parameter registry");
assertUnique(sources.records, "source registry");
assertUnique(datasets.records, "dataset registry");
assertUnique(drugs.records.map((drug) => ({ ...drug, version: drug.version ?? "1.0.0" })), "drug registry");

const sourceIds = new Set(sources.records.map((source) => source.id));
const sourceById = new Map(sources.records.map((source) => [source.id, source]));
for (const dataset of datasets.records) {
  for (const sourceId of dataset.sourceIds ?? []) {
    if (!sourceIds.has(sourceId)) {
      throw new Error(`${dataset.id} references unknown source ${sourceId}.`);
    }
  }
  if (dataset.bundled) await auditBundledDataset(dataset, sourceById);
}

for (const parameterSet of parameters.records) {
  resolveModelFromRegistries({
    modelRegistry: models,
    parameterRegistry: parameters,
    sourceRegistry: sources,
    modelRef: parameterSet.modelRef,
    parameterSetRef: { id: parameterSet.id, version: parameterSet.version },
  });
}

const modelDrugIds = new Set(Object.keys(parameters.records[0]?.parameters?.drugs ?? {}));
const catalogDrugIds = new Set(drugs.records.filter((drug) => drug.id !== "none").map((drug) => drug.id));
if (modelDrugIds.size !== catalogDrugIds.size || [...modelDrugIds].some((id) => !catalogDrugIds.has(id))) {
  throw new Error("Drug registry IDs must exactly match the scientific parameter-set drug IDs plus the none control.");
}
for (const drug of drugs.records) {
  if (!drug.name?.en || !drug.name?.["zh-CN"] || !drug.color || !drug.mechanism?.en || !drug.mechanism?.["zh-CN"]) {
    throw new Error(`Drug registry record ${drug.id} is missing bilingual UI metadata.`);
  }
  for (const sourceId of drug.mechanismSourceIds ?? []) {
    if (!sourceIds.has(sourceId)) throw new Error(`${drug.id} references unknown mechanism source ${sourceId}.`);
  }
}

console.log(
  `Data audit passed: ${models.records.length} model, ${parameters.records.length} parameter set, ${sources.records.length} sources, ${datasets.records.length} dataset records, ${drugs.records.length} drug records.`,
);
