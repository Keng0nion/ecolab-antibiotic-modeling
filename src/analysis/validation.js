import { canonicalJson, sha256HexFallback } from "./fingerprint.js";
import { calculateMetrics } from "./metrics.js";
import { computeResiduals } from "./residuals.js";

const ALLOWED_METRICS = new Map([
  ["macro_rmse", "macroRmse"],
  ["macrormse", "macroRmse"],
  ["pooled_rmse", "pooledRmse"],
  ["pooledrmse", "pooledRmse"],
  ["rmse", "pooledRmse"],
  ["mae", "mae"],
  ["mean_residual", "meanResidual"],
  ["meanresidual", "meanResidual"],
  ["median_absolute_error", "medianAbsoluteError"],
  ["medianabsoluteerror", "medianAbsoluteError"],
  ["per_unit", "perUnit"],
  ["perunit", "perUnit"],
]);

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  return canonicalJson(value);
}

export function fingerprintValue(value) {
  return sha256HexFallback(canonicalJson(value));
}

function roleOf(observation) {
  return String(
    observation?.role ??
      observation?.dataRole ??
      observation?.split ??
      observation?.partition ??
      "",
  )
    .trim()
    .toLowerCase()
    .replaceAll("-", "_");
}

function assertValidationObservations(observations) {
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("INVALID_OBSERVATIONS", "observations must be a non-empty array.");
  }
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      fail("INVALID_OBSERVATION", `observations[${index}] must be an object.`);
    }
    const role = roleOf(observation);
    if (["training", "train", "training_calibration"].includes(role)) {
      fail("TRAINING_DATA_IN_VALIDATION", `observations[${index}] is training data.`);
    }
    if (!role.includes("validation") && role !== "test" && role !== "holdout") {
      fail(
        "VALIDATION_ROLE_REQUIRED",
        `observations[${index}] must be explicitly marked as validation data.`,
      );
    }
    if (
      typeof observation.independentUnitId !== "string" ||
      observation.independentUnitId.trim() === ""
    ) {
      fail(
        "INDEPENDENT_UNIT_REQUIRED",
        `observations[${index}] must specify independentUnitId.`,
      );
    }
  });
}

function assertNoRuntimeOverrides(options) {
  const forbidden = [
    "optimizer",
    "optimization",
    "fit",
    "fitting",
    "bounds",
    "parameterWhitelist",
    "errorModel",
    "sigma",
    "exclusions",
    "excludedObservationIds",
    "metrics",
    "metricNames",
    "baseline",
    "predeclaredBaseline",
  ];
  for (const key of forbidden) {
    if (Object.hasOwn(options, key)) {
      fail(
        "VALIDATION_PLAN_OVERRIDE",
        `${key} cannot be supplied at validation time; it must come from the locked plan.`,
      );
    }
  }
  if (Object.hasOwn(options, "parameters")) {
    fail(
      "VALIDATION_PARAMETER_OVERRIDE",
      "parameters cannot be supplied at validation time; use the locked plan parameters.",
    );
  }
}

function planDatasetFingerprint(plan) {
  return plan.datasetFingerprint ?? plan.sourceDatasetFingerprint;
}

function planSplitFingerprint(plan) {
  return plan.splitFingerprint ?? plan.split?.splitFingerprint;
}

function planParameters(plan) {
  return plan.parameters ?? plan.lockedParameters;
}

function planExclusions(plan) {
  return plan.exclusions ?? plan.excludedObservationIds;
}

function planMetrics(plan) {
  return plan.metrics ?? plan.metricNames;
}

