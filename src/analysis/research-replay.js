import { ENGINE_VERSION } from "../model.js";
import { validateAnalysisPlan } from "./analysis-plan.js";
import { importObservationDataset, normalizeObservationDataset, parseJsonStrict } from "./dataset-import.js";
import { canonicalJson, sha256HexFallback } from "./fingerprint.js";
import { GROWTH_COMPARISON_LIMITS } from "./growth-comparison.js";
import { deriveSeed, RNG_ALGORITHM } from "./random.js";
import { hasCanonicalNumericWarningMessage } from "./replay-warning-equivalence.js";
import { researchWorkflowComputationSettings, researchWorkflowConfiguration, researchWorkflowRuntime } from "./research-workflow.js";
import { RESEARCH_WORKFLOW_IMPLEMENTATION_ID, runEcolabResearchWorkflow, scientificResearchProjection } from "./research-upgrade.js";
import { ANALYSIS_ENGINE_ID, ANALYSIS_ENGINE_VERSION, ANALYSIS_IMPLEMENTATION_ID } from "./version.js";

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ARTIFACTS = 64;
const MAX_DEPTH = 64;
const MAX_NODES = 1_000_000;
const MAX_MISMATCH_PATHS = 100;
const MAX_PATH_LENGTH = 512;
const ENCODER = new TextEncoder();
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor", "toJSON"]);
const HASH = /^[0-9a-f]{64}$/;
const VERSIONS = Object.freeze({ application: "6.0.0", core: ENGINE_VERSION, analysis: ANALYSIS_ENGINE_VERSION, analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID });
const MODEL = Object.freeze({ id: "ecolab.single-population.regoes-logistic", version: "1.0.0", implementationId: "regoes-logistic-piecewise-analytic-v1" });
const REQUIRED_ARTIFACTS = ["normalized-observation-dataset", "dataset-split", "locked-analysis-plan", "resolved-model-snapshot", "research-replay-input", "scientific-result"];
const OPTIMIZER_KEYS = ["restarts", "populationSize", "differentialEvolutionMaxEvaluations", "nelderMeadMaxEvaluations"];
const OPTION_KEYS = [
  "datasetInput", "datasetFormat", "resolvedModel", "applicationVersion", "runId", "createdAt", "datasetVersion", "contentHash",
  "packageId", "planId", "developmentComparison", "scalarOutputTimeHours", "seed", "seeds", "computationSettings", "optimizer",
  "scanPointsPerAxis", "monteCarloSamples", "morrisTrajectories", "morrisLevels", "sobolSamples", "sobolBootstrapReplicates",
  "sobolConfidenceLevel", "sobolPrecisionTolerance", "identifiabilityProfilePoints", "returnedMonteCarloSamples",
  "sobolBootstrapSeed", "uncertaintyRangeFraction", "includeMonteCarloSamples", "growthComparison",
];
const ARTIFACT_PATH = "$.contents.artifacts";
const MANIFEST_PATH = "$.contents.analysisManifest";
const INPUT_PATH = `${ARTIFACT_PATH}.research-replay-input`;

export class ResearchReplayError extends Error {
  constructor(code, message, { path = "$" } = {}) {
    super(message);
    this.name = "ResearchReplayError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path = "$") { throw new ResearchReplayError(code, message, { path }); }
function schema(ok, path, message = "Invalid or missing field.") {
  if (!ok) fail("RESEARCH_PACKAGE_SCHEMA", message, path);
}
function integrity(ok, path, message = "Embedded artifacts or their references disagree.") {
  if (!ok) fail("RESEARCH_PACKAGE_INTEGRITY", message, path);
}
function same(actual, expected, path) {
  integrity(actual !== undefined && expected !== undefined && canonicalJson(actual) === canonicalJson(expected), path);
}
function hash(value) { return sha256HexFallback(canonicalJson(value)); }
function object(value, path) { schema(value !== null && typeof value === "object" && !Array.isArray(value), path, "Expected an object."); }
function shape(value, required, optional, path, open = false) {
  object(value, path);
  for (const key of required) schema(Object.hasOwn(value, key), `${path}.${key}`, "Required field is missing.");
  if (!open) for (const key of Object.keys(value)) schema(required.includes(key) || optional.includes(key), `${path}.${key}`, "Unknown field.");
}
function string(value, path) { schema(typeof value === "string" && value.length > 0, path, "Expected a nonempty string."); }
function strings(value, keys, path) { for (const key of keys) string(value[key], `${path}.${key}`); }
function array(value, path) { schema(Array.isArray(value), path, "Expected an array."); }
function number(value, path, lower = -Infinity, upper = Infinity, integer = false) {
  schema(typeof value === "number" && Number.isFinite(value) && value >= lower && value <= upper && (!integer || Number.isSafeInteger(value)), path, "Number is outside its allowed range or has the wrong type.");
}
function digest(value, path) { schema(typeof value === "string" && HASH.test(value), path, "Expected lowercase SHA-256 hex."); }
function timestamp(value, path) {
  string(value, path);
  const match = /^(\d{4})-(\d\d)-(\d\d)[Tt](\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:[Zz]|([+-])(\d\d):(\d\d))$/.exec(value);
  schema(Boolean(match) && Number.isFinite(Date.parse(value)), path, "Expected an ISO date-time with timezone.");
  const [, year, month, day, hour, minute, second, , zoneHour = "0", zoneMinute = "0"] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  schema(+month >= 1 && +month <= 12 && +day >= 1 && +day <= days[+month - 1] && +hour < 24 && +minute < 60 && +second < 60 && +zoneHour < 24 && +zoneMinute < 60, path, "Invalid calendar date or time.");
}
function freeze(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

// Only descriptor values are read. In particular, neither getters nor toJSON are
// consulted before hashing. This boundary accepts JSON data, not live class instances.
function safeClone(input) {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new Set();
  function addBytes(count, path) {
    bytes += count;
    if (bytes > MAX_BYTES) fail("RESEARCH_PACKAGE_LIMIT", "Package exceeds 32 MiB of UTF-8 JSON.", path);
  }
  function jsonBytes(value, path) {
    if (typeof value === "string" && value.length > MAX_BYTES) fail("RESEARCH_PACKAGE_LIMIT", "String exceeds package size limit.", path);
    addBytes(ENCODER.encode(JSON.stringify(value)).length, path);
  }
  function copy(value, path, depth) {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) fail("RESEARCH_PACKAGE_LIMIT", "Package exceeds depth or node limit.", path);
    if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      jsonBytes(value, path);
      return value;
    }
    if (typeof value !== "object" || ancestors.has(value)) fail("RESEARCH_PACKAGE_UNSAFE", "Expected acyclic, finite JSON data.", path);
    const isArray = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      fail("RESEARCH_PACKAGE_UNSAFE", "Only plain JSON objects and arrays are accepted.", path);
    }
    const length = isArray ? Object.getOwnPropertyDescriptor(value, "length").value : 0;
    if (isArray && nodes + length > MAX_NODES) fail("RESEARCH_PACKAGE_LIMIT", "Array exceeds node limit.", path);
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_NODES) fail("RESEARCH_PACKAGE_LIMIT", "Object exceeds node limit.", path);
    if (isArray && keys.length !== length + 1) fail("RESEARCH_PACKAGE_UNSAFE", "Sparse arrays or array properties are not JSON data.", path);
    ancestors.add(value);
    const result = isArray ? [] : {};
    addBytes(2, path);
    let count = 0;
    for (const key of keys) {
      if (isArray && key === "length") continue;
      if (typeof key !== "string" || UNSAFE_KEYS.has(key)) fail("RESEARCH_PACKAGE_UNSAFE", "Unsafe or symbolic property.", path);
      const childPath = isArray ? `${path}[${key}]` : `${path}.${key}`;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable) fail("RESEARCH_PACKAGE_UNSAFE", "Accessors and hidden properties are not accepted.", childPath);
      if (isArray && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length)) fail("RESEARCH_PACKAGE_UNSAFE", "Non-index array property.", childPath);
      if (count++) addBytes(1, path);
      if (!isArray) { jsonBytes(key, childPath); addBytes(1, childPath); }
      result[key] = copy(descriptor.value, childPath, depth + 1);
    }
    ancestors.delete(value);
    return result;
  }
  return copy(input, "$", 0);
}

