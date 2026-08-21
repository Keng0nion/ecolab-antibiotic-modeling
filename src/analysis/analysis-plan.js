import { fingerprintJson } from "./fingerprint.js";
import { validateParameterSpace } from "./parameter-space.js";
import { RNG_ALGORITHM } from "./random.js";

const SCHEMA_VERSION = "1.0.0";
const PLAN_KIND = "analysis-plan";
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const PLAN_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "planId",
  "analysisKind",
  "datasetFingerprint",
  "splitFingerprint",
  "modelRef",
  "baseParameterSetRef",
  "baseParameterRef",
  "parameterSpace",
  "randomAlgorithm",
  "seeds",
  "lockedValidation",
  "locked",
  "parameters",
  "lockedParameters",
  "errorModel",
  "exclusions",
  "metrics",
  "validationIndependentUnitIds",
  "baseline",
  "notes",
  "planFingerprint",
]);

export class AnalysisPlanError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AnalysisPlanError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
    this.expected = details.expected;
  }
}

function fail(code, message, path = null, actual = undefined, expected = undefined) {
  throw new AnalysisPlanError(code, message, { path, actual, expected });
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

function reference(value, path) {
  record(value, path);
  const id = string(value.id, `${path}.id`);
  const version = string(value.version, `${path}.version`);
  if (!SEMVER_PATTERN.test(version)) {
    fail("INVALID_REFERENCE_VERSION", `${path}.version must be semantic version text.`, `${path}.version`, version);
  }
  return { id, version };
}

function normalizeSpace(value) {
  const space = validateParameterSpace(value);
  return {
    parameters: space.parameters.map(({ name, lower, upper, rationale, transform }) => ({
      name,
      lower,
      upper,
      rationale,
      transform,
    })),
    initialStateSeriesIds: [...space.initialStateSeriesIds],
    ...(space.drugIds ? { drugIds: [...space.drugIds] } : {}),
  };
}

function normalizeSeeds(value) {
  record(value, "plan.seeds");
  const entries = Object.entries(value);
  if (entries.length === 0) fail("EMPTY_SEEDS", "plan.seeds must declare at least one named seed.", "plan.seeds");
  const result = {};
  for (const [name, seed] of entries) {
    string(name, "plan.seeds key");
    if (UNSAFE_KEYS.has(name)) fail("UNSAFE_OBJECT_KEY", `Unsafe seed name: ${name}.`, `plan.seeds.${name}`);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      fail("INVALID_SEED", `plan.seeds.${name} must be an unsigned 32-bit integer.`, `plan.seeds.${name}`, seed);
    }
    result[name] = seed;
  }
  return result;
}

function normalizeLockedParameters(value, space) {
  record(value, "plan.parameters");
  const names = new Set(space.parameters.map(({ name }) => name));
  const entries = Object.entries(value);
  if (entries.length === 0) {
    fail("EMPTY_LOCKED_PARAMETERS", "plan.parameters must contain fixed values for the declared parameter space.", "plan.parameters");
  }
  const result = {};
  for (const [name, parameterValue] of entries) {
    if (!names.has(name)) {
      fail("PARAMETER_NOT_IN_SPACE", `plan.parameters.${name} is not declared in parameterSpace.`, `plan.parameters.${name}`);
    }
    result[name] = finite(parameterValue, `plan.parameters.${name}`);
  }
  for (const definition of space.parameters) {
    if (!Object.hasOwn(result, definition.name)) {
      fail("LOCKED_PARAMETER_REQUIRED", `plan.parameters.${definition.name} is required.`, `plan.parameters.${definition.name}`);
    }
    if (result[definition.name] < definition.lower || result[definition.name] > definition.upper) {
      fail(
        "LOCKED_PARAMETER_OUT_OF_BOUNDS",
        `plan.parameters.${definition.name} is outside its declared bounds.`,
        `plan.parameters.${definition.name}`,
        result[definition.name],
      );
    }
  }
  return result;
}

function normalizeErrorModel(value) {
  record(value, "plan.errorModel");
  const result = cloneJson(value, "plan.errorModel");
  const kind = string(result.kind ?? result.type, "plan.errorModel.kind");
  delete result.type;
  return { ...result, kind };
}

