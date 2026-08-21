const GLOBAL_PARAMETERS = new Set([
  "psiMaxLog10PerHour",
  "carryingCapacityLog10CfuPerMl",
]);
const DRUG_FIELDS = new Set([
  "zMicMgPerL",
  "hillKappa",
  "psiMinLog10PerHour",
]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const PARAMETER_WHITELIST = Object.freeze([
  "psiMaxLog10PerHour",
  "carryingCapacityLog10CfuPerMl",
  "drugs.<drugId>.zMicMgPerL",
  "drugs.<drugId>.hillKappa",
  "drugs.<drugId>.psiMinLog10PerHour",
  "initialStates.<seriesId>.log10PopulationDensity",
]);

function fail(code, message, path = null, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  error.path = path;
  throw error;
}

function plainObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("INVALID_PARAMETER_SPACE", `${path} must be a plain object.`, path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_STRING", `${path} must be a non-empty string.`, path);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_PARAMETER_VALUE", `${path} must be a finite number.`, path);
  }
  return value;
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) fail("UNSAFE_OBJECT_KEY", `Unsafe object key: ${key}.`, key);
      result[key] = clone(child);
    }
    return result;
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function normalizeInitialStateDeclarations(input) {
  if (input === undefined) return new Set();
  const identifiers = Array.isArray(input) ? input : Object.keys(plainObject(input, "initialStates"));
  const result = new Set();
  identifiers.forEach((identifier, index) => {
    nonEmptyString(identifier, `initialStates[${index}]`);
    if (UNSAFE_KEYS.has(identifier)) {
      fail("UNSAFE_OBJECT_KEY", `Unsafe initial-state series ID: ${identifier}.`, `initialStates.${identifier}`);
    }
    if (result.has(identifier)) {
      fail("DUPLICATE_INITIAL_STATE", `Duplicate initial-state series ID: ${identifier}.`);
    }
    result.add(identifier);
  });
  return result;
}

/** Parse and validate one exact whitelisted parameter name. */
export function parseParameterName(name, options = {}) {
  nonEmptyString(name, "parameterName");
  if (GLOBAL_PARAMETERS.has(name)) {
    return Object.freeze({ name, kind: "model", path: Object.freeze(["parameters", name]) });
  }

  const drugMatch = /^drugs\.([^.]+)\.(zMicMgPerL|hillKappa|psiMinLog10PerHour)$/.exec(name);
  if (drugMatch) {
    const drugId = drugMatch[1];
    if (UNSAFE_KEYS.has(drugId)) fail("UNSAFE_OBJECT_KEY", `Unsafe drug ID: ${drugId}.`, name);
    const declared = options.drugIds;
    if (declared !== undefined) {
      const allowed = new Set(declared);
      if (!allowed.has(drugId)) fail("UNKNOWN_DRUG_PARAMETER", `Unknown drug parameter: ${name}.`, name);
    }
    return Object.freeze({
      name,
      kind: "drug",
      drugId,
      field: drugMatch[2],
      path: Object.freeze(["parameters", "drugs", drugId, drugMatch[2]]),
    });
  }

  const initialMatch = /^initialStates\.([^.]+)\.log10PopulationDensity$/.exec(name);
  if (initialMatch) {
    const seriesId = initialMatch[1];
    if (UNSAFE_KEYS.has(seriesId)) fail("UNSAFE_OBJECT_KEY", `Unsafe series ID: ${seriesId}.`, name);
    const declared = normalizeInitialStateDeclarations(
      options.initialStateSeriesIds ?? options.declaredInitialStates,
    );
    if (!declared.has(seriesId)) {
      fail(
        "UNDECLARED_INITIAL_STATE_PARAMETER",
        `Initial state ${seriesId} must be explicitly declared before it can be varied.`,
        name,
      );
    }
    return Object.freeze({
      name,
      kind: "initial_state",
      seriesId,
      field: "log10PopulationDensity",
      path: Object.freeze(["initialStates", seriesId, "log10PopulationDensity"]),
    });
  }

  fail(
    "PARAMETER_NOT_WHITELISTED",
    `${name} is not in the Stage 4 parameter whitelist.`,
    name,
  );
}

export function isWhitelistedParameter(name, options = {}) {
  try {
    parseParameterName(name, options);
    return true;
  } catch {
    return false;
  }
}

function normalizeParameterDefinition(definition, index, context) {
  plainObject(definition, `parameters[${index}]`);
  const name = nonEmptyString(definition.name ?? definition.parameter, `parameters[${index}].name`);
  const parsed = parseParameterName(name, context);
  const lower = finite(definition.lower ?? definition.minimum ?? definition.min, `${name}.lower`);
  const upper = finite(definition.upper ?? definition.maximum ?? definition.max, `${name}.upper`);
  if (lower >= upper) fail("INVALID_PARAMETER_BOUNDS", `${name} requires finite lower < upper.`, name);
  const rationale = nonEmptyString(definition.rationale, `${name}.rationale`).trim();
  const transform = definition.transform ?? "identity";
  if (transform !== "identity" && transform !== "log" && transform !== "log10") {
    fail(
      "INVALID_PARAMETER_TRANSFORM",
      `${name}.transform must be identity, log, or log10.`,
      `${name}.transform`,
    );
  }
  if (transform !== "identity" && lower <= 0) {
    fail(
      "INVALID_PARAMETER_TRANSFORM_BOUNDS",
      `${name} must have positive bounds for a logarithmic transform.`,
      name,
    );
  }
  return deepFreeze({ name, lower, upper, rationale, transform, parsed });
}