function readInput(input) {
  if (typeof input !== "string") return safeClone(input);
  if (input.length > MAX_BYTES || ENCODER.encode(input).length > MAX_BYTES) fail("RESEARCH_PACKAGE_LIMIT", "Source exceeds 32 MiB of UTF-8 text.");
  let parsed;
  try {
    // TextEncoder above is authoritative: the older import helper overcounts
    // unpaired high surrogates, so its redundant byte guard is intentionally wider.
    parsed = parseJsonStrict(input, { limits: { blockBytes: MAX_BYTES * 2, maxStringLength: MAX_BYTES, maxDepth: MAX_DEPTH, maxNodes: MAX_NODES } });
  } catch (error) {
    const code = error.code === "UNSAFE_OBJECT_KEY" ? "RESEARCH_PACKAGE_UNSAFE"
      : ["JSON_DEPTH_LIMIT", "JSON_NODE_LIMIT", "JSON_STRING_TOO_LONG", "INPUT_TOO_LARGE"].includes(error.code) ? "RESEARCH_PACKAGE_LIMIT" : "RESEARCH_PACKAGE_JSON";
    fail(code, error.message, error.path ?? "$");
  }
  return safeClone(parsed);
}

function validateManifest(m) {
  const p = MANIFEST_PATH;
  shape(m, ["schemaVersion", "kind", "runId", "createdAt", "versions", "model", "baseParameterSet", "parameterOverrides", "dataset", "splitFingerprint", "plan", "random", "algorithm", "failures", "convergence", "diagnostics", "capabilityAssessment", "warnings"], [], p);
  schema(m.schemaVersion === "1.0.0" && m.kind === "ecolab.analysis-run", p);
  string(m.runId, `${p}.runId`); timestamp(m.createdAt, `${p}.createdAt`);
  // Mirror analysis-run.schema.json's structure; implementation/version constants
  // are an execution allowlist below, not a reason to hide valid historical data.
  const versionKeys = ["application", "core", "analysis", "analysisEngineId", "analysisImplementationId"];
  shape(m.versions, versionKeys, [], `${p}.versions`); strings(m.versions, versionKeys, `${p}.versions`);
  shape(m.model, ["id", "version", "implementationId"], [], `${p}.model`); strings(m.model, ["id", "version", "implementationId"], `${p}.model`);
  shape(m.baseParameterSet, ["id", "version", "resolvedParameters"], [], `${p}.baseParameterSet`);
  strings(m.baseParameterSet, ["id", "version"], `${p}.baseParameterSet`); object(m.baseParameterSet.resolvedParameters, `${p}.baseParameterSet.resolvedParameters`);
  array(m.parameterOverrides, `${p}.parameterOverrides`);
  m.parameterOverrides.forEach((entry, i) => {
    const path = `${p}.parameterOverrides[${i}]`;
    shape(entry, ["name", "value", "origin"], [], path); string(entry.name, `${path}.name`); number(entry.value, `${path}.value`);
    if (typeof entry.origin === "string") string(entry.origin, `${path}.origin`); else object(entry.origin, `${path}.origin`);
  });
  shape(m.dataset, ["id", "version", "normalizedDatasetFingerprint", "fingerprint", "hash", "license"], ["sourceArtifactSha256"], `${p}.dataset`);
  strings(m.dataset, ["id", "version", "license"], `${p}.dataset`);
  for (const key of ["normalizedDatasetFingerprint", "fingerprint", "hash", ...(Object.hasOwn(m.dataset, "sourceArtifactSha256") ? ["sourceArtifactSha256"] : [])]) digest(m.dataset[key], `${p}.dataset.${key}`);
  digest(m.splitFingerprint, `${p}.splitFingerprint`);
  shape(m.plan, ["id", "analysisKind", "fingerprint"], [], `${p}.plan`);
  strings(m.plan, ["id", "analysisKind"], `${p}.plan`); digest(m.plan.fingerprint, `${p}.plan.fingerprint`);
  shape(m.random, ["algorithm", "seed"], [], `${p}.random`); string(m.random.algorithm, `${p}.random.algorithm`); number(m.random.seed, `${p}.random.seed`, 0, 0xffff_ffff, true);
  shape(m.algorithm, ["name", "bounds", "stopping"], ["version", "settings"], `${p}.algorithm`);
  string(m.algorithm.name, `${p}.algorithm.name`);
  for (const key of ["bounds", "stopping", ...(Object.hasOwn(m.algorithm, "settings") ? ["settings"] : [])]) object(m.algorithm[key], `${p}.algorithm.${key}`);
  if (Object.hasOwn(m.algorithm, "version")) string(m.algorithm.version, `${p}.algorithm.version`);
  array(m.failures, `${p}.failures`);
  shape(m.convergence, ["converged"], [], `${p}.convergence`, true); schema(typeof m.convergence.converged === "boolean", `${p}.convergence.converged`);
  shape(m.diagnostics, ["residuals", "identifiability", "metrics"], [], `${p}.diagnostics`);
  array(m.warnings, `${p}.warnings`);
  m.warnings.forEach((warning, i) => {
    shape(warning, ["code", "severity", "message"], [], `${p}.warnings[${i}]`, true);
    strings(warning, ["code", "severity", "message"], `${p}.warnings[${i}]`);
  });
}

