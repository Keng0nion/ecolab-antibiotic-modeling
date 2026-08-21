import {
  CANONICAL_UNITS,
  log10PopulationToLinear,
  populationToLog10,
  simulatePiecewise,
} from "../model.js";
import { normalizeObservationDataset } from "./dataset-import.js";
import { applyParameterOverrides } from "./parameter-space.js";

const MEASUREMENT_TYPES = new Set([
  "log10_cfu_per_ml",
  "cfu_per_ml",
  "od600",
  "od595",
]);

const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const TIME_TOLERANCE_HOURS = 1e-12;

export class ModelEvaluatorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ModelEvaluatorError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path = null, actual = undefined, ErrorType = ModelEvaluatorError) {
  throw new ErrorType(code, message, { path, actual });
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

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("NON_FINITE_NUMBER", `${path} must be a finite number.`, path, value);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_STRING", `${path} must be a non-empty string.`, path, value);
  }
  return value;
}

function cloneJson(value, path = "$", stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, path);
  if (typeof value !== "object") {
    fail("NON_JSON_VALUE", `${path} must be JSON-safe.`, path, typeof value);
  }
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

function normalizedObservation(observation, index) {
  record(observation, `observations[${index}]`);
  const requiredStrings = ["observationId", "seriesId", "independentUnitId", "drugId"];
  for (const key of requiredStrings) nonEmptyString(observation[key], `observations[${index}].${key}`);
  for (const key of ["seriesId", "drugId"]) {
    if (UNSAFE_KEYS.has(observation[key])) {
      fail("UNSAFE_OBJECT_KEY", `Unsafe ${key}: ${observation[key]}.`, `observations[${index}].${key}`);
    }
  }
  finite(observation.timeHours, `observations[${index}].timeHours`);
  if (observation.timeHours < 0) {
    fail("NEGATIVE_TIME", `observations[${index}].timeHours cannot be negative.`, `observations[${index}].timeHours`);
  }
  finite(observation.concentrationMgPerL, `observations[${index}].concentrationMgPerL`);
  if (observation.concentrationMgPerL < 0) {
    fail(
      "NEGATIVE_CONCENTRATION",
      `observations[${index}].concentrationMgPerL cannot be negative.`,
      `observations[${index}].concentrationMgPerL`,
    );
  }
  if (!MEASUREMENT_TYPES.has(observation.measurementType)) {
    fail(
      "UNSUPPORTED_MEASUREMENT_TYPE",
      `observations[${index}].measurementType must be one of: ${[...MEASUREMENT_TYPES].join(", ")}.`,
      `observations[${index}].measurementType`,
      observation.measurementType,
    );
  }
  return observation;
}

function normalizeSeriesInput(input) {
  const observations = Array.isArray(input) ? input : input?.observations;
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("EMPTY_OBSERVATION_SERIES", "A non-empty observations array is required.", "observations", observations);
  }
  return observations.map(normalizedObservation);
}

function groupObservations(observations) {
  const grouped = new Map();
  observations.forEach((observation, index) => {
    const entry = { observation, index };
    if (!grouped.has(observation.seriesId)) grouped.set(observation.seriesId, []);
    grouped.get(observation.seriesId).push(entry);
  });
  return grouped;
}

function seriesDescriptor(entries) {
  const seriesId = entries[0].observation.seriesId;
  if (entries.some(({ observation }) => observation.seriesId !== seriesId)) {
    fail("MIXED_SERIES", "evaluateObservationSeries accepts exactly one series.", "observations");
  }
  const drugs = new Set(entries.map(({ observation }) => observation.drugId));
  if (drugs.size !== 1) {
    fail(
      "MULTIPLE_DRUGS_IN_SERIES",
      `Series ${seriesId} must declare exactly one drugId.`,
      `series.${seriesId}.drugId`,
      [...drugs],
    );
  }
  const drugId = [...drugs][0];
  const byTime = new Map();
  for (const { observation } of entries) {
    const existing = byTime.get(observation.timeHours);
    if (existing && existing.concentrationMgPerL !== observation.concentrationMgPerL) {
      fail(
        "CONFLICTING_EXPOSURE_AT_TIME",
        `Series ${seriesId} has multiple concentrations at time ${observation.timeHours}.`,
        `series.${seriesId}.timeHours.${observation.timeHours}`,
      );
    }
    if (!existing) {
      byTime.set(observation.timeHours, {
        timeHours: observation.timeHours,
        concentrationMgPerL: observation.concentrationMgPerL,
      });
    }
  }
  const exposureRows = [...byTime.values()].sort((left, right) => left.timeHours - right.timeHours);
  return freeze({
    seriesId,
    drugId,
    observations: entries.map(({ observation }) => observation),
    exposureRows,
    sampleTimes: exposureRows.map(({ timeHours }) => timeHours),
  });
}

