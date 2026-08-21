import { ENGINE_VERSION } from "../model.js";
import { canonicalJson, sha256HexFallback } from "./fingerprint.js";
import { RNG_ALGORITHM } from "./random.js";
import {
  ANALYSIS_ENGINE_ID,
  ANALYSIS_ENGINE_VERSION,
  ANALYSIS_IMPLEMENTATION_ID,
} from "./version.js";

const SCHEMA_VERSION = "1.0.0";
const MANIFEST_KIND = "ecolab.analysis-run";
const PACKAGE_KIND = "ecolab.research-package";
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class AnalysisManifestError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AnalysisManifestError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
    this.expected = details.expected;
  }
}

function fail(code, message, path = null, actual = undefined, expected = undefined) {
  throw new AnalysisManifestError(code, message, { path, actual, expected });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value, path) {
  if (!isRecord(value)) fail("INVALID_OBJECT", `${path} must be a plain object.`, path, value);
  return value;
}

function string(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_STRING", `${path} must be a non-empty string.`, path, value);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("NON_FINITE_NUMBER", `${path} must be a finite number.`, path, value);
  }
  return value;
}

function cloneJson(value, path = "$", stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, path);
  if (typeof value !== "object") fail("NON_JSON_VALUE", `${path} must be JSON-safe.`, path, typeof value);
  if (stack.has(value)) fail("CYCLIC_VALUE", `${path} cannot contain a cycle.`, path);
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("SPARSE_ARRAY", `${path} cannot be sparse.`, path);
      result.push(cloneJson(value[index], `${path}[${index}]`, stack));
    }
  } else {
    if (!isRecord(value)) fail("NON_JSON_VALUE", `${path} must contain only plain objects.`, path);
    result = {};
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) fail("UNSAFE_OBJECT_KEY", `Unsafe object key at ${path}.${key}.`, `${path}.${key}`);
      result[key] = cloneJson(child, `${path}.${key}`, stack);
    }
  }
  stack.delete(value);
  return result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function fingerprint(value, path) {
  string(value, path);
  if (!FINGERPRINT_PATTERN.test(value)) {
    fail("INVALID_FINGERPRINT", `${path} must be a lowercase SHA-256 hex digest.`, path, value);
  }
  return value;
}

function reference(value, path, options = {}) {
  record(value, path);
  const result = {
    id: string(value.id, `${path}.id`),
    version: string(value.version, `${path}.version`),
  };
  if (options.implementation === true) {
    result.implementationId = string(value.implementationId, `${path}.implementationId`);
  }
  return result;
}

function resolvedReferences(options) {
  const resolvedModel = options.resolvedModel;
  if (resolvedModel !== undefined) {
    record(resolvedModel, "resolvedModel");
    record(resolvedModel.ref, "resolvedModel.ref");
  }
  const modelSource = options.model ?? options.modelRef ?? (resolvedModel ? {
    id: resolvedModel.ref.id,
    version: resolvedModel.ref.version,
    implementationId: resolvedModel.ref.implementationId,
  } : undefined);
  const baseSource = options.baseParameterSet
    ?? options.baseParameterSetRef
    ?? options.baseParameterRef
    ?? (resolvedModel ? {
      id: resolvedModel.ref.parameterSetId,
      version: resolvedModel.ref.parameterSetVersion,
    } : undefined);
  return {
    model: reference(modelSource, "model", { implementation: true }),
    baseParameterSet: reference(baseSource, "baseParameterSet"),
    resolvedParameters: cloneJson(
      options.resolvedParameters ?? resolvedModel?.parameters,
      "resolvedParameters",
    ),
  };
}

function normalizeOrigin(origin, path) {
  if (typeof origin === "string") return string(origin, path);
  return cloneJson(record(origin, path), path);
}