function validatePackage(pkg) {
  shape(pkg, ["schemaVersion", "kind", "packageId", "createdAt", "analysisRunId", "replay", "artifactInventory", "contents"], [], "$");
  schema(pkg.schemaVersion === "1.0.0" && pkg.kind === "ecolab.research-package", "$");
  strings(pkg, ["packageId", "analysisRunId"], "$"); timestamp(pkg.createdAt, "$.createdAt");
  shape(pkg.contents, ["analysisManifest", "methodsSummaryMarkdown", "artifacts"], [], "$.contents");
  string(pkg.contents.methodsSummaryMarkdown, "$.contents.methodsSummaryMarkdown"); object(pkg.contents.artifacts, ARTIFACT_PATH);
  const r = pkg.replay;
  shape(r, ["status", "selfContained", "statement", "artifactIds", "dependencies"], [], "$.replay");
  string(r.statement, "$.replay.statement"); array(r.artifactIds, "$.replay.artifactIds"); array(r.dependencies, "$.replay.dependencies");
  schema(typeof r.selfContained === "boolean", "$.replay.selfContained");
  schema((r.status === "self_contained" && r.selfContained && r.dependencies.length === 0)
    || (r.status === "requires_declared_dependencies" && !r.selfContained && r.dependencies.length > 0)
    || (r.status === "replay_requirements_incomplete" && !r.selfContained && r.dependencies.length === 0), "$.replay", "Conflicting replay declaration.");
  r.artifactIds.forEach((id, i) => string(id, `$.replay.artifactIds[${i}]`));
  r.dependencies.forEach((dep, i) => {
    const path = `$.replay.dependencies[${i}]`;
    shape(dep, ["id", "kind", "requirement"], ["version", "description"], path); strings(dep, Object.keys(dep), path);
  });
  array(pkg.artifactInventory, "$.artifactInventory");
  if (pkg.artifactInventory.length > MAX_ARTIFACTS || Object.keys(pkg.contents.artifacts).length > MAX_ARTIFACTS - 2) fail("RESEARCH_PACKAGE_LIMIT", "At most 64 artifacts, including reserved entries, are accepted.", "$.artifactInventory");
  schema(pkg.artifactInventory.length >= 2, "$.artifactInventory");
  pkg.artifactInventory.forEach((entry, i) => {
    const path = `$.artifactInventory[${i}]`;
    shape(entry, ["artifactId", "role", "path", "mediaType", "sha256", "byteLength"], ["description"], path);
    strings(entry, ["artifactId", "role", "path", "mediaType", ...(Object.hasOwn(entry, "description") ? ["description"] : [])], path);
    digest(entry.sha256, `${path}.sha256`); number(entry.byteLength, `${path}.byteLength`, 0, Number.MAX_SAFE_INTEGER, true);
  });
  validateManifest(pkg.contents.analysisManifest);
}