function exclusionId(value, index) {
  if (typeof value === "string") return string(value, `plan.exclusions[${index}]`);
  record(value, `plan.exclusions[${index}]`);
  return string(value.observationId ?? value.id, `plan.exclusions[${index}].observationId`);
}

function normalizeExclusions(value) {
  if (!Array.isArray(value)) fail("INVALID_EXCLUSIONS", "plan.exclusions must be an array.", "plan.exclusions", value);
  const seen = new Set();
  return value.map((exclusion, index) => {
    const id = exclusionId(exclusion, index);
    if (seen.has(id)) fail("DUPLICATE_EXCLUSION", `Duplicate exclusion: ${id}.`, `plan.exclusions[${index}]`);
    seen.add(id);
    if (typeof exclusion === "string") return id;
    const normalized = cloneJson(exclusion, `plan.exclusions[${index}]`);
    delete normalized.id;
    return { ...normalized, observationId: id };
  });
}

function normalizeMetrics(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("METRICS_REQUIRED", "plan.metrics must be a non-empty array.", "plan.metrics", value);
  }
  const result = value.map((metric, index) => string(metric, `plan.metrics[${index}]`));
  if (new Set(result).size !== result.length) fail("DUPLICATE_METRIC", "plan.metrics must be unique.", "plan.metrics");
  return result;
}

function normalizeUnitIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(
      "VALIDATION_UNITS_REQUIRED",
      "plan.validationIndependentUnitIds must be a non-empty array.",
      "plan.validationIndependentUnitIds",
      value,
    );
  }
  const result = value.map((id, index) => string(id, `plan.validationIndependentUnitIds[${index}]`));
  if (new Set(result).size !== result.length) {
    fail("DUPLICATE_VALIDATION_UNIT", "Validation independent-unit IDs must be unique.", "plan.validationIndependentUnitIds");
  }
  return result;
}

function normalizePlan(input, options = {}) {
  record(input, "plan");
  for (const key of Object.keys(input)) {
    if (!PLAN_KEYS.has(key)) fail("UNKNOWN_PLAN_FIELD", `Unknown analysis-plan field: ${key}.`, `plan.${key}`);
  }
  input = cloneJson(input, "plan");
  if (input.schemaVersion !== SCHEMA_VERSION) {
    fail("UNSUPPORTED_SCHEMA_VERSION", `plan.schemaVersion must be ${SCHEMA_VERSION}.`, "plan.schemaVersion", input.schemaVersion);
  }
  if (input.kind !== PLAN_KIND) {
    fail("INVALID_PLAN_KIND", `plan.kind must be ${PLAN_KIND}.`, "plan.kind", input.kind);
  }
  const id = string(input.id ?? input.planId, "plan.id");
  const analysisKind = string(input.analysisKind, "plan.analysisKind");
  const datasetFingerprint = fingerprint(input.datasetFingerprint, "plan.datasetFingerprint");
  const splitFingerprint = fingerprint(input.splitFingerprint, "plan.splitFingerprint");
  const modelRef = reference(input.modelRef, "plan.modelRef");
  const baseParameterSetRef = reference(
    input.baseParameterSetRef ?? input.baseParameterRef,
    "plan.baseParameterSetRef",
  );
  const parameterSpace = normalizeSpace(input.parameterSpace);
  const randomAlgorithm = string(input.randomAlgorithm ?? RNG_ALGORITHM, "plan.randomAlgorithm");
  const seeds = normalizeSeeds(input.seeds);
  const parameters = normalizeLockedParameters(input.parameters ?? input.lockedParameters, parameterSpace);
  const errorModel = normalizeErrorModel(input.errorModel);
  const exclusions = normalizeExclusions(input.exclusions);
  const metrics = normalizeMetrics(input.metrics);
  const validationIndependentUnitIds = normalizeUnitIds(input.validationIndependentUnitIds);
  if (
    input.lockedValidation !== undefined &&
    input.locked !== undefined &&
    input.lockedValidation !== input.locked
  ) {
    fail(
      "CONFLICTING_LOCK_SETTINGS",
      "plan.lockedValidation and plan.locked must agree when both are supplied.",
      "plan.lockedValidation",
    );
  }
  const declaredLock = input.lockedValidation ?? input.locked;
  if (typeof declaredLock !== "boolean") {
    fail(
      "LOCKED_VALIDATION_SETTING_REQUIRED",
      "plan.lockedValidation must explicitly declare a boolean lock setting.",
      "plan.lockedValidation",
      declaredLock,
    );
  }
  const lockedValidation = options.forceLocked === true ? true : declaredLock;
  if (options.requireLocked === true && !lockedValidation) {
    fail("PLAN_NOT_LOCKED", "The analysis plan must be locked.", "plan.lockedValidation", input.lockedValidation);
  }
  const normalized = {
    schemaVersion: SCHEMA_VERSION,
    kind: PLAN_KIND,
    id,
    analysisKind,
    datasetFingerprint,
    splitFingerprint,
    modelRef,
    baseParameterSetRef,
    parameterSpace,
    randomAlgorithm,
    seeds,
    lockedValidation,
    parameters,
    errorModel,
    exclusions,
    metrics,
    validationIndependentUnitIds,
  };
  if (input.baseline !== undefined) normalized.baseline = cloneJson(input.baseline, "plan.baseline");
  if (input.notes !== undefined) normalized.notes = cloneJson(input.notes, "plan.notes");
  if (input.planFingerprint !== undefined) {
    normalized.planFingerprint = fingerprint(input.planFingerprint, "plan.planFingerprint");
  }
  return normalized;
}

