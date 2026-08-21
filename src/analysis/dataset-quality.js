const ROLES = Object.freeze(["training", "validation", "development"]);
const ROLE_SET = new Set(ROLES);
const MEASUREMENT_TYPES = Object.freeze([
  "log10_cfu_per_ml",
  "cfu_per_ml",
  "od600",
  "od595",
]);
const MEASUREMENT_SET = new Set(MEASUREMENT_TYPES);
const CENSORING_TYPES = Object.freeze(["none", "left", "right", "interval"]);
const CENSORING_SET = new Set(CENSORING_TYPES);
const DEFAULT_KEY_CONDITIONS = Object.freeze([
  "organism",
  "strain",
  "medium",
  "temperature",
]);

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function issue(severity, code, message, path, details = undefined) {
  const result = { severity, code, message, path };
  if (details !== undefined) result.details = details;
  return result;
}

function getCondition(observationConditions, metadataConditions, field) {
  if (isRecord(observationConditions) && observationConditions[field] !== undefined && observationConditions[field] !== null && observationConditions[field] !== "") {
    return observationConditions[field];
  }
  if (isRecord(metadataConditions) && metadataConditions[field] !== undefined && metadataConditions[field] !== null && metadataConditions[field] !== "") {
    return metadataConditions[field];
  }
  return undefined;
}

function increment(object, key) {
  object[key] = (object[key] ?? 0) + 1;
}

function checkCensoring(observation, index, errors, warnings) {
  const path = `dataset.observations[${index}]`;
  if (!CENSORING_SET.has(observation.censoring)) {
    errors.push(issue("error", "INVALID_CENSORING", "Censoring must be none, left, right, or interval.", `${path}.censoring`, { actual: observation.censoring }));
    return;
  }
  const bounds = observation.censoringBounds;
  if (observation.censoring === "none") {
    if (bounds !== null) {
      errors.push(issue("error", "UNEXPECTED_CENSORING_BOUNDS", "Uncensored observations must have null censoringBounds.", `${path}.censoringBounds`, { actual: bounds }));
    }
    return;
  }
  if (!isRecord(bounds)) {
    errors.push(issue("error", "MISSING_CENSORING_BOUNDS", "Censored observations require a censoringBounds object.", `${path}.censoringBounds`, { actual: bounds }));
    return;
  }

  if (observation.censoring === "left") {
    if (!finite(bounds.upper) || Object.keys(bounds).some((key) => key !== "upper")) {
      errors.push(issue("error", "INVALID_LEFT_CENSORING_BOUNDS", "Left censoring requires exactly one finite upper bound.", `${path}.censoringBounds`, { actual: bounds }));
    } else if (finite(observation.value) && observation.value > bounds.upper) {
      warnings.push(issue("warning", "CENSORED_VALUE_ABOVE_UPPER_BOUND", "The retained value is above its left-censoring upper bound.", `${path}.value`, { value: observation.value, upper: bounds.upper }));
    }
  } else if (observation.censoring === "right") {
    if (!finite(bounds.lower) || Object.keys(bounds).some((key) => key !== "lower")) {
      errors.push(issue("error", "INVALID_RIGHT_CENSORING_BOUNDS", "Right censoring requires exactly one finite lower bound.", `${path}.censoringBounds`, { actual: bounds }));
    } else if (finite(observation.value) && observation.value < bounds.lower) {
      warnings.push(issue("warning", "CENSORED_VALUE_BELOW_LOWER_BOUND", "The retained value is below its right-censoring lower bound.", `${path}.value`, { value: observation.value, lower: bounds.lower }));
    }
  } else {
    const keysValid = Object.keys(bounds).every((key) => key === "lower" || key === "upper") && Object.keys(bounds).length === 2;
    if (!finite(bounds.lower) || !finite(bounds.upper) || !keysValid || bounds.lower > bounds.upper) {
      errors.push(issue("error", "INVALID_INTERVAL_CENSORING_BOUNDS", "Interval censoring requires finite lower and upper bounds with lower <= upper.", `${path}.censoringBounds`, { actual: bounds }));
    } else if (finite(observation.value) && (observation.value < bounds.lower || observation.value > bounds.upper)) {
      warnings.push(issue("warning", "CENSORED_VALUE_OUTSIDE_INTERVAL", "The retained value is outside its censoring interval.", `${path}.value`, { value: observation.value, bounds }));
    }
  }
}