function safeId(id, path) {
  if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || UNSAFE_KEYS.has(id)) fail("RESEARCH_PACKAGE_UNSAFE", "Unsafe artifact ID.", path);
}
function safePath(value, path) {
  // Portable, relative inventory labels only: no decoding, filesystem access or URLs.
  if (value.split("/").some((part) => !/^[A-Za-z0-9._-]+$/.test(part) || part === "." || part === ".." || part.endsWith("."))) fail("RESEARCH_PACKAGE_UNSAFE", "Unsafe artifact path.", path);
}
function verifyInventory(pkg) {
  const reserved = {
    "analysis-manifest": { role: "analysis_manifest", path: "analysis-manifest.json", mediaType: "application/json", content: pkg.contents.analysisManifest },
    "methods-summary": { role: "methods_summary", path: "methods-summary.md", mediaType: "text/markdown", content: pkg.contents.methodsSummaryMarkdown },
  };
  const contents = new Map(Object.entries(pkg.contents.artifacts));
  for (const [id, entry] of Object.entries(reserved)) {
    integrity(!contents.has(id), `${ARTIFACT_PATH}.${id}`, "Reserved artifact must not appear in additional contents.");
    contents.set(id, entry.content);
  }
  for (const id of contents.keys()) safeId(id, `${ARTIFACT_PATH}.${id}`);
  const ids = new Set(); const paths = new Set();
  pkg.artifactInventory.forEach((entry, i) => {
    const path = `$.artifactInventory[${i}]`;
    safeId(entry.artifactId, `${path}.artifactId`); safePath(entry.path, `${path}.path`);
    integrity(!ids.has(entry.artifactId) && !paths.has(entry.path.toLowerCase()), path, "Duplicate artifact ID or path.");
    ids.add(entry.artifactId); paths.add(entry.path.toLowerCase());
    integrity(contents.has(entry.artifactId), path, "Inventory content is missing.");
    if (Object.hasOwn(reserved, entry.artifactId)) for (const key of ["role", "path", "mediaType"]) same(entry[key], reserved[entry.artifactId][key], `${path}.${key}`);
    const content = contents.get(entry.artifactId);
    const text = typeof content === "string" ? content : canonicalJson(content);
    integrity(ENCODER.encode(text).length === entry.byteLength, `${path}.byteLength`, "Artifact UTF-8 byte length does not match.");
    integrity(sha256HexFallback(text) === entry.sha256, `${path}.sha256`, "Artifact SHA-256 does not match.");
  });
  integrity(ids.size === contents.size, "$.artifactInventory", "Every embedded content must have exactly one inventory entry.");
  const replayIds = new Set();
  for (const id of pkg.replay.artifactIds) {
    safeId(id, "$.replay.artifactIds");
    integrity(Object.hasOwn(pkg.contents.artifacts, id) && !replayIds.has(id), "$.replay.artifactIds", "Replay IDs must uniquely reference embedded additional content.");
    replayIds.add(id);
  }
  const dependencies = pkg.replay.dependencies.map(({ id }) => id);
  integrity(new Set(dependencies).size === dependencies.length, "$.replay.dependencies", "Duplicate dependency IDs.");
}

function checked(action, path, code = "RESEARCH_PACKAGE_INTEGRITY") {
  try { return action(); } catch (error) {
    if (error instanceof ResearchReplayError) throw error;
    fail(code, error.message, path);
  }
}
function verifySplit(split, dataset, manifest) {
  const path = `${ARTIFACT_PATH}.dataset-split`;
  shape(split, ["schemaVersion", "kind", "sourceDatasetId", "sourceDatasetFingerprint", "strategy", "lockedValidation", "roles", "splitFingerprint"], [], path);
  schema(split.schemaVersion === "1.0.0" && split.kind === "observation-dataset-split" && typeof split.lockedValidation === "boolean", path);
  strings(split, ["sourceDatasetId", "strategy"], path);
  digest(split.sourceDatasetFingerprint, `${path}.sourceDatasetFingerprint`); digest(split.splitFingerprint, `${path}.splitFingerprint`);
  const { splitFingerprint, ...body } = split;
  same(splitFingerprint, hash(body), `${path}.splitFingerprint`);
  same(splitFingerprint, manifest.splitFingerprint, `${path}.splitFingerprint`);
  same(split.sourceDatasetFingerprint, manifest.dataset.normalizedDatasetFingerprint, `${path}.sourceDatasetFingerprint`);
  same(split.sourceDatasetId, manifest.dataset.id, `${path}.sourceDatasetId`);
  const roles = ["training", "development", "validation"];
  shape(split.roles, roles, [], `${path}.roles`);
  const allUnits = new Set(); const allRows = new Set();
  for (const role of roles) {
    const entry = split.roles[role]; const rp = `${path}.roles.${role}`;
    shape(entry, ["independentUnitIds", "observationIds", "independentUnitCount", "observationCount"], [], rp);
    for (const [list, count, seen] of [["independentUnitIds", "independentUnitCount", allUnits], ["observationIds", "observationCount", allRows]]) {
      array(entry[list], `${rp}.${list}`); number(entry[count], `${rp}.${count}`, 0, MAX_NODES, true);
      same(entry[count], entry[list].length, `${rp}.${count}`);
      for (const id of entry[list]) {
        string(id, `${rp}.${list}`); integrity(!seen.has(id), `${rp}.${list}`, "Split IDs overlap or are duplicated."); seen.add(id);
      }
    }
    if (dataset) {
      const observations = dataset.observations.filter((row) => row.role === role);
      const sort = (values) => values.sort((a, b) => a.localeCompare(b));
      same(entry.observationIds, sort(observations.map(({ observationId }) => observationId)), `${rp}.observationIds`);
      same(entry.independentUnitIds, sort([...new Set(observations.map(({ independentUnitId }) => independentUnitId))]), `${rp}.independentUnitIds`);
    }
  }
}