function assertLockedPlan(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
    fail("LOCKED_PLAN_REQUIRED", "A locked validation plan is required.");
  }
  if (
    plan.locked !== true &&
    plan.lockedValidation !== true &&
    plan.status !== "locked" &&
    plan.role !== "locked_validation_plan"
  ) {
    fail("PLAN_NOT_LOCKED", "Validation plan must be explicitly locked before validation.");
  }
  if (typeof planDatasetFingerprint(plan) !== "string" || planDatasetFingerprint(plan) === "") {
    fail("DATASET_FINGERPRINT_REQUIRED", "Locked plan must contain datasetFingerprint.");
  }
  if (typeof planSplitFingerprint(plan) !== "string" || planSplitFingerprint(plan) === "") {
    fail("SPLIT_FINGERPRINT_REQUIRED", "Locked plan must contain splitFingerprint.");
  }
  const parameters = planParameters(plan);
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    fail("LOCKED_PARAMETERS_REQUIRED", "Locked plan must contain fixed parameters.");
  }
  if (plan.errorModel === undefined) {
    fail("LOCKED_ERROR_MODEL_REQUIRED", "Locked plan must contain a fixed errorModel declaration.");
  }
  if (!Array.isArray(planExclusions(plan))) {
    fail("LOCKED_EXCLUSIONS_REQUIRED", "Locked plan must contain a fixed exclusions array, even if empty.");
  }
  if (!Array.isArray(planMetrics(plan)) || planMetrics(plan).length === 0) {
    fail("LOCKED_METRICS_REQUIRED", "Locked plan must contain predeclared metrics.");
  }
  const forbidden = ["optimizer", "optimization", "fit", "fitting"];
  for (const key of forbidden) {
    if (Object.hasOwn(plan, key)) {
      fail("OPTIMIZATION_FORBIDDEN", `Locked validation plan cannot contain ${key}.`);
    }
  }
}

function fingerprintSplitValue(split) {
  const fingerprintable = {};
  for (const [key, value] of Object.entries(split)) {
    if (key !== "splitFingerprint") fingerprintable[key] = value;
  }
  return fingerprintValue(fingerprintable);
}

function actualFingerprint(options, observations, kind) {
  if (kind === "dataset" && options.dataset !== undefined) {
    return fingerprintValue(options.dataset);
  }
  if (kind === "split" && options.split !== undefined) {
    const computed = fingerprintSplitValue(options.split);
    if (
      typeof options.split.splitFingerprint === "string" &&
      options.split.splitFingerprint !== computed
    ) {
      fail(
        "SPLIT_RECORD_FINGERPRINT_MISMATCH",
        "The supplied split object no longer matches its recorded fingerprint.",
      );
    }
    return computed;
  }
  const direct =
    options[`${kind}Fingerprint`] ??
    (kind === "dataset" ? options.split?.sourceDatasetFingerprint : undefined);
  if (typeof direct === "string" && direct !== "") return direct;
  const values = new Set(
    observations
      .map((observation) => observation[`${kind}Fingerprint`])
      .filter((value) => typeof value === "string" && value !== ""),
  );
  if (values.size === 1) return [...values][0];
  fail(
    `${kind.toUpperCase()}_FINGERPRINT_REQUIRED`,
    `The actual ${kind} fingerprint must be supplied for verification.`,
  );
}

function exclusionId(exclusion) {
  if (typeof exclusion === "string") return exclusion;
  if (exclusion && typeof exclusion === "object") {
    return exclusion.observationId ?? exclusion.id;
  }
  return undefined;
}

function observationId(observation, index) {
  return observation.id ?? observation.observationId ?? `index:${index}`;
}

function applyLockedExclusions(observations, exclusions) {
  const ids = exclusions.map(exclusionId);
  if (ids.some((id) => typeof id !== "string" || id === "")) {
    fail("INVALID_LOCKED_EXCLUSION", "Every locked exclusion must identify an observation.");
  }
  const known = new Set(observations.map(observationId));
  for (const id of ids) {
    if (!known.has(id)) {
      fail("LOCKED_EXCLUSION_NOT_FOUND", `Locked exclusion ${id} is not present in the validation data.`);
    }
  }
  const excluded = new Set(ids);
  return observations.filter((observation, index) => !excluded.has(observationId(observation, index)));
}