function checkBasicObservation(observation, index, errors, warnings, metadataConditions, keyConditionFields) {
  const path = `dataset.observations[${index}]`;
  if (!isRecord(observation)) {
    errors.push(issue("error", "INVALID_OBSERVATION", "Observation must be a plain object.", path, { actual: observation }));
    return false;
  }
  for (const key of ["observationId", "seriesId", "independentUnitId", "drugId", "replicate"]) {
    if (!nonEmptyString(observation[key])) {
      errors.push(issue("error", "INVALID_REQUIRED_STRING", `${key} must be a non-empty string without surrounding whitespace.`, `${path}.${key}`, { actual: observation[key] }));
    }
  }
  if (!ROLE_SET.has(observation.role)) {
    errors.push(issue("error", "INVALID_ROLE", "role must be training, validation, or development.", `${path}.role`, { actual: observation.role }));
  }
  if (!finite(observation.timeHours) || observation.timeHours < 0) {
    errors.push(issue("error", "INVALID_TIME", "timeHours must be a finite non-negative number.", `${path}.timeHours`, { actual: observation.timeHours }));
  }
  if (!finite(observation.concentrationMgPerL) || observation.concentrationMgPerL < 0) {
    errors.push(issue("error", "INVALID_CONCENTRATION", "concentrationMgPerL must be a finite non-negative number.", `${path}.concentrationMgPerL`, { actual: observation.concentrationMgPerL }));
  }
  if (!MEASUREMENT_SET.has(observation.measurementType)) {
    errors.push(issue("error", "INVALID_MEASUREMENT_TYPE", "measurementType is unsupported.", `${path}.measurementType`, { actual: observation.measurementType }));
  }
  if (!finite(observation.value)) {
    errors.push(issue("error", "INVALID_MEASUREMENT_VALUE", "value must be finite.", `${path}.value`, { actual: observation.value }));
  } else if (observation.measurementType !== "log10_cfu_per_ml" && observation.value < 0) {
    errors.push(issue("error", "NEGATIVE_MEASUREMENT_VALUE", `${observation.measurementType} values cannot be negative.`, `${path}.value`, { actual: observation.value }));
  }
  if (!isRecord(observation.conditions)) {
    errors.push(issue("error", "INVALID_CONDITIONS", "conditions must be a plain object.", `${path}.conditions`, { actual: observation.conditions }));
  }
  const missing = keyConditionFields.filter((field) => getCondition(observation.conditions, metadataConditions, field) === undefined);
  if (missing.length > 0) {
    warnings.push(issue("warning", "MISSING_KEY_CONDITION_METADATA", "Key experimental condition metadata is missing; condition matching may be unknown.", `${path}.conditions`, {
      missing,
      observationId: observation.observationId,
    }));
  }
  checkCensoring(observation, index, errors, warnings);
  return true;
}

function checkSeries(series, errors, warnings) {
  for (const [seriesId, entries] of series) {
    const path = `series.${seriesId}`;
    const values = (key) => new Map(entries.map(({ observation }) => [canonical(observation[key]), observation[key]]));
    const criticalFields = ["independentUnitId", "role", "measurementType", "drugId", "concentrationMgPerL", "replicate"];
    for (const field of criticalFields) {
      const distinct = [...values(field).values()];
      if (distinct.length > 1) {
        errors.push(issue("error", field === "measurementType" ? "INCONSISTENT_SERIES_MEASUREMENT" : "INCONSISTENT_SERIES_FIELD", `Series ${seriesId} has inconsistent ${field}.`, path, {
          seriesId,
          field,
          values: distinct,
          observationIds: entries.map(({ observation }) => observation.observationId),
        }));
      }
    }
    const conditions = values("conditions");
    if (conditions.size > 1) {
      errors.push(issue("error", "INCONSISTENT_SERIES_CONDITIONS", `Series ${seriesId} has inconsistent conditions.`, path, {
        seriesId,
        observationIds: entries.map(({ observation }) => observation.observationId),
      }));
    }
    const timeCounts = new Map();
    for (const { observation } of entries) {
      const time = String(observation.timeHours);
      timeCounts.set(time, (timeCounts.get(time) ?? 0) + 1);
    }
    const duplicateTimes = [...timeCounts.entries()].filter(([, count]) => count > 1).map(([timeHours]) => Number(timeHours));
    if (duplicateTimes.length > 0) {
      warnings.push(issue("warning", "DUPLICATE_SERIES_TIME", `Series ${seriesId} contains repeated time points.`, path, { seriesId, timeHours: duplicateTimes }));
    }
  }
}

/**
 * Generate a pure quality report without modifying or repairing the dataset.
 * Observation-level conditions may inherit explicitly documented dataset-level
 * condition fields only for missing-metadata checks; no scientific values or
 * units are inferred.
 */