function verifyAssociations(pkg) {
  const m = pkg.contents.analysisManifest;
  const a = pkg.contents.artifacts;
  same(pkg.analysisRunId, m.runId, "$.analysisRunId");
  for (const key of ["fingerprint", "hash"]) same(m.dataset[key], m.dataset.normalizedDatasetFingerprint, `${MANIFEST_PATH}.dataset.${key}`);
  const dataset = a["normalized-observation-dataset"];
  if (Object.hasOwn(a, "normalized-observation-dataset")) {
    const normalized = checked(() => normalizeObservationDataset(dataset), `${ARTIFACT_PATH}.normalized-observation-dataset`);
    same(dataset, normalized, `${ARTIFACT_PATH}.normalized-observation-dataset`);
    same(hash(normalized), m.dataset.normalizedDatasetFingerprint, `${MANIFEST_PATH}.dataset.normalizedDatasetFingerprint`);
    same(normalized.metadata.datasetId, m.dataset.id, `${MANIFEST_PATH}.dataset.id`);
    same(normalized.metadata.license, m.dataset.license, `${MANIFEST_PATH}.dataset.license`);
  }
  const split = a["dataset-split"];
  if (Object.hasOwn(a, "dataset-split")) verifySplit(split, dataset, m);
  const model = a["resolved-model-snapshot"];
  if (Object.hasOwn(a, "resolved-model-snapshot")) {
    object(model, `${ARTIFACT_PATH}.resolved-model-snapshot`); object(model.ref, `${ARTIFACT_PATH}.resolved-model-snapshot.ref`);
    for (const key of ["id", "version", "implementationId"]) same(model.ref[key], m.model[key], `${MANIFEST_PATH}.model.${key}`);
    same(model.ref.parameterSetId, m.baseParameterSet.id, `${MANIFEST_PATH}.baseParameterSet.id`);
    same(model.ref.parameterSetVersion, m.baseParameterSet.version, `${MANIFEST_PATH}.baseParameterSet.version`);
    same(model.parameters, m.baseParameterSet.resolvedParameters, `${MANIFEST_PATH}.baseParameterSet.resolvedParameters`);
  }
  let plan;
  if (Object.hasOwn(a, "locked-analysis-plan")) {
    const path = `${ARTIFACT_PATH}.locked-analysis-plan`;
    plan = checked(() => validateAnalysisPlan(a["locked-analysis-plan"], { requireLocked: true }), path);
    const { planFingerprint, ...body } = plan;
    same(planFingerprint, hash(body), `${path}.planFingerprint`);
    same(m.plan, { id: plan.id, analysisKind: plan.analysisKind, fingerprint: planFingerprint }, `${MANIFEST_PATH}.plan`);
    same(plan.datasetFingerprint, m.dataset.normalizedDatasetFingerprint, `${path}.datasetFingerprint`);
    same(plan.splitFingerprint, m.splitFingerprint, `${path}.splitFingerprint`);
    same(plan.modelRef, { id: m.model.id, version: m.model.version }, `${path}.modelRef`);
    same(plan.baseParameterSetRef, { id: m.baseParameterSet.id, version: m.baseParameterSet.version }, `${path}.baseParameterSetRef`);
    same(plan.seeds.analysis, m.random.seed, `${path}.seeds.analysis`); same(plan.randomAlgorithm, m.random.algorithm, `${path}.randomAlgorithm`);
    if (split) same(plan.validationIndependentUnitIds, split.roles.validation.independentUnitIds, `${path}.validationIndependentUnitIds`);
    const names = m.parameterOverrides.map(({ name }) => name);
    integrity(new Set(names).size === names.length, `${MANIFEST_PATH}.parameterOverrides`, "Duplicate parameter overrides.");
    same(Object.fromEntries(m.parameterOverrides.map(({ name, value }) => [name, value])), plan.parameters, `${MANIFEST_PATH}.parameterOverrides`);
  }
  const summary = a["stage4-workflow-summary"];
  if (summary) {
    for (const [key, value] of Object.entries({ sourceArtifactSha256: m.dataset.sourceArtifactSha256, normalizedDatasetFingerprint: m.dataset.normalizedDatasetFingerprint, splitFingerprint: m.splitFingerprint, planFingerprint: m.plan.fingerprint })) {
      same(summary[key], value, `${ARTIFACT_PATH}.stage4-workflow-summary.${key}`);
    }
    if (plan) same(summary.seeds, plan.seeds, `${ARTIFACT_PATH}.stage4-workflow-summary.seeds`);
  }
  return { dataset, split, model, plan };
}