function trainingUnitIds(options, plan) {
  const values =
    options.trainingIndependentUnitIds ??
    plan.trainingIndependentUnitIds ??
    options.split?.roles?.training?.independentUnitIds ??
    plan.split?.roles?.training?.independentUnitIds ??
    options.trainingObservations?.map((observation) => observation.independentUnitId);
  if (!Array.isArray(values)) {
    fail(
      "TRAINING_UNITS_REQUIRED",
      "Training independent unit IDs are required to verify no validation leakage.",
    );
  }
  values.forEach((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      fail("INVALID_TRAINING_UNIT", `trainingIndependentUnitIds[${index}] is invalid.`);
    }
  });
  return new Set(values);
}

function assertSplitRoleSeparation(split) {
  if (!split?.roles || typeof split.roles !== "object") return;
  const seen = new Map();
  for (const role of ["training", "development", "validation"]) {
    const values = split.roles[role]?.independentUnitIds;
    if (!Array.isArray(values)) continue;
    const withinRole = new Set();
    for (const id of values) {
      if (typeof id !== "string" || id.trim() === "") {
        fail("INVALID_SPLIT_UNIT", `split.roles.${role} contains an invalid unit ID.`);
      }
      if (withinRole.has(id)) {
        fail("DUPLICATE_SPLIT_UNIT", `${id} is duplicated within split role ${role}.`);
      }
      withinRole.add(id);
      if (seen.has(id)) {
        fail("INDEPENDENT_UNIT_LEAKAGE", `${id} appears in both ${seen.get(id)} and ${role}.`);
      }
      seen.set(id, role);
    }
  }
}

function assertNoUnitOverlap(options, plan, observations) {
  assertSplitRoleSeparation(options.split ?? plan.split);
  const training = trainingUnitIds(options, plan);
  const validation = new Set(observations.map((observation) => observation.independentUnitId));
  const overlap = [...validation].filter((id) => training.has(id));
  if (overlap.length > 0) {
    const error = new TypeError(
      `Training and validation independent units overlap: ${overlap.join(", ")}.`,
    );
    error.code = "INDEPENDENT_UNIT_LEAKAGE";
    error.overlap = overlap;
    throw error;
  }
  const lockedValidationUnits =
    plan.validationIndependentUnitIds ??
    options.split?.roles?.validation?.independentUnitIds ??
    plan.split?.roles?.validation?.independentUnitIds;
  if (Array.isArray(lockedValidationUnits)) {
    const locked = [...new Set(lockedValidationUnits)].sort();
    const actual = [...validation].sort();
    if (canonicalize(locked) !== canonicalize(actual)) {
      fail(
        "VALIDATION_UNITS_CHANGED",
        "Validation independent units do not match the locked plan.",
      );
    }
  }
  return { training: [...training].sort(), validation: [...validation].sort() };
}

function normalizeMetricNames(metrics) {
  const result = [];
  for (const metric of metrics) {
    if (typeof metric !== "string") fail("INVALID_LOCKED_METRIC", "Locked metric names must be strings.");
    const normalized = metric.toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
    const name = ALLOWED_METRICS.get(normalized) ?? ALLOWED_METRICS.get(normalized.replaceAll("_", ""));
    if (!name) fail("INVALID_LOCKED_METRIC", `Unsupported locked metric: ${metric}.`);
    if (!result.includes(name)) result.push(name);
  }
  return result;
}