export function assessDatasetQuality(dataset, options = {}) {
  const keyConditionFields = options.keyConditionFields ?? DEFAULT_KEY_CONDITIONS;
  if (!Array.isArray(keyConditionFields) || keyConditionFields.some((field) => !nonEmptyString(field))) {
    throw new TypeError("keyConditionFields must be an array of non-empty strings.");
  }
  const errors = [];
  const warnings = [];
  const info = [];
  if (!isRecord(dataset)) {
    errors.push(issue("error", "INVALID_DATASET", "Dataset must be a plain object.", "dataset", { actual: dataset }));
    return finishReport(dataset, errors, warnings, info, [], keyConditionFields);
  }
  if (!isRecord(dataset.metadata)) {
    errors.push(issue("error", "INVALID_DATASET_METADATA", "dataset.metadata must be a plain object.", "dataset.metadata", { actual: dataset.metadata }));
  }
  if (!Array.isArray(dataset.observations)) {
    errors.push(issue("error", "INVALID_OBSERVATIONS", "dataset.observations must be an array.", "dataset.observations", { actual: dataset.observations }));
    return finishReport(dataset, errors, warnings, info, [], keyConditionFields);
  }
  const metadataConditions = isRecord(dataset.metadata?.conditions) ? dataset.metadata.conditions : {};
  const duplicateIds = new Map();
  const independentUnits = new Map();
  const series = new Map();

  dataset.observations.forEach((observation, index) => {
    if (!checkBasicObservation(observation, index, errors, warnings, metadataConditions, keyConditionFields)) return;
    const id = observation.observationId;
    if (nonEmptyString(id)) {
      const positions = duplicateIds.get(id) ?? [];
      positions.push(index);
      duplicateIds.set(id, positions);
    }
    if (nonEmptyString(observation.independentUnitId)) {
      let unit = independentUnits.get(observation.independentUnitId);
      if (!unit) {
        unit = { roles: new Set(), observationIds: [] };
        independentUnits.set(observation.independentUnitId, unit);
      }
      if (ROLE_SET.has(observation.role)) unit.roles.add(observation.role);
      unit.observationIds.push(observation.observationId);
    }
    if (nonEmptyString(observation.seriesId)) {
      const entries = series.get(observation.seriesId) ?? [];
      entries.push({ observation, index });
      series.set(observation.seriesId, entries);
    }
  });

  for (const [observationId, positions] of duplicateIds) {
    if (positions.length > 1) {
      errors.push(issue("error", "DUPLICATE_OBSERVATION_ID", `observationId ${observationId} is duplicated.`, "dataset.observations", { observationId, positions }));
    }
  }
  for (const [independentUnitId, unit] of independentUnits) {
    if (unit.roles.size > 1) {
      errors.push(issue("error", "INDEPENDENT_UNIT_ROLE_LEAKAGE", `Independent unit ${independentUnitId} appears in multiple roles.`, "dataset.observations", {
        independentUnitId,
        roles: [...unit.roles].sort(),
        observationIds: unit.observationIds,
      }));
    }
  }
  checkSeries(series, errors, warnings);

  if (dataset.observations.length === 0) {
    warnings.push(issue("warning", "EMPTY_DATASET", "Dataset contains no observations.", "dataset.observations"));
  }
  const odCount = dataset.observations.filter((observation) => observation?.measurementType === "od600" || observation?.measurementType === "od595").length;
  if (odCount > 0) {
    info.push(issue("info", "OD_SEMANTICS_PRESERVED", "Optical-density observations remain OD measurements and are not treated as CFU.", "dataset.observations", { observationCount: odCount }));
  }
  const censoredCount = dataset.observations.filter((observation) => observation && observation.censoring && observation.censoring !== "none").length;
  if (censoredCount > 0) {
    info.push(issue("info", "CENSORING_PRESENT", "Censoring is explicitly represented and must be handled by downstream analyses.", "dataset.observations", { observationCount: censoredCount }));
  }
  return finishReport(dataset, errors, warnings, info, dataset.observations, keyConditionFields, independentUnits, series);
}

function finishReport(dataset, errors, warnings, info, observations, keyConditionFields, independentUnits = new Map(), series = new Map()) {
  const byRole = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const byMeasurementType = Object.fromEntries(MEASUREMENT_TYPES.map((type) => [type, 0]));
  const byCensoring = Object.fromEntries(CENSORING_TYPES.map((type) => [type, 0]));
  for (const observation of observations) {
    if (ROLE_SET.has(observation?.role)) increment(byRole, observation.role);
    if (MEASUREMENT_SET.has(observation?.measurementType)) increment(byMeasurementType, observation.measurementType);
    if (CENSORING_SET.has(observation?.censoring)) increment(byCensoring, observation.censoring);
  }
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset-quality-report",
    datasetId: nonEmptyString(dataset?.metadata?.datasetId) ? dataset.metadata.datasetId : null,
    valid: errors.length === 0,
    errors,
    warnings,
    info,
    summary: {
      observationCount: observations.length,
      uniqueObservationIdCount: new Set(observations.map((observation) => observation?.observationId).filter(nonEmptyString)).size,
      seriesCount: series.size,
      independentUnitCount: independentUnits.size,
      byRole,
      byMeasurementType,
      byCensoring,
      errorCount: errors.length,
      warningCount: warnings.length,
      infoCount: info.length,
      keyConditionFields: [...keyConditionFields],
    },
  };
}

export const createDatasetQualityReport = assessDatasetQuality;
export const reportDatasetQuality = assessDatasetQuality;