function quantity(value, unit) {
  return { value, unit };
}

/**
 * Derive a right-continuous piecewise-constant protocol from observation rows.
 * Concentration at time t applies from t until the next observation time. The
 * final endpoint therefore has to report the already-active concentration;
 * otherwise a protocol builder is required to disambiguate the terminal change.
 */
export function buildObservationProtocol(series) {
  record(series, "series");
  const seriesId = nonEmptyString(series.seriesId, "series.seriesId");
  const drugId = nonEmptyString(series.drugId, "series.drugId");
  if (!Array.isArray(series.exposureRows) || series.exposureRows.length < 2) {
    fail(
      "INSUFFICIENT_EXPOSURE_TIMES",
      `Series ${seriesId} requires observations at time zero and at least one later time.`,
      `series.${seriesId}.exposureRows`,
    );
  }
  const rows = series.exposureRows;
  if (Math.abs(rows[0].timeHours) > TIME_TOLERANCE_HOURS) {
    fail(
      "INITIAL_TIME_REQUIRED",
      `Series ${seriesId} requires an explicit time-zero observation; the initial latent state is never back-extrapolated.`,
      `series.${seriesId}.exposureRows[0].timeHours`,
      rows[0].timeHours,
    );
  }
  if (rows.at(-1).concentrationMgPerL !== rows.at(-2).concentrationMgPerL) {
    fail(
      "TERMINAL_EXPOSURE_AMBIGUOUS",
      `Series ${seriesId} changes concentration only at its final observation. Supply protocolBuilder to declare the intended boundary semantics.`,
      `series.${seriesId}.exposureRows`,
    );
  }
  const segments = rows.slice(0, -1).map((row, index) => ({
    start: quantity(row.timeHours, CANONICAL_UNITS.time),
    end: quantity(rows[index + 1].timeHours, CANONICAL_UNITS.time),
    concentration: quantity(row.concentrationMgPerL, CANONICAL_UNITS.concentration),
  }));
  return freeze({ kind: "piecewise_constant", drugId, segments });
}

function protocolBuilderFor(options, seriesId) {
  const builder = options.protocolBuilders?.[seriesId] ?? options.protocolBuilder;
  if (builder !== undefined && typeof builder !== "function") {
    fail("INVALID_PROTOCOL_BUILDER", "protocolBuilder must be a function.", "protocolBuilder", builder);
  }
  return builder;
}

function buildProtocol(descriptor, options, snapshot, overrides, context) {
  const builder = protocolBuilderFor(options, descriptor.seriesId);
  const protocol = builder
    ? builder(descriptor, Object.freeze({ resolvedModel: snapshot, overrides, context }))
    : buildObservationProtocol(descriptor);
  if (protocol && typeof protocol.then === "function") {
    fail("ASYNC_PROTOCOL_BUILDER_NOT_SUPPORTED", "protocolBuilder must be synchronous.", "protocolBuilder");
  }
  record(protocol, `series.${descriptor.seriesId}.protocol`);
  if (protocol.drugId !== descriptor.drugId) {
    fail(
      "PROTOCOL_DRUG_MISMATCH",
      `Protocol drugId ${String(protocol.drugId)} does not match series drugId ${descriptor.drugId}.`,
      `series.${descriptor.seriesId}.protocol.drugId`,
      protocol.drugId,
    );
  }
  return protocol;
}

function normalizeLatentState(state, path) {
  record(state, path);
  if (Object.hasOwn(state, "log10PopulationDensity")) {
    const value = finite(state.log10PopulationDensity, `${path}.log10PopulationDensity`);
    return freeze({ log10PopulationDensity: value });
  }
  if (Object.hasOwn(state, "populationDensity")) {
    const value = populationToLog10(state.populationDensity, `${path}.populationDensity`);
    return freeze({ log10PopulationDensity: value });
  }
  fail(
    "INITIAL_LATENT_STATE_REQUIRED",
    `${path} must explicitly contain log10PopulationDensity or populationDensity.`,
    path,
  );
}