/** Validate, clone, and deeply freeze a versioned Stage 4 analysis plan. */
export function validateAnalysisPlan(plan, options = {}) {
  return freeze(normalizePlan(plan, options));
}

function fingerprintablePlan(plan) {
  const value = { ...plan };
  delete value.planFingerprint;
  return value;
}

/** Return the canonical SHA-256 fingerprint of a validated plan. */
export async function fingerprintAnalysisPlan(plan, options = {}) {
  const normalized = validateAnalysisPlan(plan, {
    requireLocked: options.requireLocked === true,
    forceLocked: options.forceLocked === true,
  });
  return fingerprintJson(fingerprintablePlan(normalized), options.fingerprintOptions);
}

/**
 * Canonicalize, lock, fingerprint, and deeply freeze a plan without mutating the
 * caller's object. The resulting validation settings cannot be changed in place.
 */
export async function lockAnalysisPlan(plan, options = {}) {
  const normalized = normalizePlan(plan, { forceLocked: true });
  delete normalized.planFingerprint;
  const planFingerprint = await fingerprintJson(normalized, options.fingerprintOptions);
  return freeze({ ...normalized, planFingerprint });
}

/** Validate a locked plan and verify that its recorded fingerprint is intact. */
export async function validateLockedAnalysisPlan(plan, options = {}) {
  const normalized = validateAnalysisPlan(plan, { requireLocked: true });
  if (!normalized.planFingerprint) {
    fail("PLAN_FINGERPRINT_REQUIRED", "A locked analysis plan must contain planFingerprint.", "plan.planFingerprint");
  }
  const actual = await fingerprintJson(fingerprintablePlan(normalized), options.fingerprintOptions);
  if (actual !== normalized.planFingerprint) {
    fail(
      "PLAN_FINGERPRINT_MISMATCH",
      "The locked analysis plan no longer matches its recorded fingerprint.",
      "plan.planFingerprint",
      normalized.planFingerprint,
      actual,
    );
  }
  return normalized;
}

export const ANALYSIS_PLAN_SCHEMA_VERSION = SCHEMA_VERSION;
export const ANALYSIS_PLAN_KIND = PLAN_KIND;
export const normalizeAnalysisPlan = validateAnalysisPlan;
export const createAnalysisPlanFingerprint = fingerprintAnalysisPlan;
export const createLockedAnalysisPlan = lockAnalysisPlan;
export const fingerprintAndLockAnalysisPlan = lockAnalysisPlan;
export const lockAndFingerprintAnalysisPlan = lockAnalysisPlan;