function validateReplayInput(input) {
  shape(input, ["schemaVersion", "kind", "implementationId", "versions", "options"], [], INPUT_PATH);
  schema(input.schemaVersion === "1.0.0" && input.kind === "ecolab-research-replay-input", INPUT_PATH);
  string(input.implementationId, `${INPUT_PATH}.implementationId`);
  shape(input.versions, Object.keys(VERSIONS), [], `${INPUT_PATH}.versions`); strings(input.versions, Object.keys(VERSIONS), `${INPUT_PATH}.versions`);
  const o = input.options; const p = `${INPUT_PATH}.options`;
  shape(o, OPTION_KEYS, [], p);
  strings(o, ["datasetInput", "datasetFormat", "applicationVersion", "runId", "datasetVersion", "contentHash", "packageId", "planId"], p);
  timestamp(o.createdAt, `${p}.createdAt`); digest(o.contentHash, `${p}.contentHash`);
  schema(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(o.datasetVersion), `${p}.datasetVersion`);
  schema(["json", "csv"].includes(o.datasetFormat), `${p}.datasetFormat`);
  for (const key of ["includeMonteCarloSamples", "developmentComparison"]) schema(typeof o[key] === "boolean", `${p}.${key}`);
  number(o.scalarOutputTimeHours, `${p}.scalarOutputTimeHours`);
  for (const key of ["seed", "sobolBootstrapSeed"]) number(o[key], `${p}.${key}`, 0, 0xffff_ffff, true);
  for (const key of ["resolvedModel", "computationSettings"]) object(o[key], `${p}.${key}`);
  shape(o.seeds, ["analysis", "optimizer", "monteCarlo", "morris", "sobol", "sobolBootstrap", "growthComparison"], [], `${p}.seeds`);
  for (const key of Object.keys(o.seeds)) number(o.seeds[key], `${p}.seeds.${key}`, 0, 0xffff_ffff, true);
  shape(o.optimizer, OPTIMIZER_KEYS, [], `${p}.optimizer`);
  for (const key of OPTIMIZER_KEYS) number(o.optimizer[key], `${p}.optimizer.${key}`, 1, Number.MAX_SAFE_INTEGER, true);
  // Require complete saved values, rather than silently filling workflow defaults.
  for (const key of OPTION_KEYS.filter((key) => /^(scanPoints|monteCarloSamples|morris|sobol|identifiabilityProfile|returnedMonteCarlo)/.test(key))) number(o[key], `${p}.${key}`);
  checked(() => researchWorkflowConfiguration(o), p, "RESEARCH_PACKAGE_SCHEMA");
  schema(o.sobolBootstrapReplicates !== 1, `${p}.sobolBootstrapReplicates`);
  number(o.sobolConfidenceLevel, `${p}.sobolConfidenceLevel`, Number.MIN_VALUE, 1 - Number.EPSILON);
  number(o.sobolPrecisionTolerance, `${p}.sobolPrecisionTolerance`, Number.MIN_VALUE);
  number(o.uncertaintyRangeFraction, `${p}.uncertaintyRangeFraction`, Number.MIN_VALUE, 0.5);
  const g = o.growthComparison; const gp = `${p}.growthComparison`;
  shape(g, ["bounds", "optimizer", "crossValidation", "bootstrap"], [], gp);
  const names = ["baselineOd", "amplitudeOd", "ratePerHour", "timingHours"];
  shape(g.bounds, names, [], `${gp}.bounds`);
  for (const key of names) {
    const pair = g.bounds[key]; const path = `${gp}.bounds.${key}`;
    array(pair, path); schema(pair.length === 2, path);
    pair.forEach((value) => number(value, path));
    schema(pair[0] < pair[1] && Number.isFinite(pair[1] - pair[0]) && (!["amplitudeOd", "ratePerHour"].includes(key) || pair[0] > 0), path);
  }
  number(g.bounds.baselineOd[1] + g.bounds.amplitudeOd[1], `${gp}.bounds`);
  shape(g.optimizer, [...OPTIMIZER_KEYS, "tolerance", "objectiveTolerance"], [], `${gp}.optimizer`);
  const limits = GROWTH_COMPARISON_LIMITS;
  number(g.optimizer.restarts, `${gp}.optimizer.restarts`, 1, limits.maximumRestarts, true);
  number(g.optimizer.populationSize, `${gp}.optimizer.populationSize`, 4, limits.maximumPopulationSize, true);
  for (const key of OPTIMIZER_KEYS.slice(2)) number(g.optimizer[key], `${gp}.optimizer.${key}`, 1, limits.maximumStageEvaluations, true);
  number(g.optimizer.tolerance, `${gp}.optimizer.tolerance`, Number.MIN_VALUE, 1); number(g.optimizer.objectiveTolerance, `${gp}.optimizer.objectiveTolerance`, 0);
  shape(g.crossValidation, ["folds", "tieTolerance"], [], `${gp}.crossValidation`);
  array(g.crossValidation.folds, `${gp}.crossValidation.folds`);
  for (const fold of g.crossValidation.folds) { array(fold, `${gp}.crossValidation.folds`); fold.forEach((id) => string(id, `${gp}.crossValidation.folds`)); }
  number(g.crossValidation.tieTolerance, `${gp}.crossValidation.tieTolerance`, 0);
  shape(g.bootstrap, ["samples", "intervalLevel"], [], `${gp}.bootstrap`);
  number(g.bootstrap.samples, `${gp}.bootstrap.samples`, 0, limits.maximumBootstrapSamples, true); number(g.bootstrap.intervalLevel, `${gp}.bootstrap.intervalLevel`, Number.MIN_VALUE, 1 - Number.EPSILON);
  const evaluations = g.optimizer.restarts * (g.optimizer.differentialEvolutionMaxEvaluations + g.optimizer.nelderMeadMaxEvaluations) * (2 * (g.crossValidation.folds.length + 1) + g.bootstrap.samples);
  if (evaluations > limits.maximumTotalEvaluations) fail("RESEARCH_PACKAGE_LIMIT", "Growth computation budget exceeds built-in limit.", gp);
}

function verifyReplayAssociations(pkg, input, snapshots) {
  const { dataset, split, model, plan } = snapshots;
  const m = pkg.contents.analysisManifest; const o = input.options; const p = `${INPUT_PATH}.options`;
  for (const key of Object.keys(VERSIONS)) same(input.versions[key], m.versions[key], `${INPUT_PATH}.versions.${key}`);
  same(input.implementationId, m.algorithm.name, `${INPUT_PATH}.implementationId`);
  same(o.applicationVersion, input.versions.application, `${p}.applicationVersion`);
  for (const [key, value] of Object.entries({ packageId: pkg.packageId, runId: m.runId, createdAt: m.createdAt, datasetVersion: m.dataset.version, planId: plan.id, seed: m.random.seed })) same(o[key], value, `${p}.${key}`);
  same(pkg.createdAt, o.createdAt, "$.createdAt");
  same(o.resolvedModel, model, `${p}.resolvedModel`);
  same(o.contentHash, sha256HexFallback(o.datasetInput), `${p}.contentHash`);
  same(o.contentHash, m.dataset.sourceArtifactSha256, `${MANIFEST_PATH}.dataset.sourceArtifactSha256`);
  const imported = checked(() => importObservationDataset(o.datasetInput, { format: o.datasetFormat }), `${p}.datasetInput`);
  same(imported.dataset, dataset, `${p}.datasetInput`);
  for (const key of Object.keys(plan.seeds)) same(o.seeds[key], plan.seeds[key], `${p}.seeds.${key}`);
  same(o.sobolBootstrapSeed, o.seeds.sobolBootstrap, `${p}.sobolBootstrapSeed`);
  same(m.algorithm.version, input.versions.analysis, `${MANIFEST_PATH}.algorithm.version`);
  same(m.algorithm.settings, {
    implementationId: input.implementationId, replayInputArtifactId: "research-replay-input", seeds: o.seeds,
    computationSettings: o.computationSettings, growthComparison: o.growthComparison,
    evaluationRole: "development_comparison", untouched: false, nuisanceProfilingRole: "training", developmentOptimization: false,
  }, `${MANIFEST_PATH}.algorithm.settings`);
  same(m.algorithm.stopping, {
    optimizer: o.optimizer, growthOptimizer: o.growthComparison.optimizer, growthBootstrapSamples: o.growthComparison.bootstrap.samples,
    monteCarloSamples: o.monteCarloSamples, sobolSamples: o.sobolSamples, sobolBootstrapReplicates: o.sobolBootstrapReplicates,
  }, `${MANIFEST_PATH}.algorithm.stopping`);
  const trainingIds = [...split.roles.training.independentUnitIds].sort();
  const folds = o.growthComparison.crossValidation.folds;
  integrity(trainingIds.length >= 2 && trainingIds.length <= GROWTH_COMPARISON_LIMITS.maximumTrainingTrajectories && dataset.observations.length <= GROWTH_COMPARISON_LIMITS.maximumObservations, `${p}.datasetInput`, "Dataset is outside built-in replay limits.");
  integrity(folds.length >= 2 && folds.length <= trainingIds.length && folds.every((fold) => fold.length > 0 && fold.length < trainingIds.length), `${p}.growthComparison.crossValidation.folds`);
  same(folds.flat().sort(), trainingIds, `${p}.growthComparison.crossValidation.folds`);
  const normalizedFolds = folds.map((fold) => [...fold].sort()).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  same(folds, normalizedFolds, `${p}.growthComparison.crossValidation.folds`);
}