function explicitInitialStates(options) {
  if (options.initialStates === undefined) return {};
  record(options.initialStates, "initialStates");
  const result = {};
  for (const [seriesId, state] of Object.entries(options.initialStates)) {
    nonEmptyString(seriesId, "initialStates key");
    if (UNSAFE_KEYS.has(seriesId)) fail("UNSAFE_OBJECT_KEY", `Unsafe series ID: ${seriesId}.`, `initialStates.${seriesId}`);
    result[seriesId] = normalizeLatentState(state, `initialStates.${seriesId}`);
  }
  return result;
}

function prepareSnapshot(options, seriesIds, overrides, context) {
  const contextual = context?.resolvedModel ?? context?.snapshot;
  const supplied = contextual ?? options.resolvedModel;
  record(supplied, "resolvedModel");
  record(supplied.parameters, "resolvedModel.parameters");
  const configuredInitialStates = explicitInitialStates(options);
  const snapshotInitialStates = supplied.initialStates === undefined
    ? {}
    : record(supplied.initialStates, "resolvedModel.initialStates");
  const prepared = {
    ...supplied,
    initialStates: contextual
      ? { ...configuredInitialStates, ...snapshotInitialStates }
      : { ...snapshotInitialStates, ...configuredInitialStates },
  };
  const normalizedOverrides = overrides ?? {};
  record(normalizedOverrides, "overrides");
  return applyParameterOverrides(prepared, normalizedOverrides, {
    initialStateSeriesIds: seriesIds,
  });
}

function stateForSeries(snapshot, options, seriesId, seriesCount) {
  const source = snapshot.initialStates?.[seriesId]
    ?? (seriesCount === 1 && options.initialState !== undefined ? options.initialState : undefined);
  if (source === undefined) {
    fail(
      "INITIAL_LATENT_STATE_REQUIRED",
      `An explicit initial latent state is required for series ${seriesId}.`,
      `initialStates.${seriesId}`,
    );
  }
  return normalizeLatentState(source, `initialStates.${seriesId}`);
}

function detectionLimitForSeries(options, seriesId, seriesCount) {
  const source = options.detectionLimits?.[seriesId]
    ?? (seriesCount === 1 ? options.detectionLimit : undefined)
    ?? options.sharedDetectionLimit;
  if (source === undefined || source === null) return null;
  const log10Value = populationToLog10(source, `detectionLimits.${seriesId}`);
  return freeze({
    log10PopulationDensity: log10Value,
    quantity: freeze({ value: log10Value, unit: CANONICAL_UNITS.population }),
  });
}

function detectionHandling(options) {
  const raw = options.detectionLimitHandling ?? options.detectionHandling ?? "latent";
  if (raw === "latent" || raw === "flag_only") return "latent";
  if (raw === "report_at_limit" || raw === "floor_at_limit" || raw === "substitute_limit") {
    return "report_at_limit";
  }
  fail(
    "INVALID_DETECTION_LIMIT_HANDLING",
    "detectionLimitHandling must be latent or report_at_limit.",
    "detectionLimitHandling",
    raw,
  );
}

function trajectoryAtTime(trajectory, timeHours, seriesId) {
  const row = trajectory.find((candidate) => Math.abs(candidate.timeHours - timeHours) <= TIME_TOLERANCE_HOURS);
  if (!row) {
    fail(
      "MISSING_TRAJECTORY_TIME",
      `Simulation for series ${seriesId} did not return time ${timeHours}.`,
      `series.${seriesId}.timeHours`,
      timeHours,
    );
  }
  return row;
}