function normalizeOverrides(options) {
  const source = options.parameterOverrides ?? options.overrides ?? {};
  const origins = options.overrideOrigins ?? options.parameterOverrideOrigins ?? {};
  record(origins, "overrideOrigins");
  const entries = [];
  if (Array.isArray(source)) {
    source.forEach((entry, index) => {
      record(entry, `parameterOverrides[${index}]`);
      const name = string(entry.name ?? entry.parameter, `parameterOverrides[${index}].name`);
      const value = finite(entry.value, `parameterOverrides[${index}].value`);
      const origin = normalizeOrigin(entry.origin ?? origins[name], `parameterOverrides[${index}].origin`);
      entries.push({ name, value, origin });
    });
  } else {
    record(source, "parameterOverrides");
    for (const [name, raw] of Object.entries(source)) {
      string(name, "parameterOverrides key");
      if (UNSAFE_KEYS.has(name)) fail("UNSAFE_OBJECT_KEY", `Unsafe parameter name: ${name}.`, `parameterOverrides.${name}`);
      const descriptor = isRecord(raw) && Object.hasOwn(raw, "value") ? raw : null;
      const value = finite(descriptor ? descriptor.value : raw, `parameterOverrides.${name}`);
      const origin = normalizeOrigin(descriptor?.origin ?? origins[name], `overrideOrigins.${name}`);
      entries.push({ name, value, origin });
    }
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  const names = entries.map(({ name }) => name);
  if (new Set(names).size !== names.length) {
    fail("DUPLICATE_PARAMETER_OVERRIDE", "Parameter override names must be unique.", "parameterOverrides");
  }
  return entries;
}

function normalizeDataset(options) {
  const dataset = options.dataset ?? {};
  record(dataset, "dataset");
  const metadata = dataset.metadata ?? {};
  record(metadata, "dataset.metadata");
  const normalizedDatasetFingerprint = fingerprint(
    options.normalizedDatasetFingerprint
      ?? options.datasetFingerprint
      ?? options.datasetHash
      ?? dataset.normalizedDatasetFingerprint
      ?? dataset.fingerprint
      ?? dataset.hash,
    "dataset.normalizedDatasetFingerprint",
  );
  const sourceArtifactSha256 = options.sourceArtifactSha256
    ?? options.sourceContentHash
    ?? dataset.sourceArtifactSha256
    ?? dataset.sourceContentHash;
  const result = {
    id: string(options.datasetId ?? dataset.id ?? metadata.datasetId, "dataset.id"),
    version: string(options.datasetVersion ?? dataset.version ?? metadata.version, "dataset.version"),
    normalizedDatasetFingerprint,
    fingerprint: normalizedDatasetFingerprint,
    hash: normalizedDatasetFingerprint,
    license: string(options.datasetLicense ?? dataset.license ?? metadata.license, "dataset.license"),
  };
  if (sourceArtifactSha256 !== undefined && sourceArtifactSha256 !== null) {
    result.sourceArtifactSha256 = fingerprint(sourceArtifactSha256, "dataset.sourceArtifactSha256");
  }
  return result;
}

function normalizeRandom(options, plan) {
  const source = options.random ?? options.randomness ?? {};
  record(source, "random");
  const algorithm = string(
    source.algorithm ?? options.randomAlgorithm ?? plan?.randomAlgorithm ?? RNG_ALGORITHM,
    "random.algorithm",
  );
  const seed = source.seed ?? options.seed ?? plan?.seeds?.analysis ?? plan?.seeds?.root;
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
    fail("INVALID_SEED", "random.seed must be an unsigned 32-bit integer.", "random.seed", seed);
  }
  return { algorithm, seed };
}

function normalizeAlgorithm(options) {
  const source = options.algorithm ?? {};
  record(source, "algorithm");
  const name = string(source.name ?? options.algorithmName, "algorithm.name");
  const bounds = cloneJson(source.bounds ?? options.bounds, "algorithm.bounds");
  const stopping = cloneJson(source.stopping ?? options.stopping, "algorithm.stopping");
  record(bounds, "algorithm.bounds");
  record(stopping, "algorithm.stopping");
  const result = { name, bounds, stopping };
  if (source.version !== undefined) result.version = string(source.version, "algorithm.version");
  if (source.settings !== undefined || options.algorithmSettings !== undefined) {
    result.settings = cloneJson(source.settings ?? options.algorithmSettings, "algorithm.settings");
    record(result.settings, "algorithm.settings");
  }
  return result;
}

function normalizeFailures(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_FAILURES", "failures must be an array.", "failures", value);
  return cloneJson(value, "failures");
}