function assertObservationsMatchVerifiedSources(options, observations) {
  if (options.dataset?.observations !== undefined) {
    if (!Array.isArray(options.dataset.observations)) {
      fail("INVALID_DATASET", "dataset.observations must be an array.");
    }
    const expected = options.dataset.observations.filter((observation) => {
      const role = roleOf(observation);
      return role.includes("validation") || role === "test" || role === "holdout";
    });
    if (canonicalize(expected) !== canonicalize(observations)) {
      fail(
        "VALIDATION_OBSERVATIONS_CHANGED",
        "Validation observations do not match the verified dataset.",
      );
    }
  }
  const lockedObservationIds = options.split?.roles?.validation?.observationIds;
  if (Array.isArray(lockedObservationIds)) {
    const expected = [...lockedObservationIds].sort();
    const actual = observations.map(observationId).sort();
    if (canonicalize(expected) !== canonicalize(actual)) {
      fail(
        "VALIDATION_OBSERVATIONS_CHANGED",
        "Validation observation IDs do not match the verified split.",
      );
    }
  }
}

function predictionNumber(value, index) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const selected = value.predicted ?? value.value ?? value.mean ?? value.predictedValue;
    if (typeof selected === "number" && Number.isFinite(selected)) return selected;
  }
  fail("INVALID_PREDICTION", `prediction ${index} must be finite.`);
}

function predict(options, parameters, observations) {
  const evaluator = options.evaluator;
  const predictor = options.predictor ?? options.predict;
  const safeParameters = clone(parameters);
  const safeObservations = clone(observations);
  let values;
  if (typeof evaluator === "function") {
    values = evaluator(safeParameters, safeObservations);
  } else if (typeof predictor === "function") {
    values = safeObservations.map((observation, index) =>
      predictor(clone(safeParameters), observation, index),
    );
  } else {
    fail("PREDICTOR_REQUIRED", "Validation requires a predictor or evaluator callback.");
  }
  if (!Array.isArray(values) || values.length !== observations.length) {
    fail("INVALID_EVALUATOR_RESULT", "Predictor must return one prediction per included observation.");
  }
  return values.map(predictionNumber);
}

function selectMetrics(allMetrics, names) {
  const result = {};
  for (const name of names) result[name] = clone(allMetrics[name]);
  result.observationCount = allMetrics.observationCount;
  result.independentUnitCount = allMetrics.independentUnitCount;
  if (allMetrics.baselineComparison) result.baselineComparison = clone(allMetrics.baselineComparison);
  return result;
}

function evidenceQualification(options) {
  const nested = options.evidenceQualification ?? options.validationEvidenceQualification;
  if (nested !== undefined && (!nested || typeof nested !== "object" || Array.isArray(nested))) {
    fail(
      "INVALID_VALIDATION_EVIDENCE_QUALIFICATION",
      "evidenceQualification must be a plain object when supplied.",
    );
  }
  const direct = {
    independentUnitsDocumented: options.independentUnitsDocumented,
    eligibleAsValidationEvidence: options.eligibleAsValidationEvidence,
  };
  const supplied = nested !== undefined
    || direct.independentUnitsDocumented !== undefined
    || direct.eligibleAsValidationEvidence !== undefined;
  if (!supplied) {
    return {
      independentUnitsDocumented: false,
      eligibleAsValidationEvidence: false,
      source: "not_provided",
    };
  }
  for (const key of ["independentUnitsDocumented", "eligibleAsValidationEvidence"]) {
    for (const [sourceName, source] of [["evidenceQualification", nested], ["options", direct]]) {
      if (source?.[key] !== undefined && typeof source[key] !== "boolean") {
        fail(
          "INVALID_VALIDATION_EVIDENCE_QUALIFICATION",
          `${sourceName}.${key} must be boolean when supplied.`,
        );
      }
    }
    if (nested?.[key] !== undefined && direct[key] !== undefined && nested[key] !== direct[key]) {
      fail(
        "CONFLICTING_VALIDATION_EVIDENCE_QUALIFICATION",
        `Conflicting ${key} values were supplied for the same validation evaluation.`,
      );
    }
  }
  const independentUnitsDocumented = (
    nested?.independentUnitsDocumented ?? direct.independentUnitsDocumented
  ) === true;
  const eligibleAsValidationEvidence = (
    nested?.eligibleAsValidationEvidence ?? direct.eligibleAsValidationEvidence
  ) === true;
  if (eligibleAsValidationEvidence && !independentUnitsDocumented) {
    fail(
      "CONFLICTING_VALIDATION_EVIDENCE_QUALIFICATION",
      "Validation evidence cannot be marked eligible when independent units are not documented.",
    );
  }
  return {
    independentUnitsDocumented,
    eligibleAsValidationEvidence,
    source: "caller_supplied",
  };
}