function predictionForObservation(observation, row, options, metadata) {
  const latent = finite(row.latentLog10PopulationDensity, `${metadata.path}.latentLog10PopulationDensity`);
  const detection = metadata.detectionLimit;
  const belowDetectionLimit = detection !== null && latent < detection.log10PopulationDensity;
  if (metadata.detectionLimitHandling === "report_at_limit" && detection === null) {
    fail(
      "DETECTION_LIMIT_REQUIRED",
      "report_at_limit handling requires an explicit detection limit.",
      `${metadata.path}.detectionLimit`,
    );
  }
  const reportedLog10 = metadata.detectionLimitHandling === "report_at_limit" && belowDetectionLimit
    ? detection.log10PopulationDensity
    : latent;

  let predicted;
  if (observation.measurementType === "log10_cfu_per_ml") {
    predicted = reportedLog10;
  } else if (observation.measurementType === "cfu_per_ml") {
    predicted = 10 ** reportedLog10;
    finite(predicted, `${metadata.path}.predicted`);
  } else {
    const observationModel = options.odObservationModel ?? options.observationModel;
    if (typeof observationModel !== "function") {
      fail(
        "OD_OBSERVATION_MODEL_REQUIRED",
        `${observation.measurementType} observations require an explicit OD observation model callback; OD is never treated as CFU.`,
        `${metadata.path}.measurementType`,
      );
    }
    const linear = log10PopulationToLinear(latent);
    predicted = observationModel(reportedLog10, observation, freeze({
      seriesId: metadata.seriesId,
      observationIndex: metadata.observationIndex,
      latentLog10PopulationDensity: latent,
      latentCfuPerMl: linear.value,
      reportedLog10PopulationDensity: reportedLog10,
      belowDetectionLimit,
      detectionLimitLog10: detection?.log10PopulationDensity ?? null,
      resolvedModel: metadata.snapshot,
    }));
    finite(predicted, `${metadata.path}.observationModelPrediction`);
    if (predicted < 0) {
      fail("NEGATIVE_OD_PREDICTION", "OD observation model predictions cannot be negative.", metadata.path, predicted);
    }
  }

  return freeze({
    observationId: observation.observationId,
    seriesId: observation.seriesId,
    independentUnitId: observation.independentUnitId,
    timeHours: observation.timeHours,
    measurementType: observation.measurementType,
    predicted,
    latentLog10PopulationDensity: latent,
    reportedLog10PopulationDensity: reportedLog10,
    belowDetectionLimit,
    detectionLimitLog10: detection?.log10PopulationDensity ?? null,
  });
}

function evaluateEntries(entries, options, snapshot, overrides, context, seriesCount) {
  const descriptor = seriesDescriptor(entries);
  const state = stateForSeries(snapshot, options, descriptor.seriesId, seriesCount);
  const detectionLimit = detectionLimitForSeries(options, descriptor.seriesId, seriesCount);
  const handling = detectionHandling(options);
  const protocol = buildProtocol(descriptor, options, snapshot, overrides, context);
  const simulation = simulatePiecewise(snapshot, {
    protocol,
    sampleTimes: descriptor.sampleTimes.map((value) => quantity(value, CANONICAL_UNITS.time)),
    initialState: {
      populationDensity: quantity(state.log10PopulationDensity, CANONICAL_UNITS.population),
    },
    observation: detectionLimit ? { detectionLimit: detectionLimit.quantity } : {},
  });
  const predictionRecords = entries.map(({ observation, index }) =>
    predictionForObservation(
      observation,
      trajectoryAtTime(simulation.trajectory, observation.timeHours, descriptor.seriesId),
      options,
      {
        path: `observations[${index}]`,
        seriesId: descriptor.seriesId,
        observationIndex: index,
        detectionLimit,
        detectionLimitHandling: handling,
        snapshot,
      },
    ));
  const result = {
    schemaVersion: "1.0.0",
    kind: "analysis-observation-series-evaluation",
    seriesId: descriptor.seriesId,
    drugId: descriptor.drugId,
    observationCount: entries.length,
    initialState: state,
    detectionLimitHandling: handling,
    detectionLimitLog10: detectionLimit?.log10PopulationDensity ?? null,
    protocol: simulation.protocol,
    predictions: predictionRecords.map(({ predicted }) => predicted),
    predictionRecords,
    trajectory: simulation.trajectory,
    diagnostics: simulation.diagnostics,
  };
  return freeze(cloneJson(result));
}

/** Simulate one normalized observation series and return aligned predictions. */
export function evaluateObservationSeries(options) {
  record(options, "options");
  const observations = normalizeSeriesInput(options.observations ?? options.series);
  const entries = observations.map((observation, index) => ({ observation, index }));
  const descriptor = seriesDescriptor(entries);
  const overrides = freeze(cloneJson(options.overrides ?? {}, "overrides"));
  const snapshot = prepareSnapshot(options, [descriptor.seriesId], overrides, options.context ?? {});
  return evaluateEntries(entries, options, snapshot, overrides, options.context ?? {}, 1);
}

