import { validationError } from "../model/errors.js";
import {
  assertNonEmptyString,
  assertPlainObject,
  cloneJson,
  deepFreeze,
} from "../model/validate.js";
import { ENGINE_VERSION } from "../model/version.js";

function assertJsonValue(value, path = "value") {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw validationError(
        "NON_JSON_NUMBER",
        path,
        "finite JSON number",
        value,
        `${path} must be a finite JSON number.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}.${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) {
        throw validationError(
          "UNDEFINED_JSON_VALUE",
          `${path}.${key}`,
          "JSON-compatible value",
          child,
          `${path}.${key} cannot be undefined.`,
        );
      }
      assertJsonValue(child, `${path}.${key}`);
    }
    return;
  }
  throw validationError(
    "NON_JSON_VALUE",
    path,
    "JSON-compatible value",
    typeof value,
    `${path} must be JSON-compatible.`,
  );
}

export function canonicalizeJson(value) {
  assertJsonValue(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`)
    .join(",")}}`;
}

export function createRunManifest({
  runId,
  createdAt,
  applicationVersion,
  resolvedModel,
  request,
  result,
}) {
  assertNonEmptyString(runId, "runId");
  assertNonEmptyString(createdAt, "createdAt");
  assertNonEmptyString(applicationVersion, "applicationVersion");
  assertPlainObject(resolvedModel, "resolvedModel");
  assertPlainObject(request, "request");
  assertPlainObject(result, "result");
  if (Number.isNaN(Date.parse(createdAt))) {
    throw validationError(
      "INVALID_TIMESTAMP",
      "createdAt",
      "ISO 8601 timestamp",
      createdAt,
      "createdAt must be a valid timestamp.",
    );
  }

  const manifest = {
    schemaVersion: "1.0.0",
    kind: "ecolab.simulation-run",
    runId,
    createdAt,
    application: { version: applicationVersion },
    engine: {
      version: ENGINE_VERSION,
      implementationId: resolvedModel.ref.implementationId,
    },
    model: {
      id: resolvedModel.ref.id,
      version: resolvedModel.ref.version,
    },
    parameterSet: {
      id: resolvedModel.ref.parameterSetId,
      version: resolvedModel.ref.parameterSetVersion,
      evidenceLevel: resolvedModel.evidenceLevel,
      conditionMatch: resolvedModel.conditionMatch,
      capabilityLevel: resolvedModel.capabilityLevel,
      resolvedParameters: cloneJson(resolvedModel.parameters),
      sourceIds: [...resolvedModel.sourceIds],
    },
    request: cloneJson(request),
    randomness: { used: false, seed: null },
    warnings: cloneJson(resolvedModel.warnings),
    result: {
      model: cloneJson(result.model),
      trajectory: cloneJson(result.trajectory),
      diagnostics: cloneJson(result.diagnostics),
    },
  };
  assertJsonValue(manifest, "manifest");
  return deepFreeze(manifest);
}