function verifyBuiltInSettings(input, manifest) {
  const o = input.options; const p = `${INPUT_PATH}.options`;
  same(o.developmentComparison, true, `${p}.developmentComparison`); same(o.scalarOutputTimeHours, 10, `${p}.scalarOutputTimeHours`);
  same(o.createdAt, new Date(o.createdAt).toISOString(), `${p}.createdAt`);
  same(manifest.random.algorithm, RNG_ALGORITHM, `${MANIFEST_PATH}.random.algorithm`);
  same(o.seeds, {
    analysis: o.seed, optimizer: deriveSeed(o.seed, "optimizer"), monteCarlo: deriveSeed(o.seed, "monte-carlo"),
    morris: deriveSeed(o.seed, "morris"), sobol: deriveSeed(o.seed, "sobol"), sobolBootstrap: o.sobolBootstrapSeed,
    growthComparison: deriveSeed(o.seed, "growth-comparison"),
  }, `${p}.seeds`);
  const settings = checked(() => researchWorkflowComputationSettings(o), `${p}.computationSettings`);
  // These rules are pinned to RESEARCH_WORKFLOW_IMPLEMENTATION_ID. They describe
  // built-in code only; imported settings never choose code or dependency locations.
  settings.growthComparison = {
    implementationId: "direct-od-growth-comparison-v1", developmentRole: "validation",
    objective: "mean_trajectory_mse_od600", crossValidationMetric: "macroRmse", tieOrder: ["training_mean", "logistic", "gompertz"],
    optimizerConstants: { mutationFactor: 0.8, crossoverRate: 0.9, initialStep: 0.05 },
    quantileMethod: "R7", minimumExpectedTailSamples: 5, intervalRefits: "finite_converged_only",
    seedDerivation: "deriveSeed(root, direct-od-growth-comparison-v1, phase, model, index); restart and stage substreams",
    resamplingUnit: "whole_training_trajectory", independentParameterMarginalsForSensitivity: false,
  };
  same(o.computationSettings, settings, `${p}.computationSettings`);
  same(manifest.algorithm.bounds, settings.training.bounds, `${MANIFEST_PATH}.algorithm.bounds`);
}

/** Synchronous, offline inspection. Returns a deeply frozen defensive JSON clone.
 * Limits: 32 MiB UTF-8, 64 total artifacts, depth 64 and 1,000,000 JSON values.
 * Hashes establish internal consistency, not publisher authenticity or scientific validity.
 * Use JSON text across untrusted JS boundaries: portable reflection cannot detect
 * hostile Proxy traps without invoking them. Object input is for ordinary JSON data.
 */
export function inspectResearchPackage(input) {
  const pkg = readInput(input);
  validatePackage(pkg);
  verifyInventory(pkg);
  const snapshots = verifyAssociations(pkg);
  const m = pkg.contents.analysisManifest; const artifacts = pkg.contents.artifacts;
  const replayInput = artifacts["research-replay-input"];
  const isNew = Object.hasOwn(artifacts, "research-replay-input") || m.algorithm.name === RESEARCH_WORKFLOW_IMPLEMENTATION_ID || Object.hasOwn(m.algorithm.settings ?? {}, "replayInputArtifactId");
  if (isNew) {
    for (const id of REQUIRED_ARTIFACTS) integrity(Object.hasOwn(artifacts, id) && pkg.replay.artifactIds.includes(id), `${ARTIFACT_PATH}.${id}`, "Versioned replay requires this embedded and declared artifact.");
    object(artifacts["scientific-result"], `${ARTIFACT_PATH}.scientific-result`);
    validateReplayInput(replayInput);
    verifyReplayAssociations(pkg, replayInput, snapshots);
  }
  const reasons = [];
  const reason = (code, message) => reasons.push({ code, message });
  if (!isNew) reason("MISSING_REPLAY_INPUT", "Legacy package has no complete versioned replay input; inspection only.");
  if (Object.entries(VERSIONS).some(([key, value]) => m.versions[key] !== value) || m.versions.analysisEngineId !== ANALYSIS_ENGINE_ID) reason("UNSUPPORTED_SOFTWARE_VERSION", "Replay requires application 6.0.0, core 2.0.0 and the built-in analysis 2.0.0 implementation exactly.");
  if (isNew && replayInput.implementationId !== RESEARCH_WORKFLOW_IMPLEMENTATION_ID) reason("UNSUPPORTED_WORKFLOW_IMPLEMENTATION", "Only the built-in development v2 research workflow can execute.");
  if (Object.entries(MODEL).some(([key, value]) => m.model[key] !== value)) reason("UNSUPPORTED_MODEL_IMPLEMENTATION", "Model ID, version and implementation must exactly match the built-in model.");
  if (isNew && m.dataset.id !== "figshare-bw25113-growth-v1") reason("UNSUPPORTED_DATASET", "This built-in workflow supports only its declared BW25113 dataset.");
  const expectedDependencies = [
    { id: ANALYSIS_IMPLEMENTATION_ID, kind: "software_implementation", version: ANALYSIS_ENGINE_VERSION, requirement: "exact" },
    { id: MODEL.implementationId, kind: "model_implementation", version: MODEL.version, requirement: "exact" },
  ];
  if (pkg.replay.dependencies.length !== expectedDependencies.length || !expectedDependencies.every((expected) => pkg.replay.dependencies.some((dep) => Object.entries(expected).every(([key, value]) => dep[key] === value)))) reason("UNSUPPORTED_DEPENDENCIES", "Replay requires exactly the two declared built-in dependencies at exact versions; no dependency is loaded from a package.");
  if (isNew && !reasons.some(({ code }) => code !== "UNSUPPORTED_DEPENDENCIES")) verifyBuiltInSettings(replayInput, m);
  return freeze({ researchPackage: pkg, replayable: reasons.length === 0, status: reasons.length === 0 ? "replayable" : "inspect_only", reasons });
}

