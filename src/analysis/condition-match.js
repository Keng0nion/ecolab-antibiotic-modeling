const MATCH_STATUSES = Object.freeze([
  "matched",
  "partially_matched",
  "transferred_calibration",
  "unknown",
  "incompatible",
]);

export const CONDITION_MATCH_STATUSES = MATCH_STATUSES;

const DEFAULT_CRITICAL_FIELDS = Object.freeze([
  "organism",
  "strain",
  "medium",
  "temperature",
  "measurementType",
]);

export class ConditionMatchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ConditionMatchError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path, actual) {
  throw new ConditionMatchError(code, message, { path, actual });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail("INVALID_CONDITIONS", `${path} must be a plain object.`, path, value);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function getAtPath(value, path) {
  const parts = path.split(".");
  let current = value;
  for (const part of parts) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return { present: false, value: undefined };
    current = current[part];
  }
  return { present: true, value: current };
}

function validateFields(fields, path) {
  if (!Array.isArray(fields) || fields.length === 0 || fields.some((field) => typeof field !== "string" || field.length === 0 || field !== field.trim())) {
    fail("INVALID_CONDITION_FIELDS", `${path} must be a non-empty array of unique non-empty paths.`, path, fields);
  }
  if (new Set(fields).size !== fields.length) {
    fail("DUPLICATE_CONDITION_FIELD", `${path} must contain unique paths.`, path, fields);
  }
  return fields;
}

function defaultFields(target, candidate) {
  return [...new Set([...Object.keys(target), ...Object.keys(candidate)])].sort();
}

function compareValues(target, candidate, comparator, field) {
  if (comparator !== undefined) {
    if (typeof comparator !== "function") fail("INVALID_COMPARATOR", `Comparator for ${field} must be a function.`, `comparators.${field}`, comparator);
    const result = comparator(target, candidate);
    if (typeof result !== "boolean") fail("INVALID_COMPARATOR_RESULT", `Comparator for ${field} must return boolean.`, `comparators.${field}`, result);
    return result;
  }
  return canonical(target) === canonical(candidate);
}

/**
 * Compare documented conditions field by field. Equality is exact by default:
 * units, labels, and nested structures are not inferred or converted. A caller
 * may provide an explicit comparator for a field when a scientific tolerance
 * has been documented.
 */
export function matchConditions(target, candidate, options = {}) {
  assertRecord(target, "target");
  assertRecord(candidate, "candidate");
  const fields = validateFields(options.fields ?? defaultFields(target, candidate), "fields");
  const criticalFields = validateFields(options.criticalFields ?? DEFAULT_CRITICAL_FIELDS, "criticalFields");
  const criticalSet = new Set(criticalFields);
  const comparators = options.comparators ?? {};
  assertRecord(comparators, "comparators");
  const transferDeclared = options.transferredCalibration === true;
  if (options.transferredCalibration !== undefined && typeof options.transferredCalibration !== "boolean") {
    fail("INVALID_TRANSFER_FLAG", "transferredCalibration must be boolean.", "transferredCalibration", options.transferredCalibration);
  }

  const fieldMatches = [];
  for (const field of fields) {
    const targetValue = getAtPath(target, field);
    const candidateValue = getAtPath(candidate, field);
    const critical = criticalSet.has(field);
    if (!targetValue.present || !candidateValue.present || targetValue.value === null || candidateValue.value === null || targetValue.value === "" || candidateValue.value === "") {
      fieldMatches.push({
        field,
        critical,
        status: "unknown",
        targetPresent: targetValue.present,
        candidatePresent: candidateValue.present,
        target: targetValue.present ? targetValue.value : null,
        candidate: candidateValue.present ? candidateValue.value : null,
        reason: !targetValue.present || targetValue.value === null || targetValue.value === ""
          ? "target condition is not documented"
          : "candidate condition is not documented",
      });
      continue;
    }
    const matched = compareValues(targetValue.value, candidateValue.value, comparators[field], field);
    fieldMatches.push({
      field,
      critical,
      status: matched ? "matched" : "incompatible",
      targetPresent: true,
      candidatePresent: true,
      target: targetValue.value,
      candidate: candidateValue.value,
      reason: matched ? "values match exactly or by the supplied comparator" : "documented values differ",
    });
  }

  const comparable = fieldMatches.filter((entry) => entry.status !== "unknown");
  const mismatches = fieldMatches.filter((entry) => entry.status === "incompatible");
  const criticalMismatches = mismatches.filter((entry) => entry.critical);
  const unknownFields = fieldMatches.filter((entry) => entry.status === "unknown");
  let status;
  if (comparable.length === 0) status = "unknown";
  else if (criticalMismatches.length > 0) status = transferDeclared ? "transferred_calibration" : "incompatible";
  else if (mismatches.length > 0 || unknownFields.length > 0) status = "partially_matched";
  else status = "matched";

  const warnings = [];
  const reasons = [];
  if (criticalMismatches.length > 0) {
    reasons.push({
      code: transferDeclared ? "TRANSFERRED_CRITICAL_MISMATCH" : "CRITICAL_CONDITION_MISMATCH",
      message: transferDeclared
        ? "Calibration transfer is explicitly declared across critical condition differences."
        : "One or more critical condition fields are incompatible.",
      fields: criticalMismatches.map((entry) => entry.field),
    });
  }
  if (unknownFields.length > 0) {
    warnings.push({
      code: "UNKNOWN_CONDITION_FIELDS",
      message: "Condition compatibility cannot be determined for undocumented fields.",
      fields: unknownFields.map((entry) => entry.field),
    });
  }
  if (transferDeclared && criticalMismatches.length === 0) {
    warnings.push({
      code: "UNNEEDED_TRANSFER_DECLARATION",
      message: "transferredCalibration was declared but no critical mismatch was found.",
    });
  }
  if (mismatches.length > 0 && criticalMismatches.length === 0) {
    reasons.push({
      code: "NONCRITICAL_CONDITION_MISMATCH",
      message: "One or more non-critical condition fields differ.",
      fields: mismatches.map((entry) => entry.field),
    });
  }
  if (status === "matched") {
    reasons.push({ code: "ALL_DOCUMENTED_FIELDS_MATCH", message: "All compared condition fields match." });
  } else if (status === "unknown") {
    reasons.push({ code: "NO_COMPARABLE_CONDITIONS", message: "No condition field is documented on both sides." });
  }

  return {
    schemaVersion: "1.0.0",
    kind: "condition-match",
    status,
    fields: fieldMatches,
    criticalMismatches,
    mismatches,
    unknownFields,
    summary: {
      comparedFieldCount: fields.length,
      matchedFieldCount: fieldMatches.filter((entry) => entry.status === "matched").length,
      mismatchCount: mismatches.length,
      criticalMismatchCount: criticalMismatches.length,
      unknownCount: unknownFields.length,
    },
    warnings,
    reasons,
  };
}

export const compareConditions = matchConditions;
