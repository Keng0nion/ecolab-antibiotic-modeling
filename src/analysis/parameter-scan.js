import {
  applyParameterOverrides,
  getParameterValue,
  validateParameterSpace,
} from "./parameter-space.js";

export const PARAMETER_SCAN_LIMITS = Object.freeze({
  warningCandidates: 10_000,
  blockCandidates: 50_000,
});

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
    fail("INVALID_SCAN_OPTIONS", `${path} must be a plain object.`, path);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_SCAN_VALUE", `${path} must be a finite number.`, path);
  }
  return value;
}

function clone(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = clone(child);
    return result;
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function serializeError(error) {
  if (error instanceof Error) {
    return freeze({
      name: error.name,
      message: error.message,
      ...(error.code !== undefined ? { code: error.code } : {}),
      ...(error.path !== undefined ? { path: error.path } : {}),
    });
  }
  return freeze({ name: "Error", message: String(error) });
}

function normalizeSpace(options) {
  if (options.parameterSpace) return validateParameterSpace(options.parameterSpace);
  if (!Array.isArray(options.parameters)) {
    fail(
      "PARAMETER_SPACE_REQUIRED",
      "parameterSpace or a parameters array with bounds, rationale, and scan values is required.",
    );
  }
  return validateParameterSpace({
    parameters: options.parameters,
    initialStateSeriesIds: options.initialStateSeriesIds ?? options.declaredInitialStates,
    drugIds: options.drugIds,
  });
}

function scanValues(options, space) {
  const configured = options.values ?? options.scanValues;
  const result = {};
  for (const definition of space.parameters) {
    const embedded = options.parameters?.find?.(
      (item) => (item.name ?? item.parameter) === definition.name,
    );
    const values = configured?.[definition.name] ?? embedded?.values;
    if (!Array.isArray(values) || values.length === 0) {
      fail(
        "SCAN_VALUES_REQUIRED",
        `A non-empty values array is required for ${definition.name}.`,
        definition.name,
      );
    }
    result[definition.name] = values.map((value, index) => {
      finite(value, `values.${definition.name}[${index}]`);
      if (value < definition.lower || value > definition.upper) {
        fail(
          "SCAN_VALUE_OUT_OF_BOUNDS",
          `${definition.name} scan value ${value} is outside [${definition.lower}, ${definition.upper}].`,
          definition.name,
        );
      }
      return value;
    });
  }
  return result;
}

function baselineValues(options, space) {
  const supplied = options.baseline ?? options.baseParameters;
  const result = {};
  for (const definition of space.parameters) {
    let value = supplied?.[definition.name];
    if (value === undefined && options.resolvedModel) {
      value = getParameterValue(options.resolvedModel, definition.name, {
        initialStateSeriesIds: space.initialStateSeriesIds,
      });
    }
    finite(value, `baseline.${definition.name}`);
    if (value < definition.lower || value > definition.upper) {
      fail(
        "BASELINE_OUT_OF_BOUNDS",
        `baseline.${definition.name} is outside its declared bounds.`,
        definition.name,
      );
    }
    result[definition.name] = value;
  }
  return result;
}

function cartesianCandidates(space, values) {
  const candidates = [];
  function visit(index, current) {
    if (index === space.parameters.length) {
      candidates.push({ ...current });
      return;
    }
    const name = space.parameters[index].name;
    for (const value of values[name]) {
      current[name] = value;
      visit(index + 1, current);
    }
    delete current[name];
  }
  visit(0, {});
  return candidates;
}

function oneAtATimeCandidates(space, values, baseline, includeBaseline) {
  const candidates = includeBaseline ? [{ ...baseline }] : [];
  for (const definition of space.parameters) {
    for (const value of values[definition.name]) {
      if (!includeBaseline && value === baseline[definition.name]) continue;
      candidates.push({ ...baseline, [definition.name]: value });
    }
  }
  return candidates;
}

function explicitCandidates(options, space) {
  if (!Array.isArray(options.cases) || options.cases.length === 0) {
    fail("SCAN_CASES_REQUIRED", "Explicit scans require a non-empty cases array.");
  }
  const allowed = new Set(space.parameters.map((definition) => definition.name));
  return options.cases.map((candidate, index) => {
    plainObject(candidate, `cases[${index}]`);
    for (const key of Object.keys(candidate)) {
      if (!allowed.has(key)) {
        fail("PARAMETER_NOT_IN_SPACE", `cases[${index}].${key} is not in parameterSpace.`, key);
      }
    }
    const result = {};
    for (const definition of space.parameters) {
      const value = finite(candidate[definition.name], `cases[${index}].${definition.name}`);
      if (value < definition.lower || value > definition.upper) {
        fail(
          "SCAN_VALUE_OUT_OF_BOUNDS",
          `cases[${index}].${definition.name} is outside its declared bounds.`,
          definition.name,
        );
      }
      result[definition.name] = value;
    }
    return result;
  });
}

function buildCandidates(options, method, space) {
  if (method === "explicit") return explicitCandidates(options, space);
  const values = scanValues(options, space);
  if (method === "cartesian") return cartesianCandidates(space, values);
  if (method === "one_at_a_time") {
    return oneAtATimeCandidates(
      space,
      values,
      baselineValues(options, space),
      options.includeBaseline !== false,
    );
  }
  fail(
    "INVALID_SCAN_METHOD",
    "method must be cartesian, one_at_a_time (or one-at-a-time), or explicit.",
  );
}

function warnForSize(count) {
  if (count > PARAMETER_SCAN_LIMITS.blockCandidates) {
    fail(
      "PARAMETER_SCAN_BLOCK_LIMIT",
      `Parameter scan has ${count} candidates; the hard limit is ${PARAMETER_SCAN_LIMITS.blockCandidates}.`,
      "candidateCount",
      RangeError,
    );
  }
  if (count > PARAMETER_SCAN_LIMITS.warningCandidates) {
    return [
      freeze({
        code: "PARAMETER_SCAN_LARGE",
        severity: "warning",
        message: `Parameter scan has ${count} candidates, above the ${PARAMETER_SCAN_LIMITS.warningCandidates} warning threshold.`,
        candidateCount: count,
      }),
    ];
  }
  return [];
}

/**
 * Run a synchronous pure-callback parameter scan. Failed candidates are kept
 * in-place in results with serialized errors.
 */
export function runParameterScan(options) {
  plainObject(options, "options");
  const evaluator = options.evaluator ?? options.evaluate;
  if (typeof evaluator !== "function") {
    fail("EVALUATOR_REQUIRED", "A pure evaluator callback is required.", "evaluator");
  }
  const rawMethod = options.method ?? options.mode ?? "cartesian";
  const method = rawMethod === "one-at-a-time" || rawMethod === "oat" ? "one_at_a_time" : rawMethod;
  const space = normalizeSpace(options);
  const candidates = buildCandidates(options, method, space);
  const warnings = warnForSize(candidates.length);
  const progress = options.onProgress ?? options.progress;
  if (progress !== undefined && typeof progress !== "function") {
    fail("INVALID_PROGRESS_CALLBACK", "onProgress must be a function.");
  }

  const results = [];
  let successCount = 0;
  let failureCount = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const parameters = freeze({ ...candidates[index] });
    const snapshot = options.resolvedModel
      ? applyParameterOverrides(options.resolvedModel, parameters, {
          initialStateSeriesIds: space.initialStateSeriesIds,
        })
      : undefined;
    const context = freeze({
      index,
      candidateIndex: index,
      total: candidates.length,
      method,
      ...(snapshot ? { resolvedModel: snapshot, snapshot } : {}),
    });
    try {
      const value = evaluator(parameters, context);
      if (value && typeof value.then === "function") {
        fail("ASYNC_EVALUATOR_NOT_SUPPORTED", "runParameterScan requires a synchronous evaluator.");
      }
      results.push(
        freeze({
          index,
          parameters,
          status: "ok",
          value: clone(value),
          output: clone(value),
        }),
      );
      successCount += 1;
    } catch (error) {
      results.push(
        freeze({
          index,
          parameters,
          status: "failed",
          error: serializeError(error),
        }),
      );
      failureCount += 1;
    }
    progress?.(
      freeze({
        completed: index + 1,
        total: candidates.length,
        fraction: candidates.length === 0 ? 1 : (index + 1) / candidates.length,
        successCount,
        failureCount,
      }),
    );
  }

  return freeze({
    kind: "parameter_scan",
    method,
    parameterSpace: space,
    candidateCount: candidates.length,
    successCount,
    failureCount,
    failureFraction: candidates.length === 0 ? 0 : failureCount / candidates.length,
    warnings,
    results,
  });
}

export const parameterScan = runParameterScan;
export const scanParameters = runParameterScan;