export function validateLockedPlan(options) {
  if (!options || typeof options !== "object") {
    fail("INVALID_OPTIONS", "validateLockedPlan requires an options object.");
  }
  assertNoRuntimeOverrides(options);
  const plan = options.plan ?? options.lockedPlan;
  assertLockedPlan(plan);
  const observations =
    options.observations ??
    options.dataset?.observations?.filter((observation) => {
      const role = roleOf(observation);
      return role.includes("validation") || role === "test" || role === "holdout";
    });
  assertValidationObservations(observations);
  assertObservationsMatchVerifiedSources(options, observations);
  const datasetFingerprint = actualFingerprint(options, observations, "dataset");
  const splitFingerprint = actualFingerprint(options, observations, "split");
  if (datasetFingerprint !== planDatasetFingerprint(plan)) {
    fail("DATASET_FINGERPRINT_MISMATCH", "Validation dataset fingerprint does not match the locked plan.");
  }
  if (splitFingerprint !== planSplitFingerprint(plan)) {
    fail("SPLIT_FINGERPRINT_MISMATCH", "Validation split fingerprint does not match the locked plan.");
  }
  if (
    options.split?.sourceDatasetFingerprint !== undefined &&
    options.split.sourceDatasetFingerprint !== datasetFingerprint
  ) {
    fail(
      "SPLIT_DATASET_FINGERPRINT_MISMATCH",
      "The supplied split does not belong to the verified validation dataset.",
    );
  }
  const units = assertNoUnitOverlap(options, plan, observations);
  const exclusions = planExclusions(plan);
  const includedObservations = applyLockedExclusions(observations, exclusions);
  if (includedObservations.length === 0) {
    fail("NO_INCLUDED_VALIDATION_DATA", "Locked exclusions remove all validation observations.");
  }
  const declaredMetricNames = clone(planMetrics(plan));
  const metricNames = normalizeMetricNames(declaredMetricNames);
  const parameters = clone(planParameters(plan));
  const predictions = predict(options, parameters, includedObservations);
  const allMetrics = calculateMetrics({
    observations: includedObservations,
    predictions,
    predeclaredBaseline: plan.baseline,
  });
  const metrics = selectMetrics(allMetrics, metricNames);
  const residuals = computeResiduals(includedObservations, predictions);
  const qualification = evidenceQualification(options);

  return {
    role: "locked_holdout_evaluation",
    evidenceStatus: "procedural_locked_holdout_evaluation",
    completed: true,
    locked: true,
    lockedValidation: true,
    leakageFree: true,
    untouched: true,
    fittedOnThisData: false,
    independentUnitsDocumented: qualification.independentUnitsDocumented,
    eligibleAsValidationEvidence: qualification.eligibleAsValidationEvidence,
    evidenceQualificationSource: qualification.source,
    parametersAltered: false,
    errorModelAltered: false,
    exclusionsAltered: false,
    metricsAltered: false,
    planLocked: true,
    planId: plan.id ?? null,
    datasetFingerprint,
    splitFingerprint,
    parameters,
    errorModel: clone(plan.errorModel),
    exclusions: clone(exclusions),
    metricNames: declaredMetricNames,
    resolvedMetricNames: metricNames,
    predictions,
    residuals,
    metrics,
    observationCount: includedObservations.length,
    excludedObservationCount: observations.length - includedObservations.length,
    independentUnits: units,
  };
}

export const validateModel = validateLockedPlan;
export const runValidation = validateLockedPlan;
export const createFingerprint = fingerprintValue;