function normalizeConvergence(value) {
  if (typeof value === "boolean") return { converged: value };
  const result = cloneJson(record(value, "convergence"), "convergence");
  if (typeof result.converged !== "boolean") {
    fail("CONVERGENCE_STATUS_REQUIRED", "convergence.converged must be boolean.", "convergence.converged");
  }
  return result;
}

function normalizeWarnings(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail("INVALID_WARNINGS", "warnings must be an array.", "warnings", value);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) fail("SPARSE_ARRAY", "warnings cannot be sparse.", "warnings");
    const warning = value[index];
    record(warning, `warnings[${index}]`);
    const normalized = cloneJson(warning, `warnings[${index}]`);
    normalized.code = string(normalized.code, `warnings[${index}].code`);
    normalized.severity = string(normalized.severity ?? "warning", `warnings[${index}].severity`);
    normalized.message = string(normalized.message, `warnings[${index}].message`);
    result.push(normalized);
  }
  return result;
}

function diagnostic(value, path) {
  if (value === undefined) return null;
  return cloneJson(value, path);
}

/** Create an immutable, JSON-safe analysis-run manifest. */
export function createAnalysisManifest(options) {
  record(options, "options");
  const plan = options.plan;
  if (plan !== undefined) record(plan, "plan");
  const references = resolvedReferences(options);
  const runId = string(options.runId ?? options.analysisRunId, "runId");
  const createdAt = string(options.createdAt, "createdAt");
  if (Number.isNaN(Date.parse(createdAt))) {
    fail("INVALID_TIMESTAMP", "createdAt must be a valid ISO 8601 timestamp.", "createdAt", createdAt);
  }
  const applicationVersion = string(options.applicationVersion ?? options.appVersion, "application.version");
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    kind: MANIFEST_KIND,
    runId,
    createdAt,
    versions: {
      application: applicationVersion,
      core: string(options.coreVersion ?? ENGINE_VERSION, "versions.core"),
      analysis: ANALYSIS_ENGINE_VERSION,
      analysisEngineId: ANALYSIS_ENGINE_ID,
      analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID,
    },
    model: references.model,
    baseParameterSet: {
      ...references.baseParameterSet,
      resolvedParameters: references.resolvedParameters,
    },
    parameterOverrides: normalizeOverrides(options),
    dataset: normalizeDataset(options),
    splitFingerprint: fingerprint(
      options.splitFingerprint ?? options.split?.splitFingerprint ?? plan?.splitFingerprint,
      "splitFingerprint",
    ),
    plan: {
      id: string(options.planId ?? plan?.id ?? plan?.planId, "plan.id"),
      analysisKind: string(options.analysisKind ?? plan?.analysisKind, "plan.analysisKind"),
      fingerprint: fingerprint(options.planFingerprint ?? plan?.planFingerprint, "plan.fingerprint"),
    },
    random: normalizeRandom(options, plan),
    algorithm: normalizeAlgorithm(options),
    failures: normalizeFailures(options.failures),
    convergence: normalizeConvergence(options.convergence ?? options.converged),
    diagnostics: {
      residuals: diagnostic(options.residuals, "diagnostics.residuals"),
      identifiability: diagnostic(options.identifiability, "diagnostics.identifiability"),
      metrics: diagnostic(options.metrics, "diagnostics.metrics"),
    },
    capabilityAssessment: diagnostic(
      options.capabilityAssessment ?? options.capability,
      "capabilityAssessment",
    ),
    warnings: normalizeWarnings(options.warnings),
  };
  return freeze(cloneJson(manifest, "manifest"));
}

function validateManifest(manifest) {
  record(manifest, "manifest");
  if (manifest.schemaVersion !== SCHEMA_VERSION || manifest.kind !== MANIFEST_KIND) {
    fail("INVALID_ANALYSIS_MANIFEST", `manifest must be a ${MANIFEST_KIND} ${SCHEMA_VERSION} object.`, "manifest.kind");
  }
  return cloneJson(manifest, "manifest");
}