/** Simulate every series in a normalized dataset and preserve dataset observation order. */
export function evaluateObservationDataset(options) {
  record(options, "options");
  const dataset = normalizeObservationDataset(options.dataset);
  if (dataset.observations.length === 0) {
    fail("EMPTY_DATASET", "The observation dataset must contain at least one observation.", "dataset.observations");
  }
  const grouped = groupObservations(dataset.observations);
  const seriesIds = [...grouped.keys()];
  const overrides = freeze(cloneJson(options.overrides ?? {}, "overrides"));
  const context = options.context ?? {};
  const snapshot = prepareSnapshot(options, seriesIds, overrides, context);
  const predictions = Array(dataset.observations.length);
  const predictionRecords = Array(dataset.observations.length);
  const series = [];
  for (const entries of grouped.values()) {
    const evaluated = evaluateEntries(entries, options, snapshot, overrides, context, grouped.size);
    series.push(evaluated);
    entries.forEach(({ index }, seriesIndex) => {
      predictions[index] = evaluated.predictions[seriesIndex];
      predictionRecords[index] = evaluated.predictionRecords[seriesIndex];
    });
  }
  const result = {
    schemaVersion: "1.0.0",
    kind: "analysis-dataset-evaluation",
    datasetId: dataset.metadata.datasetId,
    observationCount: dataset.observations.length,
    seriesCount: series.length,
    predictions,
    predictionRecords,
    series,
  };
  return freeze(cloneJson(result));
}

/** Create the synchronous `(overrides, context)` adapter used by Stage 4 analyses. */
export function createObservationDatasetEvaluator(options) {
  record(options, "options");
  return (overrides = {}, context = {}) => evaluateObservationDataset({
    ...options,
    resolvedModel: context.resolvedModel ?? context.snapshot ?? options.resolvedModel,
    overrides,
    context,
  });
}

/** Create an evaluator that returns only the observation-aligned prediction array. */
export function createObservationPredictionEvaluator(options) {
  const evaluate = createObservationDatasetEvaluator(options);
  return (overrides = {}, context = {}) => evaluate(overrides, context).predictions;
}

function configuredSummary(options) {
  const callback = options.summarize ?? options.scalarSummary ?? options.summaryEvaluator;
  if (callback !== undefined) {
    if (typeof callback !== "function") {
      fail("INVALID_SUMMARY_CALLBACK", "summarize must be a function.", "summarize", callback);
    }
    return callback;
  }
  const summary = options.summary;
  record(summary, "summary");
  if (summary.kind === "prediction") {
    const observationId = nonEmptyString(summary.observationId, "summary.observationId");
    return (evaluation) => {
      const match = evaluation.predictionRecords.find((entry) => entry.observationId === observationId);
      if (!match) fail("SUMMARY_OBSERVATION_NOT_FOUND", `Unknown summary observationId: ${observationId}.`);
      return match.predicted;
    };
  }
  if (summary.kind === "final_prediction") {
    const seriesId = nonEmptyString(summary.seriesId, "summary.seriesId");
    return (evaluation) => {
      const matches = evaluation.predictionRecords.filter((entry) => entry.seriesId === seriesId);
      if (matches.length === 0) fail("SUMMARY_SERIES_NOT_FOUND", `Unknown summary seriesId: ${seriesId}.`);
      return matches.reduce((latest, entry) => entry.timeHours >= latest.timeHours ? entry : latest).predicted;
    };
  }
  if (summary.kind === "mean_prediction") {
    return (evaluation) => evaluation.predictions.reduce((sum, value) => sum + value, 0) / evaluation.predictions.length;
  }
  fail(
    "UNSUPPORTED_SCALAR_SUMMARY",
    "summary.kind must be prediction, final_prediction, or mean_prediction, or summarize must be supplied.",
    "summary.kind",
    summary.kind,
  );
}

/** Create a finite scalar evaluator suitable for scan, Monte Carlo, and sensitivity APIs. */
export function createScalarSummaryEvaluator(options) {
  record(options, "options");
  const evaluate = createObservationDatasetEvaluator(options);
  const summarize = configuredSummary(options);
  return (overrides = {}, context = {}) => {
    const evaluation = evaluate(overrides, context);
    const value = summarize(evaluation, freeze(cloneJson(overrides, "overrides")), context);
    if (value && typeof value.then === "function") {
      fail("ASYNC_SUMMARY_NOT_SUPPORTED", "Scalar summary callbacks must be synchronous.", "summarize");
    }
    return finite(value, "scalarSummary");
  };
}

export const evaluateNormalizedDataset = evaluateObservationDataset;
export const evaluateDatasetObservations = evaluateObservationDataset;
export const simulateObservationSeries = evaluateObservationSeries;
export const createModelEvaluator = createObservationDatasetEvaluator;
export const createDatasetEvaluator = createObservationDatasetEvaluator;
export const createPredictionEvaluator = createObservationPredictionEvaluator;
export const createDatasetPredictionEvaluator = createObservationPredictionEvaluator;
export const createScalarEvaluator = createScalarSummaryEvaluator;
export const createModelScalarEvaluator = createScalarSummaryEvaluator;