async function compareScientific(expected, actual, tolerances, runtime, manifests) {
  const comparison = { ...tolerances, mismatchCount: 0, mismatchPaths: [], truncated: false };
  let visited = 0;
  function mismatch(path) {
    comparison.mismatchCount += 1;
    if (comparison.mismatchPaths.length < MAX_MISMATCH_PATHS) comparison.mismatchPaths.push(path.length > MAX_PATH_LENGTH ? `${path.slice(0, MAX_PATH_LENGTH - 1)}…` : path);
    else comparison.truncated = true;
    if (path.length > MAX_PATH_LENGTH) comparison.truncated = true;
  }
  async function visit(left, right, path) {
    if (++visited % 2048 === 0) await runtime.checkpoint();
    if (typeof left === "number" && typeof right === "number") {
      const scale = Math.max(Math.abs(left), Math.abs(right));
      const difference = Math.abs(left - right);
      const { absoluteTolerance, relativeTolerance } = tolerances;
      // Scale the relative test to avoid overflow in either difference or tolerance.
      const close = left === right || difference <= absoluteTolerance || (scale > 0 && (Number.isFinite(difference) ? difference / scale : Math.abs(left / scale - right / scale)) <= absoluteTolerance / scale + relativeTolerance);
      if (!close) mismatch(path);
    } else if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
      if (left !== right) mismatch(path);
    } else if (Array.isArray(left) !== Array.isArray(right)) mismatch(path);
    else if (Array.isArray(left)) {
      if (left.length !== right.length) mismatch(`${path}.length`);
      for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        if (i >= left.length || i >= right.length) mismatch(`${path}[${i}]`);
        else await visit(left[i], right[i], `${path}[${i}]`);
      }
    } else {
      // Floating-point tail differences must not become exact-string failures.
      // Exempt only closed templates verified against each side's own fields;
      // the values and every other field still pass through the full comparator.
      const numericWarningText = hasCanonicalNumericWarningMessage(left) && hasCanonicalNumericWarningMessage(right);
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
        const childPath = /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
        if (!Object.hasOwn(left, key) || !Object.hasOwn(right, key)) mismatch(childPath);
        else if (key !== "message" || !numericWarningText) await visit(left[key], right[key], childPath);
      }
    }
  }
  await visit(expected, actual, "$");
  // A rehashed manifest can contradict an otherwise unchanged scientific result.
  // Compare the complete recomputed manifest, not a whitelist of reported metrics.
  await visit(manifests.expected, manifests.actual, "$.analysisManifest");
  return comparison;
}

/** Replay only the static, exact-version built-in workflow; never imports code or
 * fetches dependencies. Numeric leaves use |a-b| <= abs + rel*max(|a|,|b|);
 * all object keys, array order/length, types and nonnumeric leaves are exact,
 * except closed numeric warning templates verified against each side's own
 * structured fields; those fields still use the same full comparison.
 * The complete imported analysis manifest is also compared with the recomputed
 * manifest; integrity inspection alone does not establish scientific agreement.
 * mismatchCount is total; mismatchPaths retains at most 100 paths of 512 chars.
 * Cancellation is cooperative between synchronous inspection/numerical stages.
 */
export async function replayResearchPackage(input, { runtime, onProgress, absoluteTolerance = 1e-10, relativeTolerance = 1e-8 } = {}) {
  try {
    const hooks = researchWorkflowRuntime({ runtime: runtime ?? {}, onProgress });
    hooks.check();
    for (const [key, value] of Object.entries({ absoluteTolerance, relativeTolerance })) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail("RESEARCH_REPLAY_TOLERANCE", "Replay tolerances must be finite nonnegative numbers.", key);
    }
    await hooks.checkpoint();
    hooks.progress({ phase: "replay_inspect", completed: 0, total: 1 });
    const inspected = inspectResearchPackage(input);
    hooks.progress({ phase: "replay_inspect", completed: 1, total: 1 });
    await hooks.checkpoint();
    if (!inspected.replayable) fail("RESEARCH_PACKAGE_NOT_REPLAYABLE", inspected.reasons.map(({ message }) => message).join(" "), "$.replay");
    const artifacts = inspected.researchPackage.contents.artifacts;
    hooks.progress({ phase: "replay_execute", completed: 0, total: 1 });
    const result = await runEcolabResearchWorkflow({
      ...artifacts["research-replay-input"].options, runtime: runtime ?? {},
      onProgress: (event) => { if (event.phase !== "complete") hooks.progress(event); },
    });
    hooks.progress({ phase: "replay_execute", completed: 1, total: 1 });
    await hooks.checkpoint();
    hooks.progress({ phase: "replay_compare", completed: 0, total: 1 });
    const comparison = await compareScientific(artifacts["scientific-result"], scientificResearchProjection(result), { absoluteTolerance, relativeTolerance }, hooks, {
      expected: inspected.researchPackage.contents.analysisManifest, actual: result.manifest,
    });
    hooks.progress({ phase: "replay_compare", completed: 1, total: 1 });
    await hooks.checkpoint();
    hooks.progress({ phase: "complete", completed: 1, total: 1 });
    return freeze({ matched: comparison.mismatchCount === 0, comparison, result });
  } catch (error) {
    if (error.code === "ANALYSIS_CANCELLED" && !(error instanceof ResearchReplayError)) fail("ANALYSIS_CANCELLED", "Research replay cancelled.", "runtime");
    throw error;
  }
}