function markdownText(value) {
  return String(value).replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

function compactJson(value) {
  return canonicalJson(value);
}

/** Generate deterministic methods-summary Markdown from an analysis manifest. */
export function generateMethodsSummaryMarkdown(manifest) {
  const value = validateManifest(manifest);
  const lines = [
    "# Analysis methods summary",
    "",
    `Analysis run \`${markdownText(value.runId)}\` was created at ${markdownText(value.createdAt)}.`,
    "",
    "## Software",
    "",
    "| Component | Version or identifier |",
    "| --- | --- |",
    `| Application | ${markdownText(value.versions.application)} |`,
    `| Scientific core | ${markdownText(value.versions.core)} |`,
    `| Analysis engine | ${markdownText(value.versions.analysis)} (\`${markdownText(value.versions.analysisImplementationId)}\`) |`,
    "",
    "## Model and data",
    "",
    `- Model: \`${markdownText(value.model.id)}@${markdownText(value.model.version)}\` (\`${markdownText(value.model.implementationId)}\`).`,
    `- Base parameter set: \`${markdownText(value.baseParameterSet.id)}@${markdownText(value.baseParameterSet.version)}\`.`,
    `- Dataset: \`${markdownText(value.dataset.id)}@${markdownText(value.dataset.version)}\`, license ${markdownText(value.dataset.license)}.`,
    `- Normalized canonical dataset fingerprint (SHA-256 of canonical JSON): \`${markdownText(value.dataset.normalizedDatasetFingerprint ?? value.dataset.fingerprint)}\`.`,
    ...(value.dataset.sourceArtifactSha256
      ? [`- Source artifact SHA-256 (source bytes): \`${markdownText(value.dataset.sourceArtifactSha256)}\`.`]
      : ["- Source artifact SHA-256: not supplied; the normalized canonical dataset fingerprint is not a source-file byte hash."]),
    `- Split SHA-256: \`${markdownText(value.splitFingerprint)}\`.`, 
    `- Locked plan SHA-256: \`${markdownText(value.plan.fingerprint)}\`.`,
    "",
    "## Analysis procedure",
    "",
    `- Analysis kind: \`${markdownText(value.plan.analysisKind)}\`.`,
    `- Algorithm: \`${markdownText(value.algorithm.name)}\`${value.algorithm.version ? ` version ${markdownText(value.algorithm.version)}` : ""}.`,
    `- Random generator: \`${markdownText(value.random.algorithm)}\`; seed \`${value.random.seed}\`.`,
    `- Bounds: \`${markdownText(compactJson(value.algorithm.bounds))}\`.`,
    `- Stopping rules: \`${markdownText(compactJson(value.algorithm.stopping))}\`.`,
  ];
  if (value.parameterOverrides.length === 0) {
    lines.push("- Parameter overrides: none; the base parameter set was used unchanged.");
  } else {
    lines.push("", "### Parameter overrides", "", "| Parameter | Value | Origin |", "| --- | ---: | --- |");
    for (const override of value.parameterOverrides) {
      const origin = typeof override.origin === "string" ? override.origin : compactJson(override.origin);
      lines.push(`| \`${markdownText(override.name)}\` | ${override.value} | ${markdownText(origin)} |`);
    }
  }
  lines.push(
    "",
    "## Outcomes and diagnostics",
    "",
    `- Converged: ${value.convergence.converged ? "yes" : "no"}.`,
    `- Recorded failures: ${value.failures.length}.`,
    `- Residual diagnostics: ${value.diagnostics.residuals === null ? "not supplied" : `\`${markdownText(compactJson(value.diagnostics.residuals))}\``}.`,
    `- Identifiability diagnostics: ${value.diagnostics.identifiability === null ? "not supplied" : `\`${markdownText(compactJson(value.diagnostics.identifiability))}\``}.`,
    `- Metrics: ${value.diagnostics.metrics === null ? "not supplied" : `\`${markdownText(compactJson(value.diagnostics.metrics))}\``}.`,
    `- Capability assessment: ${value.capabilityAssessment === null ? "not supplied" : `\`${markdownText(compactJson(value.capabilityAssessment))}\``}.`,
    `- Warnings: ${value.warnings.length}.`,
    "",
    "### Retained warnings",
    "",
  );
  if (value.warnings.length === 0) {
    lines.push("No warnings were recorded.", "");
  } else {
    lines.push("Warnings are retained verbatim in the manifest, including workflow limitations such as Monte Carlo intervals not being confidence intervals and OD600 not being CFU when those warnings are present.", "");
    for (const warning of value.warnings) {
      lines.push(
        `- \`${markdownText(warning.code)}\` [${markdownText(warning.severity)}]: ${markdownText(warning.message)}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function artifactContent(entry, index) {
  if (!Object.hasOwn(entry, "content")) return null;
  const content = entry.content;
  if (typeof content === "string") return { content, serialized: content };
  const cloned = cloneJson(content, `artifacts[${index}].content`);
  return { content: cloned, serialized: canonicalJson(cloned) };
}

function normalizeAdditionalArtifacts(value) {
  if (value === undefined) return { inventory: [], contents: {} };
  if (!Array.isArray(value)) fail("INVALID_ARTIFACTS", "artifacts must be an array.", "artifacts", value);
  const inventory = [];
  const contents = {};
  value.forEach((artifact, index) => {
    record(artifact, `artifacts[${index}]`);
    const artifactId = string(artifact.artifactId ?? artifact.id, `artifacts[${index}].artifactId`);
    if (Object.hasOwn(contents, artifactId)) {
      fail("DUPLICATE_ARTIFACT_ID", `Duplicate artifactId: ${artifactId}.`, `artifacts[${index}].artifactId`);
    }
    const content = artifactContent(artifact, index);
    const sha256 = content
      ? sha256HexFallback(content.serialized)
      : fingerprint(artifact.sha256 ?? artifact.hash, `artifacts[${index}].sha256`);
    const byteLength = content
      ? utf8ByteLength(content.serialized)
      : artifact.byteLength ?? artifact.sizeBytes;
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
      fail("INVALID_ARTIFACT_SIZE", `artifacts[${index}].byteLength must be a non-negative safe integer.`, `artifacts[${index}].byteLength`, byteLength);
    }
    inventory.push({
      artifactId,
      role: string(artifact.role, `artifacts[${index}].role`),
      path: string(artifact.path ?? artifact.fileName, `artifacts[${index}].path`),
      mediaType: string(artifact.mediaType, `artifacts[${index}].mediaType`),
      sha256,
      byteLength,
      ...(artifact.description !== undefined
        ? { description: string(artifact.description, `artifacts[${index}].description`) }
        : {}),
    });
    if (content) contents[artifactId] = content.content;
  });
  return { inventory, contents };
}

function normalizeReplay(options, additional) {
  const source = options.replay ?? {};
  record(source, "replay");
  const selfContained = source.selfContained ?? options.selfContained ?? false;
  if (typeof selfContained !== "boolean") {
    fail("INVALID_REPLAY_STATUS", "replay.selfContained must be boolean.", "replay.selfContained", selfContained);
  }
  const dependencySource = source.dependencies ?? options.dependencies ?? [];
  if (!Array.isArray(dependencySource)) {
    fail("INVALID_REPLAY_DEPENDENCIES", "replay.dependencies must be an array.", "replay.dependencies", dependencySource);
  }
  const dependencies = dependencySource.map((dependency, index) => {
    record(dependency, `replay.dependencies[${index}]`);
    return {
      id: string(dependency.id, `replay.dependencies[${index}].id`),
      kind: string(dependency.kind, `replay.dependencies[${index}].kind`),
      requirement: string(dependency.requirement, `replay.dependencies[${index}].requirement`),
      ...(dependency.version !== undefined
        ? { version: string(dependency.version, `replay.dependencies[${index}].version`) }
        : {}),
      ...(dependency.description !== undefined
        ? { description: string(dependency.description, `replay.dependencies[${index}].description`) }
        : {}),
    };
  });
  if (selfContained && dependencies.length > 0) {
    fail(
      "CONFLICTING_REPLAY_STATUS",
      "A self-contained replay declaration cannot list external dependencies.",
      "replay",
    );
  }
  const artifactIds = source.artifactIds ?? options.replayArtifactIds ?? Object.keys(additional.contents);
  if (!Array.isArray(artifactIds) || artifactIds.some((id) => typeof id !== "string" || id.trim() === "")) {
    fail("INVALID_REPLAY_ARTIFACTS", "replay.artifactIds must be an array of artifact IDs.", "replay.artifactIds", artifactIds);
  }
  const available = new Set(Object.keys(additional.contents));
  for (const artifactId of artifactIds) {
    if (!available.has(artifactId)) {
      fail("REPLAY_ARTIFACT_NOT_EMBEDDED", `${artifactId} is not embedded in package contents.`, "replay.artifactIds", artifactId);
    }
  }
  const status = selfContained
    ? "self_contained"
    : dependencies.length > 0
      ? "requires_declared_dependencies"
      : "replay_requirements_incomplete";
  const defaultStatement = status === "self_contained"
    ? "All declared replay inputs and implementations are embedded in this package."
    : status === "requires_declared_dependencies"
      ? "Embedded replay artifacts are supplemented by the explicitly declared external dependencies."
      : "This package does not claim to be self-contained; replay dependencies have not been fully declared.";
  return {
    status,
    selfContained,
    statement: string(source.statement ?? options.replayStatement ?? defaultStatement, "replay.statement"),
    artifactIds: [...new Set(artifactIds)],
    dependencies,
  };
}

/** Build a research-package object with verified artifacts and explicit replay requirements. */
export function buildResearchPackage(options) {
  record(options, "options");
  const manifest = validateManifest(options.manifest ?? options.analysisManifest);
  const methodsSummaryMarkdown = options.methodsSummaryMarkdown === undefined
    ? generateMethodsSummaryMarkdown(manifest)
    : string(options.methodsSummaryMarkdown, "methodsSummaryMarkdown");
  const manifestText = canonicalJson(manifest);
  const additional = normalizeAdditionalArtifacts(options.artifacts);
  const replay = normalizeReplay(options, additional);
  const artifactInventory = [
    {
      artifactId: "analysis-manifest",
      role: "analysis_manifest",
      path: "analysis-manifest.json",
      mediaType: "application/json",
      sha256: sha256HexFallback(manifestText),
      byteLength: utf8ByteLength(manifestText),
    },
    {
      artifactId: "methods-summary",
      role: "methods_summary",
      path: "methods-summary.md",
      mediaType: "text/markdown",
      sha256: sha256HexFallback(methodsSummaryMarkdown),
      byteLength: utf8ByteLength(methodsSummaryMarkdown),
    },
    ...additional.inventory,
  ];
  const ids = artifactInventory.map(({ artifactId }) => artifactId);
  if (new Set(ids).size !== ids.length) {
    fail("DUPLICATE_ARTIFACT_ID", "Artifact IDs must be unique, including reserved package artifacts.", "artifactInventory");
  }
  const paths = artifactInventory.map(({ path }) => path);
  if (new Set(paths).size !== paths.length) {
    fail("DUPLICATE_ARTIFACT_PATH", "Artifact paths must be unique.", "artifactInventory");
  }
  const researchPackage = {
    schemaVersion: SCHEMA_VERSION,
    kind: PACKAGE_KIND,
    packageId: string(options.packageId ?? `${manifest.runId}-research-package`, "packageId"),
    createdAt: string(options.createdAt ?? manifest.createdAt, "createdAt"),
    analysisRunId: manifest.runId,
    replay,
    artifactInventory,
    contents: {
      analysisManifest: manifest,
      methodsSummaryMarkdown,
      artifacts: additional.contents,
    },
  };
  if (Number.isNaN(Date.parse(researchPackage.createdAt))) {
    fail("INVALID_TIMESTAMP", "Research-package createdAt must be a valid timestamp.", "createdAt", researchPackage.createdAt);
  }
  return freeze(cloneJson(researchPackage, "researchPackage"));
}

export const ANALYSIS_MANIFEST_SCHEMA_VERSION = SCHEMA_VERSION;
export const ANALYSIS_MANIFEST_KIND = MANIFEST_KIND;
export const RESEARCH_PACKAGE_KIND = PACKAGE_KIND;
export const createAnalysisRunManifest = createAnalysisManifest;
export const methodsSummaryMarkdown = generateMethodsSummaryMarkdown;
export const createMethodsSummaryMarkdown = generateMethodsSummaryMarkdown;
export const createResearchPackage = buildResearchPackage;