/**
 * Validate a bounded parameter space. Every entry requires finite bounds and a
 * non-empty scientific/exploratory rationale.
 */
export function validateParameterSpace(space) {
  plainObject(space, "parameterSpace");
  const initialStateSeriesIds = [
    ...normalizeInitialStateDeclarations(
      space.initialStateSeriesIds ?? space.declaredInitialStates ?? space.initialStates,
    ),
  ];
  const drugIds = space.drugIds === undefined ? undefined : [...space.drugIds];
  const rawParameters = Array.isArray(space.parameters)
    ? space.parameters
    : plainObject(space.parameters, "parameterSpace.parameters") &&
      Object.entries(space.parameters).map(([name, definition]) => ({ name, ...definition }));
  if (!Array.isArray(rawParameters) || rawParameters.length === 0) {
    fail("EMPTY_PARAMETER_SPACE", "parameterSpace.parameters must be a non-empty array or object.");
  }
  const parameters = rawParameters.map((definition, index) =>
    normalizeParameterDefinition(definition, index, { initialStateSeriesIds, drugIds }),
  );
  const names = new Set();
  for (const definition of parameters) {
    if (names.has(definition.name)) {
      fail("DUPLICATE_PARAMETER", `Duplicate parameter definition: ${definition.name}.`, definition.name);
    }
    names.add(definition.name);
  }
  return deepFreeze({
    parameters,
    initialStateSeriesIds,
    ...(drugIds ? { drugIds } : {}),
  });
}

export const normalizeParameterSpace = validateParameterSpace;

function getAtPath(value, path) {
  let current = value;
  for (const key of path) current = current?.[key];
  return current;
}

function setAtPath(value, path, replacement) {
  let current = value;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (!current[key] || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  current[path.at(-1)] = replacement;
}

function declarationsFromOptions(resolvedModel, options) {
  return (
    options.initialStateSeriesIds ??
    options.declaredInitialStates ??
    resolvedModel.initialStateSeriesIds ??
    (resolvedModel.initialStates && Object.keys(resolvedModel.initialStates)) ??
    []
  );
}

/** Return the current value for a whitelisted parameter. */
export function getParameterValue(resolvedModel, name, options = {}) {
  plainObject(resolvedModel, "resolvedModel");
  const parsed = parseParameterName(name, {
    initialStateSeriesIds: declarationsFromOptions(resolvedModel, options),
    drugIds: Object.keys(resolvedModel.parameters?.drugs ?? {}),
  });
  const value = getAtPath(resolvedModel, parsed.path);
  return finite(value, name);
}

/**
 * Apply flat whitelisted overrides to a deep cloned resolved-model snapshot.
 * The input snapshot and all nested objects remain untouched; the result is
 * deeply frozen.
 */
export function applyParameterOverrides(resolvedModel, overrides, options = {}) {
  plainObject(resolvedModel, "resolvedModel");
  plainObject(resolvedModel.parameters, "resolvedModel.parameters");
  plainObject(overrides, "overrides");
  const declaredInitialStates = declarationsFromOptions(resolvedModel, options);
  const drugIds = Object.keys(resolvedModel.parameters.drugs ?? {});
  const result = clone(resolvedModel);
  for (const [name, value] of Object.entries(overrides)) {
    finite(value, `overrides.${name}`);
    const parsed = parseParameterName(name, {
      initialStateSeriesIds: declaredInitialStates,
      drugIds,
    });
    setAtPath(result, parsed.path, value);
  }
  return deepFreeze(result);
}

export const applyOverrides = applyParameterOverrides;
export const applyOverridesToResolvedModel = applyParameterOverrides;

export function parameterValuesFromSnapshot(resolvedModel, parameterSpace) {
  const space = validateParameterSpace(parameterSpace);
  return Object.freeze(
    Object.fromEntries(
      space.parameters.map((definition) => [
        definition.name,
        getParameterValue(resolvedModel, definition.name, {
          initialStateSeriesIds: space.initialStateSeriesIds,
        }),
      ]),
    ),
  );
}

export function toTransformedValue(value, definition) {
  finite(value, `${definition?.name ?? "parameter"}.value`);
  if (definition.transform === "log") {
    if (value <= 0) fail("INVALID_TRANSFORM_VALUE", "Log-transformed values must be positive.");
    return Math.log(value);
  }
  if (definition.transform === "log10") {
    if (value <= 0) fail("INVALID_TRANSFORM_VALUE", "Log10-transformed values must be positive.");
    return Math.log10(value);
  }
  return value;
}

export function fromTransformedValue(value, definition) {
  finite(value, `${definition?.name ?? "parameter"}.transformedValue`);
  if (definition.transform === "log") return Math.exp(value);
  if (definition.transform === "log10") return 10 ** value;
  return value;
}

export function transformedBounds(definition) {
  return Object.freeze([
    toTransformedValue(definition.lower, definition),
    toTransformedValue(definition.upper, definition),
  ]);
}
