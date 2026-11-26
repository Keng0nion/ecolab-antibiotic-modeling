// Ecolab kill-curve workflow: antibiotic time-kill data (log10 CFU/mL, left-censored
// below the detection limit, with a real t=0) can be imported, locked-split, fitted
// and validated entirely inside Ecolab.
//
// This module is a sibling of research-workflow.js (the OD600 Stage 4 workflow, which
// is intentionally left untouched). It reuses the generic compute modules:
// dataset-import.js (parsing), dataset-quality.js (QC), fingerprint.js, split.js
// (locked roles), fitting.js (fitParameters with censored Gaussian likelihood),
// likelihood.js (censoredGaussianLogLikelihood), parameter-space.js (whitelisted
// parameter names) and ../model.js (simulatePiecewise).
//
// Parameter names use the standard whitelist: psiMaxLog10PerHour,
// drugs.<drugId>.{zMicMgPerL,hillKappa,psiMinLog10PerHour},
// initialStates.pooled.log10PopulationDensity and errorSigmaLog10 (added additively
// to the global whitelist for the kill workflow's free error scale).
//
// Units: Ecolab rates are log10-fold/h internally. Foerster-style literature reports
// use ln/h; divide by ln(10) when comparing. kappa is unit-free; zMIC is mg/L.

import { advancePopulationAnalytically, evaluateRegoesNetGrowth, simulatePiecewise } from "../model.js";
import { importObservationDataset } from "./dataset-import.js";
import { assessDatasetQuality } from "./dataset-quality.js";
import { fingerprintJson } from "./fingerprint.js";
import { createDatasetSplit } from "./split.js";
import { fitParameters } from "./fitting.js";
import { censoredGaussianLogLikelihood } from "./likelihood.js";
import { createRandom, RNG_ALGORITHM } from "./random.js";
import {
  summarizeGaussianMixturePredictions,
  summarizeTemporalResidualTrends,
} from "./predictive-diagnostics.js";

export const KILL_WORKFLOW_KIND = "ecolab-kill-workflow";
export const KILL_MEASUREMENT_TYPE = "log10_cfu_per_ml";
export const KILL_INITIAL_STATE_SERIES = "pooled";

const DEFAULT_CARRYING_CAPACITY_LOG10 = 9.5;

export class KillWorkflowError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "KillWorkflowError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, path = null, actual = undefined) {
  throw new KillWorkflowError(code, message, { path, actual });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value, path) {
  if (!isRecord(value)) fail("INVALID_WORKFLOW_INPUT", `${path} must be a plain object.`, path, value);
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("INVALID_WORKFLOW_STRING", `${path} must be a non-empty string.`, path, value);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_WORKFLOW_NUMBER", `${path} must be a finite number.`, path, value);
  }
  return value;
}

function uint32(value, path) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    fail("INVALID_UINT32_SEED", `${path} must be an unsigned 32-bit integer.`, path, value);
  }
  return value;
}

function deriveSeed(seed, ...parts) {
  let h = seed >>> 0;
  for (const part of parts) {
    const text = String(part);
    for (let i = 0; i < text.length; i += 1) {
      h = (h ^ text.charCodeAt(i)) >>> 0;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  }
  return h >>> 0;
}

function requireCondition(container, key, path) {
  const value = container?.[key];
  if (value === undefined || value === null || value === "") {
    fail("MISSING_REQUIRED_CONDITION", `${path}.${key} is required.`, `${path}.${key}`);
  }
}

function killParameterNames(drugId) {
  return [
    "psiMaxLog10PerHour",
    `drugs.${drugId}.psiMinLog10PerHour`,
    `drugs.${drugId}.zMicMgPerL`,
    `drugs.${drugId}.hillKappa`,
    `initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`,
    "errorSigmaLog10",
  ];
}

function readParams(params, drugId) {
  return {
    psiMax: params.psiMaxLog10PerHour,
    psiMin: params[`drugs.${drugId}.psiMinLog10PerHour`],
    zMic: params[`drugs.${drugId}.zMicMgPerL`],
    kappa: params[`drugs.${drugId}.hillKappa`],
    n0: params[`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`],
    sigma: params.errorSigmaLog10,
  };
}

function reportParams(resolved, errors, drugId) {
  const p = readParams(resolved, drugId);
  const e = errors ?? {};
  return {
    fittedParameters: {
      psiMaxLog10PerHour: p.psiMax,
      psiMinLog10PerHour: p.psiMin,
      zMicMgPerL: p.zMic,
      hillKappa: p.kappa,
      initialLog10PopulationDensity: p.n0,
      sigmaLog10Residual: p.sigma,
    },
    standardErrors: {
      psiMaxLog10PerHour: e.psiMaxLog10PerHour ?? null,
      psiMinLog10PerHour: e[`drugs.${drugId}.psiMinLog10PerHour`] ?? null,
      zMicMgPerL: e[`drugs.${drugId}.zMicMgPerL`] ?? null,
      hillKappa: e[`drugs.${drugId}.hillKappa`] ?? null,
      initialLog10PopulationDensity: e[`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`] ?? null,
      sigmaLog10Residual: e.errorSigmaLog10 ?? null,
    },
  };
}

/**
 * Gates for kill-curve datasets. The OD600 workflow's OD-specific restrictions are
 * relaxed (drug exposure, log10 CFU measurements, left censoring, t=0 observations,
 * non-bundled dataset ids, predeclared output time = max source time). Every safety
 * check is kept: non-empty dataset, required conditions, role validity and
 * non-leakage, duplicate-time, complete-unit-trajectory, per-unit drug constancy,
 * at least two dose levels and at least one training plus one validation unit per
 * strain.
 */
export function assertKillDataset(dataset) {
  record(dataset, "dataset");
  record(dataset.metadata, "dataset.metadata");
  if (!Array.isArray(dataset.observations) || dataset.observations.length === 0) {
    fail("EMPTY_DATASET", "The dataset must contain observations.", "dataset.observations");
  }
  // CSV 导入的条件写在每条观测上；数据集级缺失时用首条观测的条件补齐
  const firstConditions = dataset.observations[0]?.conditions ?? {};
  const metadataConditions = record({ ...firstConditions, ...(dataset.metadata.conditions ?? {}) }, "dataset.metadata.conditions");
  for (const key of ["organism", "medium", "temperatureC"]) {
    requireCondition(metadataConditions, key, "dataset.metadata.conditions");
  }

  const times = new Set();
  const units = new Map();
  const strains = new Map();
  const strainTimes = new Map();
  const exposures = new Set();
  let sawExposure = false;

  dataset.observations.forEach((observation, index) => {
    const path = `dataset.observations[${index}]`;
    record(observation, path);
    if (observation.measurementType !== KILL_MEASUREMENT_TYPE) {
      fail("KILL_MEASUREMENT_TYPE_REQUIRED",
        `Kill-curve workflow requires every observation to be ${KILL_MEASUREMENT_TYPE}.`,
        `${path}.measurementType`, observation.measurementType);
    }
    if (observation.role !== "training" && observation.role !== "validation") {
      fail("INCOMPLETE_TRAINING_VALIDATION_ROLES",
        "Every observation must be assigned to training or validation.", `${path}.role`, observation.role);
    }
    const timeHours = finite(observation.timeHours, `${path}.timeHours`);
    if (timeHours < 0) fail("NEGATIVE_TIME_FORBIDDEN", "timeHours must be >= 0.", `${path}.timeHours`, timeHours);
    finite(observation.value, `${path}.value`);
    const censoring = observation.censoring ?? "none";
    if (censoring !== "none" && censoring !== "left") {
      fail("CENSORING_NOT_SUPPORTED",
        "Kill-curve workflow supports none or left censoring only.", `${path}.censoring`, censoring);
    }
    if (censoring === "left") {
      const bounds = record(observation.censoringBounds ?? {}, `${path}.censoringBounds`);
      finite(bounds.upper, `${path}.censoringBounds.upper`);
    }
    const drugId = nonEmptyString(observation.drugId, `${path}.drugId`);
    const concentration = finite(observation.concentrationMgPerL, `${path}.concentrationMgPerL`);
    if (concentration < 0) fail("NEGATIVE_CONCENTRATION", "concentrationMgPerL must be >= 0.", `${path}.concentrationMgPerL`, concentration);
    const conditions = record(observation.conditions ?? {}, `${path}.conditions`);
    for (const key of ["organism", "strain", "medium", "temperatureC", "treatment", "antibioticExposure"]) {
      requireCondition(conditions, key, `${path}.conditions`);
    }
    for (const key of ["organism", "medium", "temperatureC"]) {
      if (String(conditions[key]) !== String(metadataConditions[key])) {
        fail("DATASET_CONDITION_MISMATCH",
          `Observation ${key} must match the dataset-level condition.`, `${path}.conditions.${key}`, conditions[key]);
      }
    }
    exposures.add(String(conditions.antibioticExposure));
    if (conditions.antibioticExposure === true && drugId !== "none" && concentration > 0) sawExposure = true;

    const unitId = nonEmptyString(observation.independentUnitId, `${path}.independentUnitId`);
    const timeKey = String(timeHours);
    times.add(timeKey);
    if (!strainTimes.has(String(conditions.strain))) strainTimes.set(String(conditions.strain), new Set());
    strainTimes.get(String(conditions.strain)).add(timeKey);
    let unit = units.get(unitId);
    if (!unit) {
      unit = { independentUnitId: unitId, role: observation.role, timeKeys: new Set(), drugId, concentration, strain: String(conditions.strain) };
      units.set(unitId, unit);
      if (!strains.has(unit.strain)) strains.set(unit.strain, []);
      strains.get(unit.strain).push(unit);
    }
    if (unit.role !== observation.role) {
      fail("INDEPENDENT_UNIT_ROLE_LEAKAGE", `${unitId} appears in both training and validation.`, path, unitId);
    }
    if (unit.timeKeys.has(timeKey)) {
      fail("DUPLICATE_UNIT_TIME", `${unitId} contains duplicate observations at ${timeHours} h.`, path);
    }
    if (unit.drugId !== drugId || unit.concentration !== concentration) {
      fail("UNIT_DRUG_CONSTANCY", `${unitId} must keep one constant drug and concentration across its trajectory.`, path, {
        drugId: unit.drugId, concentration: unit.concentration, actual: { drugId, concentration },
      });
    }
    unit.timeKeys.add(timeKey);
  });

  if (exposures.size > 1) fail("DATASET_EXPOSURE_MISMATCH", "antibioticExposure must be consistent across the dataset.", "dataset.observations", [...exposures]);
  if (exposures.has("true") && !sawExposure) {
    fail("ANTIBIOTIC_EXPOSURE_MISSING", "antibioticExposure=true requires at least one unit with a non-zero drug concentration.", "dataset.observations");
  }

  const sourceTimes = [...times].map(Number).sort((a, b) => a - b);
  // Trajectory completeness is judged per strain: real experiments can miss a single
  // interior time point in one unit while its siblings observed it. A unit passes when
  // its times are a subset of its strain's grid, it starts at t=0, it reaches the
  // strain's last observed time, and it misses at most one interior point; the gap is
  // reported on the unit (and surfaced in the results) instead of failing the dataset.
  for (const unit of units.values()) {
    const strainSorted = [...(strainTimes.get(unit.strain) ?? [])].map(Number).sort((a, b) => a - b);
    const unknownTimes = [...unit.timeKeys].filter((t) => !strainSorted.includes(Number(t)));
    if (unknownTimes.length > 0) {
      fail("UNIT_TIME_NOT_IN_STRAIN_GRID", `${unit.independentUnitId} contains time points absent from its strain: ${unknownTimes.join(", ")}.`, "dataset.observations", unit.independentUnitId);
    }
    if (strainSorted[0] !== 0) {
      fail("INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY", `Strain ${unit.strain} has no t=0 observation; the kill workflow needs the pre-exposure baseline.`, "dataset.observations", unit.strain);
    }
    if (!unit.timeKeys.has("0")) {
      fail("INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY", `${unit.independentUnitId} is missing the t=0 baseline observation.`, "dataset.observations", unit.independentUnitId);
    }
    const strainLast = strainSorted.at(-1);
    if (!unit.timeKeys.has(String(strainLast))) {
      fail("INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY", `${unit.independentUnitId} is missing the final observation at ${strainLast} h.`, "dataset.observations", unit.independentUnitId);
    }
    const missing = strainSorted.filter((t) => t !== 0 && t !== strainLast && !unit.timeKeys.has(String(t)));
    if (missing.length > 1) {
      fail("INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY", `${unit.independentUnitId} is missing ${missing.length} interior observations (${missing.join(", ")} h); at most one interior gap is allowed.`, "dataset.observations", unit.independentUnitId);
    }
    if (missing.length === 1) unit.missingTimes = missing;
  }
  let trainingUnitCount = 0;
  let validationUnitCount = 0;
  for (const unit of units.values()) {
    if (unit.role === "training") trainingUnitCount += 1;
    else validationUnitCount += 1;
  }
  if (trainingUnitCount === 0 || validationUnitCount === 0) {
    fail("INCOMPLETE_TRAINING_VALIDATION_ROLES", "At least one complete training unit and one complete validation unit are required.", "dataset.observations", { trainingUnitCount, validationUnitCount });
  }
  for (const [strain, strainUnits] of strains) {
    const concentrations = new Set(strainUnits.map((unit) => unit.concentration));
    if (concentrations.size < 2) {
      fail("MIN_DOSE_LEVELS_PER_STRAIN", `Strain ${strain} needs at least two distinct concentrations for a dose-response fit.`, "dataset.observations", { strain, concentrations: [...concentrations] });
    }
    const roles = new Set(strainUnits.map((unit) => unit.role));
    if (!roles.has("training") || !roles.has("validation")) {
      fail("STRAIN_SPLIT_INCOMPLETE", `Strain ${strain} needs at least one training and one validation unit.`, "dataset.observations", { strain });
    }
  }
  return {
    sourceTimes,
    maximumTimeHours: sourceTimes.at(-1),
    units,
    strains,
    incompleteUnits: [...units.values()]
      .filter((unit) => unit.missingTimes?.length)
      .map((unit) => ({ independentUnitId: unit.independentUnitId, strain: unit.strain, missingTimes: unit.missingTimes })),
    trainingUnitCount,
    validationUnitCount,
  };
}

function syntheticModel(params, drugId, carryingCapacityLog10) {
  const p = readParams(params, drugId);
  // NM 精修可能提出边界外的试探值（如负 zMIC）；钳到极小正值，让似然给出罚而不是抛错
  const zMic = Math.max(p.zMic, 1e-12);
  return {
    ref: {
      modelId: "ecolab.single-population.regoes-logistic",
      modelVersion: "1.0.0",
      parameterSetId: "kill-workflow-fit",
      parameterSetVersion: "in-memory",
    },
    warnings: [],
    parameters: {
      psiMaxLog10PerHour: p.psiMax,
      carryingCapacityLog10CfuPerMl: carryingCapacityLog10,
      drugs: {
        [drugId]: {
          zMicMgPerL: zMic,
          hillKappa: p.kappa,
          psiMinLog10PerHour: p.psiMin,
        },
      },
    },
  };
}

function killPredictions(params, observations, context) {
  const model = syntheticModel(params, context.drugId, context.carryingCapacityLog10);
  const byUnit = new Map();
  observations.forEach((observation, index) => {
    if (!byUnit.has(observation.independentUnitId)) byUnit.set(observation.independentUnitId, []);
    byUnit.get(observation.independentUnitId).push(index);
  });
  const predictions = new Array(observations.length);
  for (const [unitId, indexes] of byUnit) {
    const unit = context.units.get(unitId);
    if (!unit) fail("UNKNOWN_UNIT", `Unknown independentUnitId ${unitId}.`, "observations", unitId);
    const unitTimes = [...unit.timeKeys].map(Number).sort((a, b) => a - b);
    const sampleTimes = (unitTimes.includes(0) ? unitTimes : [0, ...unitTimes]).map((value) => ({ value, unit: "h" }));
    const simulation = simulatePiecewise(model, {
      protocol: {
        kind: "piecewise_constant",
        drugId: unit.drugId,
        segments: [{
          start: { value: 0, unit: "h" },
          end: { value: context.maximumTimeHours, unit: "h" },
          concentration: { value: unit.concentration, unit: "mg/L" },
        }],
      },
      sampleTimes,
      initialState: {
        populationDensity: { value: 10 ** readParams(params, context.drugId).n0, unit: "CFU/mL" },
      },
    });
    const byTime = new Map(simulation.trajectory.map((row) => [row.timeHours, row.latentLog10PopulationDensity]));
    for (const index of indexes) {
      const time = observations[index].timeHours;
      const value = byTime.get(time);
      if (value === undefined) fail("SIMULATION_TIME_MISSING", `The simulator did not return exact time ${time} h.`, "observations", time);
      predictions[index] = value;
    }
  }
  return predictions;
}

function negativeLogLikelihood(params, observations, context) {
  const sigma = readParams(params, context.drugId).sigma;
  const predictions = killPredictions(params, observations, context);
  let total = 0;
  for (let index = 0; index < observations.length; index += 1) {
    total -= censoredGaussianLogLikelihood(observations[index], predictions[index], sigma);
  }
  return total;
}

function invertMatrix(matrix) {
  const n = matrix.length;
  const a = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-12) return null;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const pivotValue = a[col][col];
    for (let j = col; j < 2 * n; j += 1) a[col][j] /= pivotValue;
    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j < 2 * n; j += 1) a[row][j] -= factor * a[col][j];
    }
  }
  return a.map((row) => row.slice(n));
}

function standardErrors(fit, names, observations, context) {
  const center = fit.resolvedParameters;
  const errors = Object.fromEntries(names.map((name) => [name, null]));
  const interior = names.flatMap((name) => {
    const value = center[name];
    const [lower, upper] = fit.bounds[name];
    const margin = Math.min(value - lower, upper - value);
    const step = Math.min(1e-4 * Math.max(1, Math.abs(value)), margin * 0.24);
    if (!Number.isFinite(step) || step <= 1e-8 * Math.max(1, Math.abs(value))) return [];
    return [{ name, step }];
  });
  if (interior.length === 0) return errors;

  const hessian = interior.map(({ name: nameI, step: hI }) => interior.map(({ name: nameJ, step: hJ }) => {
    const pp = { ...center }; pp[nameI] += hI; pp[nameJ] += hJ;
    const pm = { ...center }; pm[nameI] += hI; pm[nameJ] -= hJ;
    const mp = { ...center }; mp[nameI] -= hI; mp[nameJ] += hJ;
    const mm = { ...center }; mm[nameI] -= hI; mm[nameJ] -= hJ;
    return (
      negativeLogLikelihood(pp, observations, context)
      - negativeLogLikelihood(pm, observations, context)
      - negativeLogLikelihood(mp, observations, context)
      + negativeLogLikelihood(mm, observations, context)
    ) / (4 * hI * hJ);
  }));
  const inverse = invertMatrix(hessian);
  if (!inverse) return errors;
  interior.forEach(({ name }, index) => {
    const variance = inverse[index][index];
    errors[name] = Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : null;
  });
  return errors;
}

function validationMetrics(observations, predictions) {
  const exact = [];
  let censoredTotal = 0;
  let censoredHit = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const prediction = predictions[index];
    const censoring = observation.censoring ?? "none";
    if (censoring === "left") {
      censoredTotal += 1;
      const upper = observation.censoringBounds?.upper;
      if (typeof upper === "number" && prediction < upper) censoredHit += 1;
    } else {
      exact.push(observation.value - prediction);
    }
  }
  const rmse = exact.length ? Math.sqrt(exact.reduce((sum, r) => sum + r * r, 0) / exact.length) : null;
  const mae = exact.length ? exact.reduce((sum, r) => sum + Math.abs(r), 0) / exact.length : null;
  const bias = exact.length ? exact.reduce((sum, r) => sum + r, 0) / exact.length : null;
  return {
    exactObservationCount: exact.length,
    rmseLog10: rmse,
    maeLog10: mae,
    biasLog10: bias,
    censoredObservationCount: censoredTotal,
    censoredPredictionHitRate: censoredTotal ? censoredHit / censoredTotal : null,
    temporalResidualDiagnostics: summarizeTemporalResidualTrends({ observations, predictions }),
  };
}

function percentile(sorted, q) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
}

const PROFILE_LIKELIHOOD_95_DELTA = 1.920729410347062;
const PROFILE_MONOTONICITY_TOLERANCE = 0.05;

export function classifyKillProfile(points, tolerance = PROFILE_MONOTONICITY_TOLERANCE) {
  const usable = points.filter((point) => point.converged !== false)
    .sort((a, b) => a.value - b.value);
  if (usable.length < 3) return { status: "lower-unidentified", trend: "insufficient_profile_points", usablePointCount: usable.length };
  const values = usable.map((point) => point.negativeLogLikelihood);
  const differences = values.slice(1).map((value, index) => value - values[index]);
  const nondecreasing = differences.every((difference) => difference >= -tolerance);
  const nonincreasing = differences.every((difference) => difference <= tolerance);
  const range = Math.max(...values) - Math.min(...values);
  const flat = range <= tolerance;
  const minValue = Math.min(...values);
  const minima = values.flatMap((value, index) => Math.abs(value - minValue) <= tolerance ? [index] : []);
  const atLower = minima.includes(0);
  const atUpper = minima.includes(values.length - 1);
  if (atLower && nondecreasing) {
    return { status: "lower-unidentified", trend: flat ? "flat" : "monotone_increasing_from_lower_limit", usablePointCount: usable.length };
  }
  if (atUpper && nonincreasing) {
    return { status: "upper-unidentified", trend: flat ? "flat" : "monotone_decreasing_to_upper_limit", usablePointCount: usable.length };
  }
  const interiorMinimum = minima.some((index) => index > 0 && index < values.length - 1);
  if (interiorMinimum && values[0] - minValue > tolerance && values.at(-1) - minValue > tolerance) {
    return { status: "identified", trend: "interior_profile_minimum", usablePointCount: usable.length };
  }
  return atUpper && !atLower
    ? { status: "upper-unidentified", trend: "best_supported_at_upper_limit", usablePointCount: usable.length }
    : { status: "lower-unidentified", trend: "best_supported_at_lower_limit_or_profile_flat", usablePointCount: usable.length };
}

function profileCutoffBound(points, status, threshold) {
  const compatible = points.filter((point) => point.deltaNegativeLogLikelihood <= threshold)
    .sort((a, b) => a.value - b.value);
  if (!compatible.length) return null;
  const edge = status === "lower-unidentified" ? compatible.at(-1) : compatible[0];
  const outside = points.filter((point) => status === "lower-unidentified"
    ? point.value > edge.value && point.deltaNegativeLogLikelihood > threshold
    : point.value < edge.value && point.deltaNegativeLogLikelihood > threshold)
    .sort((a, b) => Math.abs(a.value - edge.value) - Math.abs(b.value - edge.value))[0];
  if (!outside) return edge.value;
  const a = edge;
  const b = outside;
  const fraction = (threshold - a.deltaNegativeLogLikelihood)
    / (b.deltaNegativeLogLikelihood - a.deltaNegativeLogLikelihood);
  return a.value + fraction * (b.value - a.value);
}

function profileCompatibleRange(points, threshold) {
  const usable = points.filter((point) => point.converged !== false)
    .sort((a, b) => a.value - b.value);
  if (!usable.length) return { lower: null, upper: null, status: "no_converged_profile_points" };
  const minimumIndex = usable.reduce((best, point, index) =>
    point.deltaNegativeLogLikelihood < usable[best].deltaNegativeLogLikelihood ? index : best, 0);
  const crossing = (direction) => {
    let index = minimumIndex;
    while (true) {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= usable.length) break;
      const inside = usable[index];
      const outside = usable[nextIndex];
      const insideCompatible = inside.deltaNegativeLogLikelihood <= threshold;
      const outsideCompatible = outside.deltaNegativeLogLikelihood <= threshold;
      if (insideCompatible && !outsideCompatible) {
        const fraction = (threshold - inside.deltaNegativeLogLikelihood)
          / (outside.deltaNegativeLogLikelihood - inside.deltaNegativeLogLikelihood);
        return inside.value + fraction * (outside.value - inside.value);
      }
      if (!outsideCompatible) return null;
      index = nextIndex;
    }
    return null;
  };
  const lowCompatible = usable[0].deltaNegativeLogLikelihood <= threshold;
  const highCompatible = usable.at(-1).deltaNegativeLogLikelihood <= threshold;
  return {
    lower: lowCompatible ? null : crossing(-1),
    upper: highCompatible ? null : crossing(1),
    lowerSearchLimitCompatible: lowCompatible,
    upperSearchLimitCompatible: highCompatible,
    threshold,
  };
}

// ---------------------------------------------------------------------------
// Per-concentration-group net-growth-rate identifiability
//
// A kill-curve strain fit shares psiMax, psiMin, zMIC and kappa across all of its
// concentration groups. That joint fit can be well identified while an individual
// group carries no information about the *rate* it was run at. The clearest case is
// a group that reaches the detection limit at the first post-baseline sample and
// stays there: every later observation is left-censored, so the likelihood is flat
// for any faster kill and only bounds psi(C) from above. The group then contributes
// no information about the growth rate, and quoting a point estimate for it makes
// derived tables (for example a per-strain parameter table) internally inconsistent.
//
// The diagnostic below profiles psi(C) itself, conditional on the strain-level N0
// and residual scale, using the same censored Gaussian likelihood as the fit. It
// reuses classifyKillProfile so the verdict uses one monotonicity rule for both the
// strain-level and the group-level profiles.
// ---------------------------------------------------------------------------
const UNIT_NET_GROWTH_BOUNDS = Object.freeze([-5, 2]);
const UNIT_NET_GROWTH_STEP = 0.1;
const DETECTION_LIMIT_TOLERANCE = 1e-9;
const MINIMUM_UNCENSORED_POST_BASELINE_OBSERVATIONS = 2;
const UNIT_IDENTIFIABILITY_CRITERION = "require at least two uncensored post-baseline observations above the detection limit; eligible groups profile psi(C) over [-5, 2] log10-fold/h in 0.1 steps, conditional on the strain-level N0 and residual sigma, with the same monotonicity rule and 0.05 NLL tolerance as the strain-level profiles";

function unitDetectionLimitLog10(observations) {
  const limits = observations
    .filter((observation) => observation.censoring === "left")
    .map((observation) => observation.censoringBounds?.upper)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return limits.length ? Math.max(...limits) : null;
}

function observationAtDetectionLimit(observation, limit) {
  if (limit === null) return false;
  if (observation.censoring === "left") {
    const upper = observation.censoringBounds?.upper;
    return typeof upper !== "number" || upper <= limit + DETECTION_LIMIT_TOLERANCE;
  }
  return observation.value <= limit + DETECTION_LIMIT_TOLERANCE;
}

function unitNetGrowthProfile(observations, options) {
  const {
    initialLog10PopulationDensity,
    sigmaLog10Residual,
    carryingCapacityLog10,
    detectionLimit,
    treatExactAtLimitAsCensored,
  } = options;
  const effective = observations.map((observation) => (
    treatExactAtLimitAsCensored
      && observation.censoring !== "left"
      && detectionLimit !== null
      && observation.value <= detectionLimit + DETECTION_LIMIT_TOLERANCE
      ? { ...observation, censoring: "left", censoringBounds: { upper: detectionLimit } }
      : observation
  ));
  const points = [];
  for (let index = 0; ; index += 1) {
    const psi = UNIT_NET_GROWTH_BOUNDS[0] + index * UNIT_NET_GROWTH_STEP;
    if (psi > UNIT_NET_GROWTH_BOUNDS[1] + 1e-9) break;
    let negativeLogLikelihood = 0;
    for (const observation of effective) {
      const prediction = observation.timeHours === 0
        ? initialLog10PopulationDensity
        : advancePopulationAnalytically(
          initialLog10PopulationDensity,
          psi,
          observation.timeHours,
          carryingCapacityLog10,
        );
      negativeLogLikelihood -= censoredGaussianLogLikelihood(observation, prediction, sigmaLog10Residual);
    }
    points.push({
      value: Number(psi.toFixed(10)),
      negativeLogLikelihood,
      converged: true,
    });
  }
  const minimum = Math.min(...points.map((point) => point.negativeLogLikelihood));
  const profile = points.map((point) => ({
    ...point,
    deltaNegativeLogLikelihood: Math.max(0, point.negativeLogLikelihood - minimum),
  }));
  const identifiability = classifyKillProfile(profile);
  const compatibleRange95 = profileCompatibleRange(profile, PROFILE_LIKELIHOOD_95_DELTA);
  const bestPoint = profile.reduce((best, point) => (
    point.deltaNegativeLogLikelihood < best.deltaNegativeLogLikelihood ? point : best
  ));
  return {
    status: identifiability.status,
    trend: identifiability.trend,
    compatibleRange95,
    estimate: identifiability.status === "identified" ? bestPoint.value : null,
    oneSided95Bound: identifiability.status === "identified"
      ? null
      : profileCutoffBound(profile, identifiability.status, PROFILE_LIKELIHOOD_95_DELTA),
  };
}

/**
 * Identifiability of the net growth rate psi(C) from one concentration group.
 *
 * `context` must supply the strain-level fit (`drugId`, `modelParameters`,
 * `initialLog10PopulationDensity`, `sigmaLog10Residual`) and the workflow's
 * `carryingCapacityLog10`. The group's own observations are the only data used to
 * profile psi(C); the other parameters stay fixed at the strain fit. The verdict is
 * the conservative combination of the declared censoring and the at-limit reading,
 * so a value recorded as exact but sitting on the detection limit cannot be used to
 * claim an identified rate.
 */
export function unitGrowthRateIdentifiability(unitObservations, context) {
  const { drugId, modelParameters, carryingCapacityLog10 } = context;
  const sorted = [...unitObservations].sort((a, b) => a.timeHours - b.timeHours);
  const concentration = sorted[0].concentrationMgPerL;
  const detectionLimit = unitDetectionLimitLog10(sorted);
  const postBaseline = sorted.filter((observation) => observation.timeHours > 0);
  const atLimit = postBaseline.filter((observation) => observationAtDetectionLimit(observation, detectionLimit));
  const exactAtLimitCount = postBaseline.filter((observation) => (
    observation.censoring !== "left"
    && detectionLimit !== null
    && observation.value <= detectionLimit + DETECTION_LIMIT_TOLERANCE
  )).length;
  const informativeExactPostBaseline = postBaseline.filter((observation) => (
    observation.censoring !== "left"
    && !observationAtDetectionLimit(observation, detectionLimit)
  ));
  const allPostBaselineAtLimit = detectionLimit !== null
    && postBaseline.length > 0
    && postBaseline.every((observation) => observationAtDetectionLimit(observation, detectionLimit));
  if (informativeExactPostBaseline.length < MINIMUM_UNCENSORED_POST_BASELINE_OBSERVATIONS) {
    return {
      independentUnitId: sorted[0].independentUnitId,
      concentrationMgPerL: concentration,
      role: sorted[0].role,
      observationCount: sorted.length,
      postBaselineObservationCount: postBaseline.length,
      uncensoredPostBaselineObservationCount: informativeExactPostBaseline.length,
      minimumUncensoredPostBaselineObservationCount: MINIMUM_UNCENSORED_POST_BASELINE_OBSERVATIONS,
      censoredObservationCount: postBaseline.filter((observation) => observation.censoring === "left").length,
      exactAtDetectionLimitCount: exactAtLimitCount,
      detectionLimitLog10: detectionLimit,
      modelNetGrowthRateLog10PerHour: null,
      status: "NOT_IDENTIFIABLE",
      basis: allPostBaselineAtLimit ? "all_post_baseline_observations_at_detection_limit" : "insufficient_uncensored_observations",
      unitProfileEstimateLog10PerHour: null,
      relation: null,
      oneSided95Bound: null,
      compatibleRange95: { lower: null, upper: null },
      modelWithinUnitSupport95: null,
      declaredCensoringStatus: "NOT_IDENTIFIABLE",
      exactAtLimitCensoredStatus: null,
      criterion: UNIT_IDENTIFIABILITY_CRITERION,
    };
  }
  const profileOptions = {
    initialLog10PopulationDensity: context.initialLog10PopulationDensity,
    sigmaLog10Residual: context.sigmaLog10Residual,
    carryingCapacityLog10,
    detectionLimit,
  };
  const declared = unitNetGrowthProfile(sorted, { ...profileOptions, treatExactAtLimitAsCensored: false });
  // A value recorded as exact but sitting on the unit's detection limit cannot be
  // distinguished from a censored observation. The at-limit reading is reported as a
  // sensitivity, and the conservative verdict is the one carried into `status`.
  const atLimitCensored = exactAtLimitCount > 0
    ? unitNetGrowthProfile(sorted, { ...profileOptions, treatExactAtLimitAsCensored: true })
    : null;
  const candidates = [declared, atLimitCensored].filter(Boolean);
  const unresolved = candidates.find((candidate) => candidate.status !== "identified");
  const status = unresolved ? unresolved.status : "identified";
  const chosen = unresolved ?? declared;
  const basis = status === "identified" ? "profile_interior_minimum"
    : allPostBaselineAtLimit ? "all_post_baseline_observations_at_detection_limit"
      : exactAtLimitCount > 0 && declared.status === "identified" ? "exact_observation_at_detection_limit"
        : "profile_without_interior_minimum";
  const modelNetGrowthRate = evaluateRegoesNetGrowth(modelParameters, drugId, concentration);
  // Union of both readings: a model value is only called incompatible when neither
  // reading of the group's own data can accommodate it.
  const supports = [declared.compatibleRange95, atLimitCensored?.compatibleRange95].filter(Boolean);
  const support = {
    lower: supports.some((range) => range.lower === null) ? null : Math.min(...supports.map((range) => range.lower)),
    upper: supports.some((range) => range.upper === null) ? null : Math.max(...supports.map((range) => range.upper)),
  };
  const modelWithinUnitSupport95 = (support.lower === null || modelNetGrowthRate >= support.lower)
    && (support.upper === null || modelNetGrowthRate <= support.upper);
  return {
    independentUnitId: sorted[0].independentUnitId,
    concentrationMgPerL: concentration,
    role: sorted[0].role,
    observationCount: sorted.length,
    postBaselineObservationCount: postBaseline.length,
    uncensoredPostBaselineObservationCount: informativeExactPostBaseline.length,
    minimumUncensoredPostBaselineObservationCount: MINIMUM_UNCENSORED_POST_BASELINE_OBSERVATIONS,
    censoredObservationCount: postBaseline.filter((observation) => observation.censoring === "left").length,
    exactAtDetectionLimitCount: exactAtLimitCount,
    detectionLimitLog10: detectionLimit,
    modelNetGrowthRateLog10PerHour: modelNetGrowthRate,
    status,
    basis,
    unitProfileEstimateLog10PerHour: chosen.estimate,
    relation: status === "identified" ? null : status === "lower-unidentified" ? "≤" : "≥",
    oneSided95Bound: chosen.oneSided95Bound,
    compatibleRange95: { lower: support.lower, upper: support.upper },
    modelWithinUnitSupport95,
    declaredCensoringStatus: declared.status,
    exactAtLimitCensoredStatus: atLimitCensored?.status ?? null,
    criterion: UNIT_IDENTIFIABILITY_CRITERION,
  };
}

function profileCoordinates(value, transform) {
  return transform === "log" ? Math.log(value)
    : transform === "negative_log" ? Math.log(-value)
      : value;
}

function profileModelValue(value, transform) {
  return transform === "log" ? Math.exp(value)
    : transform === "negative_log" ? -Math.exp(value)
      : value;
}

function profileLikelihood(fit, fitOptions, names, targetNames, seed, strain, pointCount) {
  const profiles = {};
  for (const targetName of targetNames) {
    const nuisanceNames = names.filter((name) => name !== targetName);
    const transform = targetName.endsWith("psiMinLog10PerHour") ? "negative_log" : "log";
    const [lower, upper] = fit.bounds[targetName];
    const coordinateLower = profileCoordinates(
      transform === "negative_log" ? upper : lower,
      transform,
    );
    const coordinateUpper = profileCoordinates(
      transform === "negative_log" ? lower : upper,
      transform,
    );
    const fittedCoordinate = profileCoordinates(fit.resolvedParameters[targetName], transform);
    const coordinates = new Set([coordinateLower, coordinateUpper, fittedCoordinate]);
    for (let index = 1; index < pointCount - 1; index += 1) {
      coordinates.add(coordinateLower + (coordinateUpper - coordinateLower) * index / (pointCount - 1));
    }
    // The full transformed bounds can span many orders of magnitude. Add a
    // geometric local grid around the optimum so narrow 95% profile crossings
    // are not reduced to the single fitted point on a coarse global grid.
    for (const offset of [0.005, 0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28]) {
      for (const direction of [-1, 1]) {
        const coordinate = fittedCoordinate + direction * offset;
        if (coordinate > Math.min(coordinateLower, coordinateUpper)
          && coordinate < Math.max(coordinateLower, coordinateUpper)) coordinates.add(coordinate);
      }
    }
    const sortedCoordinates = [...coordinates].sort((a, b) => a - b);
    const points = sortedCoordinates.map((coordinate, index) => {
      const value = profileModelValue(coordinate, transform);
      const refit = fitParameters({
        ...fitOptions,
        parameterWhitelist: nuisanceNames,
        initialParameters: fit.resolvedParameters,
        fixedParameters: { ...fit.resolvedParameters, [targetName]: value },
        optimizationTransforms: Object.fromEntries(
          Object.entries(fitOptions.optimizationTransforms ?? {}).filter(([name]) => name !== targetName),
        ),
        restarts: 1,
        differentialEvolution: { populationSize: 16, maxEvaluations: 1000, tolerance: 1e-3, objectiveTolerance: 1e-4 },
        nelderMead: { maxEvaluations: 1200 },
        seed: deriveSeed(seed, "profile", strain, targetName, index),
      });
      return {
        value,
        negativeLogLikelihood: refit.objectiveValue,
        converged: refit.converged,
        terminationReason: refit.optimization?.terminationReason ?? null,
      };
    });
    const minimum = Math.min(...points.map(({ negativeLogLikelihood }) => negativeLogLikelihood));
    const nonConvergedPointCount = points.filter(({ converged }) => !converged).length;
    const profileStatus = nonConvergedPointCount === 0 ? "ASSESSED" : "NOT_ASSESSED";
    const likelihoodProfile = points.map(({ value, negativeLogLikelihood, converged, terminationReason }) => ({
      value,
      negativeLogLikelihood,
      deltaNegativeLogLikelihood: Math.max(0, negativeLogLikelihood - minimum),
      converged,
      terminationReason,
    })).sort((a, b) => a.value - b.value);
    const classifiedIdentifiability = classifyKillProfile(likelihoodProfile);
    const identifiability = profileStatus === "ASSESSED"
      ? classifiedIdentifiability
      : { status: "NOT_ASSESSED", trend: "profile_refit_nonconvergence", reason: "profile_refits_not_all_converged" };
    const compatibleRange95 = profileCompatibleRange(likelihoodProfile, PROFILE_LIKELIHOOD_95_DELTA);
    const endpointsCompatible = likelihoodProfile[0].deltaNegativeLogLikelihood <= PROFILE_LIKELIHOOD_95_DELTA
      && likelihoodProfile.at(-1).deltaNegativeLogLikelihood <= PROFILE_LIKELIHOOD_95_DELTA;
    const objectiveAtFitEstimate = likelihoodProfile.reduce((closest, point) =>
      Math.abs(point.value - fit.resolvedParameters[targetName]) < Math.abs(closest.value - fit.resolvedParameters[targetName])
        ? point
        : closest);
    const profileImprovement = fit.objectiveValue - minimum;
    profiles[targetName] = {
      status: profileStatus,
      ...(profileStatus === "NOT_ASSESSED" ? { reason: "profile_refits_not_all_converged" } : {}),
      points: likelihoodProfile,
      mainFitObjective: fit.objectiveValue,
      profileMinimumObjective: minimum,
      profileImprovementOverMainFit: profileImprovement,
      profileObjectiveAtMainEstimate: objectiveAtFitEstimate.negativeLogLikelihood,
      mainEstimateWithinProfile95: objectiveAtFitEstimate.deltaNegativeLogLikelihood <= PROFILE_LIKELIHOOD_95_DELTA,
      nonConvergedPointCount,
      likelihoodRatioThreshold95: PROFILE_LIKELIHOOD_95_DELTA,
      compatibleValues95: likelihoodProfile
        .filter(({ deltaNegativeLogLikelihood }) => deltaNegativeLogLikelihood <= PROFILE_LIKELIHOOD_95_DELTA)
        .map(({ value }) => value),
      profileCompatibleRange95: compatibleRange95,
      identifiability: {
        ...identifiability,
        criterion: "monotonicity of the converged profile-likelihood points over the full allowed parameter interval; tolerance is 0.05 NLL units",
        oneSided95Bound: identifiability.status === "identified" || identifiability.status === "NOT_ASSESSED"
          ? null
          : profileCutoffBound(likelihoodProfile, identifiability.status, PROFILE_LIKELIHOOD_95_DELTA),
        likelihoodRatioThreshold95: PROFILE_LIKELIHOOD_95_DELTA,
      },
      assessment: profileImprovement > 1e-4
        ? "profile_refit_found_better_objective_than_main_fit"
        : nonConvergedPointCount > 0 ? "profile_refits_not_all_converged"
        : endpointsCompatible ? "weakly_identified_across_fitted_bounds" : "profile_excludes_at_least_one_bound",
    };
  }
  return profiles;
}

/**
 * Bootstrap 95% confidence intervals over training units (resample whole
 * independent units with replacement, refit warm-started from the main fit).
 * Deterministic via the app's seeded RNG.
 */
function bootstrapIntervals(fit, names, training, fitOptions, context, strain) {
  const replicates = context.bootstrapReplicates;
  if (!Number.isInteger(replicates) || replicates < 2) return null;
  const rng = createRandom(deriveSeed(context.seed, "bootstrap", strain));
  const byUnit = new Map();
  for (const observation of training) {
    if (!byUnit.has(observation.independentUnitId)) byUnit.set(observation.independentUnitId, []);
    byUnit.get(observation.independentUnitId).push(observation);
  }
  const unitIds = [...byUnit.keys()];
  const interiorSamples = [];
  const convergedSamples = [];
  let optimizerConvergedReplicates = 0;
  let boundaryReplicates = 0;
  let attemptedReplicates = 0;
  const terminationReasons = {};
  const maximumAttemptsMultiplier = Number.isInteger(context.bootstrapMaxAttemptsMultiplier)
    ? Math.max(3, Math.min(20, context.bootstrapMaxAttemptsMultiplier))
    : 3;
  const maximumAttempts = replicates * maximumAttemptsMultiplier;
  for (let b = 0; b < maximumAttempts && interiorSamples.length < replicates; b += 1) {
    attemptedReplicates += 1;
    const picked = unitIds.map(() => unitIds[Math.floor(rng.next() * unitIds.length)]);
    const obs = picked.flatMap((id) => byUnit.get(id));
    const refit = fitParameters({
      ...fitOptions,
      observations: obs,
      initialParameters: context.bootstrapStartingParametersByStrain?.[strain] ?? fit.resolvedParameters,
      restarts: 1,
      differentialEvolution: { populationSize: 16, maxEvaluations: 1000, tolerance: 1e-3, objectiveTolerance: 1e-4 },
      nelderMead: { maxEvaluations: 1600 },
      seed: deriveSeed(context.seed, "bootstrap", strain, b),
    });
    if (refit.converged) {
      optimizerConvergedReplicates += 1;
      convergedSamples.push(refit.resolvedParameters);
      const atBoundary = names.some((name) => {
        const [lower, upper] = fit.bounds[name];
        const tolerance = Math.max((upper - lower) * 1e-5, Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)) * 8);
        const value = refit.resolvedParameters[name];
        return value <= lower + tolerance || value >= upper - tolerance;
      });
      if (atBoundary) boundaryReplicates += 1;
      else interiorSamples.push(refit.resolvedParameters);
    }
    const reason = refit.optimization?.terminationReason ?? "unknown";
    terminationReasons[reason] = (terminationReasons[reason] ?? 0) + 1;
  }
  const intervals = {};
  const boundaryFractions = {};
  for (const name of names) {
    const [lower, upper] = fit.bounds[name];
    const tolerance = Math.max((upper - lower) * 1e-5, Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)) * 8);
    boundaryFractions[name] = convergedSamples.length
      ? convergedSamples.filter((sample) => sample[name] <= lower + tolerance || sample[name] >= upper - tolerance).length / convergedSamples.length
      : null;
  }
  if (interiorSamples.length >= replicates) {
    for (const name of names) {
      const values = interiorSamples.map((s) => s[name]).sort((a, b) => a - b);
      intervals[name] = [percentile(values, 0.025), percentile(values, 0.975)];
    }
  }
  const convergedInteriorCount = interiorSamples.length;
  const boundaryFraction = optimizerConvergedReplicates
    ? boundaryReplicates / optimizerConvergedReplicates
    : null;
  return {
    requestedReplicates: replicates,
    replicates: interiorSamples.length,
    attemptedReplicates,
    convergedReplicates: optimizerConvergedReplicates,
    optimizerConvergedReplicates,
    convergedAndIdentifiableReplicates: convergedInteriorCount,
    boundaryReplicates,
    boundaryReplicateFraction: boundaryFraction,
    nonConvergedReplicates: attemptedReplicates - optimizerConvergedReplicates,
    terminationReasons,
    intervals: interiorSamples.length >= replicates ? intervals : null,
    boundaryFractions,
    convergedParameterSamples: convergedSamples,
    intervalBasis: "optimizer-converged replicates with every fitted parameter strictly inside its allowed bounds; this is a boundary-exclusion rule, while profile identifiability is reported separately",
  };
}

function fitStrain(strain, strainUnits, observations, facts, context) {
  const strainObservations = observations.filter((o) => facts.units.get(o.independentUnitId).strain === strain);
  const training = strainObservations
    .filter((o) => context.fitAllRolesForOracle || o.role === "training")
    .map((o) => context.fitAllRolesForOracle && o.role !== "training" ? { ...o, role: "training" } : o);
  const validation = observations.filter((o) => facts.units.get(o.independentUnitId).strain === strain && o.role === "validation");
  const drugIds = new Set(strainUnits.map((unit) => unit.drugId));
  if (drugIds.size !== 1) fail("DRUG_MISMATCH_PER_STRAIN", `Strain ${strain} must use a single drug.`, "dataset.observations", [...drugIds]);
  const drugId = [...drugIds][0];
  const concentrations = [...new Set(strainUnits.map((unit) => unit.concentration))].sort((a, b) => a - b);
  const t0Values = training.filter((o) => o.timeHours === 0).map((o) => o.value);
  const initialLog10 = t0Values.length ? t0Values.reduce((a, b) => a + b, 0) / t0Values.length : 6;
  const names = killParameterNames(drugId);
  const zMicName = `drugs.${drugId}.zMicMgPerL`;
  const minConc = concentrations[0];
  const maxConc = concentrations.at(-1);
  const bounds = {
    psiMaxLog10PerHour: [1e-4, 2],
    [`drugs.${drugId}.psiMinLog10PerHour`]: [-5, -1e-4],
    [zMicName]: [minConc / 10, maxConc * 10],
    [`drugs.${drugId}.hillKappa`]: [0.05, 10],
    [`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`]: [1, 9],
    errorSigmaLog10: [0.01, 2],
  };
  const initialParameters = {
    psiMaxLog10PerHour: 0.3,
    [`drugs.${drugId}.psiMinLog10PerHour`]: -1,
    [zMicName]: concentrations[Math.floor(concentrations.length / 2)],
    [`drugs.${drugId}.hillKappa`]: 1,
    [`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`]: initialLog10,
    errorSigmaLog10: 0.2,
  };
  const fitContext = {
    drugId,
    units: facts.units,
    carryingCapacityLog10: context.carryingCapacityLog10,
    maximumTimeHours: facts.maximumTimeHours,
  };
  const evaluator = (params, obs) => killPredictions(params, obs, fitContext);
  const fitOptions = {
    observations: training,
    parameterPolicy: "scientific",
    parameterWhitelist: names,
    parameterContext: { drugIds: [drugId], initialStateSeriesIds: [KILL_INITIAL_STATE_SERIES] },
    bounds,
    initialParameters,
    optimizationTransforms: {
      psiMaxLog10PerHour: "log",
      [`drugs.${drugId}.psiMinLog10PerHour`]: "negative_log",
      [zMicName]: "log",
      [`drugs.${drugId}.hillKappa`]: "log",
      errorSigmaLog10: "log",
    },
    method: "censored_gaussian_likelihood",
    sigma: { parameter: "errorSigmaLog10" },
    evaluator,
    seed: deriveSeed(context.seed, "kill", strain),
    restarts: context.restarts,
    differentialEvolution: { populationSize: 32, maxEvaluations: 4000, tolerance: 1e-3, objectiveTolerance: 1e-4 },
    nelderMead: { maxEvaluations: 3000 },
  };
  const fit = fitParameters(fitOptions);
  if (fit.status === "NOT_IDENTIFIABLE") {
    const reason = fit.fitDiagnostics.identifiability.reason;
    const profileTargets = {
      psiMinLog10PerHour: "psiMinLog10PerHour",
      hillKappa: "hillKappa",
      zMicMgPerL: "zMicMgPerL",
    };
    const profileLikelihoodDiagnostics = Object.fromEntries(Object.entries(profileTargets).map(([key]) => [key, {
      status: "NOT_ASSESSED",
      reason,
      identifiability: { status: "NOT_ASSESSED", reason },
    }]));
    const unassessedUnits = strainUnits.map((unit) => {
      const unitObservations = strainObservations.filter((observation) => observation.independentUnitId === unit.independentUnitId);
      const postBaseline = unitObservations.filter((observation) => observation.timeHours > 0);
      const detectionLimit = unitDetectionLimitLog10(unitObservations);
      const uncensoredPostBaselineObservationCount = postBaseline.filter((observation) => (
        observation.censoring !== "left" && !observationAtDetectionLimit(observation, detectionLimit)
      )).length;
      return {
        independentUnitId: unit.independentUnitId,
        concentrationMgPerL: unit.concentration,
        role: unit.role,
        observationCount: unitObservations.length,
        postBaselineObservationCount: postBaseline.length,
        uncensoredPostBaselineObservationCount,
        minimumUncensoredPostBaselineObservationCount: MINIMUM_UNCENSORED_POST_BASELINE_OBSERVATIONS,
        censoredObservationCount: postBaseline.filter((observation) => observation.censoring === "left").length,
        exactAtDetectionLimitCount: postBaseline.filter((observation) => observation.censoring !== "left"
          && detectionLimit !== null && observation.value <= detectionLimit + DETECTION_LIMIT_TOLERANCE).length,
        detectionLimitLog10: detectionLimit,
        modelNetGrowthRateLog10PerHour: null,
        status: "NOT_IDENTIFIABLE",
        basis: "strain_fit_not_identifiable",
        unitProfileEstimateLog10PerHour: null,
        relation: null,
        oneSided95Bound: null,
        compatibleRange95: { lower: null, upper: null },
        modelWithinUnitSupport95: null,
        declaredCensoringStatus: "NOT_ASSESSED",
        exactAtLimitCensoredStatus: null,
        criterion: UNIT_IDENTIFIABILITY_CRITERION,
      };
    });
    const unidentifiedUnits = unassessedUnits.map((unit) => unit.independentUnitId);
    const notAssessedBoundaryDiagnostics = Object.fromEntries(names.map((name) => [name, {
      estimateAtBound: null,
      confidenceIntervalTouchesBound: null,
      bootstrapBoundaryFraction: null,
      boundaryLimited: null,
      assessment: "not_assessed",
    }]));
    return {
      strain,
      drugId,
      status: "NOT_IDENTIFIABLE",
      concentrationsMgPerL: concentrations,
      fittedParameters: null,
      predictionParameters: null,
      parameterEstimates: Object.fromEntries(Object.keys(profileTargets).map((key) => [key, {
        status: "NOT_ASSESSED",
        pointEstimate: null,
      }])),
      identifiabilityStatus: Object.fromEntries(Object.keys(profileTargets).map((key) => [key, "NOT_ASSESSED"])),
      optimizationCoordinates: null,
      standardErrors: null,
      confidenceIntervals95: null,
      boundaryDiagnostics: notAssessedBoundaryDiagnostics,
      profileLikelihoodDiagnostics,
      fitDiagnostics: {
        identifiability: fit.fitDiagnostics.identifiability,
        convergence: fit.fitDiagnostics.convergence,
        boundary: { status: "NOT_ASSESSED", parametersAtBound: [] },
        sigmaAtLowerBound: null,
        profileLikelihood: { status: "NOT_ASSESSED", reason },
      },
      unitGrowthRateIdentifiability: {
        unitCount: unassessedUnits.length,
        identifiedUnitCount: 0,
        unidentifiedUnitCount: unassessedUnits.length,
        unidentifiedUnitIds: unidentifiedUnits,
        units: unassessedUnits,
        criterion: UNIT_IDENTIFIABILITY_CRITERION,
        note: "The strain-level fit lacks enough uncensored observations; no model growth rates, point estimates, or profile bounds are reported for its concentration groups.",
      },
      bootstrapReplicates: 0,
      bootstrapConvergence: null,
      converged: false,
      terminationReason: null,
      objectiveValue: null,
      trainingObservationCount: training.length,
      validationObservationCount: validation.length,
      trainingMetrics: null,
      validationMetrics: null,
      predictiveDiagnostics: {
        status: "unavailable",
        reason: "training_fit_not_identifiable",
        evidenceLevel: "declared_validation",
        validationIndependentUnitIds: [...new Set(validation.map((observation) => observation.independentUnitId))].sort(),
        bootstrapSampleCount: 0,
      },
      fitDataScope: context.fitAllRolesForOracle ? "all_roles_oracle_in_sample" : "training_only",
      oracleMetrics: null,
      incompleteUnits: strainUnits.filter((unit) => unit.missingTimes?.length)
        .map((unit) => ({ independentUnitId: unit.independentUnitId, missingTimes: unit.missingTimes })),
    };
  }
  const errors = standardErrors(fit, names, training, fitContext);
  const bootstrap = context.fitAllRolesForOracle
    ? null
    : bootstrapIntervals(fit, names, training, fitOptions, context, strain);
  const { fittedParameters, standardErrors: reportedErrors } = reportParams(fit.resolvedParameters, errors, drugId);
  const intervalNameMap = {
    psiMaxLog10PerHour: "psiMaxLog10PerHour",
    [`drugs.${drugId}.psiMinLog10PerHour`]: "psiMinLog10PerHour",
    [`drugs.${drugId}.zMicMgPerL`]: "zMicMgPerL",
    [`drugs.${drugId}.hillKappa`]: "hillKappa",
    [`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`]: "initialLog10PopulationDensity",
    errorSigmaLog10: "sigmaLog10Residual",
  };
  const reportedIntervals = bootstrap?.intervals
    ? Object.fromEntries(Object.entries(bootstrap.intervals).map(([name, [lo, hi]]) => [intervalNameMap[name] ?? name, [lo, hi]]))
    : null;
  const boundaryDiagnostics = Object.fromEntries(names.map((name) => {
    const [lower, upper] = bounds[name];
    const tolerance = Math.max((upper - lower) * 1e-5, Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)) * 8);
    const estimateAtLowerBound = fit.resolvedParameters[name] <= lower + tolerance;
    const estimateAtUpperBound = fit.resolvedParameters[name] >= upper - tolerance;
    const estimateAtBound = estimateAtLowerBound || estimateAtUpperBound;
    const interval = bootstrap?.intervals?.[name] ?? null;
    const confidenceIntervalTouchesBound = interval
      ? interval[0] <= lower + tolerance || interval[1] >= upper - tolerance
      : null;
    const bootstrapBoundaryFraction = bootstrap?.boundaryFractions?.[name] ?? null;
    const boundaryLimited = estimateAtBound || confidenceIntervalTouchesBound === true || (bootstrapBoundaryFraction ?? 0) > 0;
    return [intervalNameMap[name] ?? name, {
      estimateAtBound,
      estimateAtLowerBound,
      estimateAtUpperBound,
      confidenceIntervalTouchesBound,
      bootstrapBoundaryFraction,
      boundaryLimited,
      assessment: boundaryLimited ? "boundary_limited" : "no_boundary_evidence",
    }];
  }));
  const validationPredictions = killPredictions(fit.resolvedParameters, validation, fitContext);
  const trainingPredictions = killPredictions(fit.resolvedParameters, training, fitContext);
  const validationIndependentUnitIds = [...new Set(validation.map((observation) => observation.independentUnitId))].sort();
  const predictiveBootstrapSamples = bootstrap?.convergedParameterSamples ?? [];
  const predictiveDiagnostics = !validation.length || !predictiveBootstrapSamples.length
    ? {
      status: "unavailable",
      reason: !validation.length ? "no_validation_observations" : "no_converged_bootstrap_fits",
      evidenceLevel: "declared_validation",
      validationIndependentUnitIds,
      bootstrapSampleCount: predictiveBootstrapSamples.length,
    }
    : {
      ...summarizeGaussianMixturePredictions({
        observations: validation,
        samples: predictiveBootstrapSamples.map((parameters) => ({
          means: killPredictions(parameters, validation, fitContext),
          sigmas: validation.map(() => parameters.errorSigmaLog10),
        })),
        intervalLevel: 0.95,
      }),
      evidenceLevel: "declared_validation",
      validationIndependentUnitIds,
      bootstrapSampleCount: predictiveBootstrapSamples.length,
      uncertaintySource: "whole_training_independent_unit_bootstrap_plus_censored_gaussian_residual_model",
      predictionInterpretation: "Model-based new-observation prediction under the fitted censored-Gaussian observation model; validation coverage is descriptive and does not calibrate the interval.",
      limitations: [
        "Validation observations are not used to fit or calibrate this predictive distribution.",
        "Coverage estimates depend on the observation model and the declared validation units; between-study independence is not established by this result.",
      ],
    };
  const profileTargetNames = {
    psiMinLog10PerHour: `drugs.${drugId}.psiMinLog10PerHour`,
    hillKappa: `drugs.${drugId}.hillKappa`,
    zMicMgPerL: zMicName,
  };
  const profileSelected = context.profileLikelihood
    && (context.profileLikelihoodStrains.size === 0 || context.profileLikelihoodStrains.has(strain));
  const profileDiagnostics = profileSelected
    ? profileLikelihood(
      fit,
      fitOptions,
      names,
      Object.values(profileTargetNames),
      context.seed,
      strain,
      context.profilePoints,
    )
    : null;
  const mappedProfiles = profileDiagnostics
    ? Object.fromEntries(Object.entries(profileDiagnostics).map(([name, profile]) => [intervalNameMap[name] ?? name, profile]))
    : Object.fromEntries(Object.keys(profileTargetNames).map((name) => [name, {
      status: "NOT_ASSESSED",
      reason: context.profileLikelihood ? "profile_likelihood_not_selected_for_strain" : "profile_likelihood_not_requested",
      identifiability: {
        status: "NOT_ASSESSED",
        reason: context.profileLikelihood ? "profile_likelihood_not_selected_for_strain" : "profile_likelihood_not_requested",
      },
    }]));
  const identifiabilityStatus = Object.fromEntries(Object.entries(mappedProfiles)
    .map(([name, profile]) => [name, profile.identifiability.status]));
  const psiMinProfile = mappedProfiles?.psiMinLog10PerHour;
  const psiMinUnidentified = psiMinProfile && ["lower-unidentified", "upper-unidentified"]
    .includes(psiMinProfile.identifiability.status);
  const outputFittedParameters = { ...fittedParameters };
  const parameterEstimates = {};
  if (psiMinUnidentified) {
    const oneSidedBound = psiMinProfile.identifiability.oneSided95Bound;
    outputFittedParameters.psiMinLog10PerHour = null;
    parameterEstimates.psiMinLog10PerHour = {
      status: psiMinProfile.identifiability.status,
      pointEstimate: null,
      relation: psiMinProfile.identifiability.status === "lower-unidentified" ? "≤" : "≥",
      bound95: oneSidedBound,
      boundDescription: oneSidedBound === null
        ? "profile is monotonic over the allowed interval; no finite 95% crossing was found"
        : `data support psiMin ${psiMinProfile.identifiability.status === "lower-unidentified" ? "≤" : "≥"} ${oneSidedBound} log10-fold/h at the 95% profile-likelihood cutoff`,
      trend: psiMinProfile.identifiability.trend,
    };
  } else if (psiMinProfile) {
    parameterEstimates.psiMinLog10PerHour = psiMinProfile.identifiability.status === "identified"
      ? {
        status: "identified",
        pointEstimate: fittedParameters.psiMinLog10PerHour,
        profileCompatibleRange95: [
          psiMinProfile.profileCompatibleRange95.lower,
          psiMinProfile.profileCompatibleRange95.upper,
        ],
      }
      : {
        status: "NOT_ASSESSED",
        pointEstimate: fittedParameters.psiMinLog10PerHour,
        reason: psiMinProfile.reason ?? psiMinProfile.identifiability.reason,
      };
  }
  const fitted = readParams(fit.resolvedParameters, drugId);
  const unitObservationsByUnit = new Map();
  for (const observation of strainObservations) {
    if (!unitObservationsByUnit.has(observation.independentUnitId)) unitObservationsByUnit.set(observation.independentUnitId, []);
    unitObservationsByUnit.get(observation.independentUnitId).push(observation);
  }
  const unitIdentifiability = [...unitObservationsByUnit.values()].map((observations) => unitGrowthRateIdentifiability(observations, {
    drugId,
    modelParameters: syntheticModel(fit.resolvedParameters, drugId, context.carryingCapacityLog10).parameters,
    carryingCapacityLog10: context.carryingCapacityLog10,
    initialLog10PopulationDensity: fitted.n0,
    sigmaLog10Residual: fitted.sigma,
  }));
  const unidentifiedUnits = unitIdentifiability.filter((unit) => unit.status !== "identified");
  const unitIdentifiabilitySummary = {
    unitCount: unitIdentifiability.length,
    identifiedUnitCount: unitIdentifiability.length - unidentifiedUnits.length,
    unidentifiedUnitCount: unidentifiedUnits.length,
    unidentifiedUnitIds: unidentifiedUnits.map((unit) => unit.independentUnitId),
    units: unitIdentifiability,
    criterion: UNIT_IDENTIFIABILITY_CRITERION,
    note: "psi(C) is profiled for each concentration group with the strain-level N0 and residual scale held fixed. A group whose post-baseline observations all sit on the detection limit cannot bound psi(C) from below; its point estimate is withheld and only the one-sided 95% profile bound is reported. Group-level verdicts do not replace the strain-level parameter profiles.",
  };
  const fullDataPredictions = context.fitAllRolesForOracle
    ? killPredictions(fit.resolvedParameters, strainObservations, fitContext)
    : null;
  const parametersAtBound = Object.entries(boundaryDiagnostics).flatMap(([reportedName, diagnostic]) => {
    if (!diagnostic.estimateAtBound) return [];
    const name = Object.entries(intervalNameMap).find(([, alias]) => alias === reportedName)?.[0] ?? reportedName;
    const [lower, upper] = bounds[name];
    const value = fittedParameters[reportedName];
    const tolerance = Math.max((upper - lower) * 1e-5, Number.EPSILON * Math.max(Math.abs(lower), Math.abs(upper)) * 8);
    return [
      ...(diagnostic.estimateAtLowerBound ? [{ parameter: reportedName, side: "lower", value, bound: lower, tolerance }] : []),
      ...(diagnostic.estimateAtUpperBound ? [{ parameter: reportedName, side: "upper", value, bound: upper, tolerance }] : []),
    ];
  });
  const profileAssessed = Object.values(mappedProfiles).every((profile) => profile.status === "ASSESSED");
  const sigmaLower = bounds.errorSigmaLog10[0];
  const sigmaTolerance = Math.max((bounds.errorSigmaLog10[1] - sigmaLower) * 1e-5, Number.EPSILON * Math.abs(sigmaLower) * 8);
  return {
    strain,
    drugId,
    status: fit.converged ? "FIT_COMPLETED" : "FIT_NOT_CONVERGED",
    concentrationsMgPerL: concentrations,
    fittedParameters: outputFittedParameters,
    ...(psiMinUnidentified ? {
      predictionParameters: {
        ...fittedParameters,
        psiMinBoundarySubstitute: true,
        note: "Optimizer boundary value is exposed only as a prediction substitute; it is not a psiMin point estimate.",
      },
    } : {}),
    parameterEstimates,
    identifiabilityStatus,
    optimizationCoordinates: fit.optimizationCoordinates,
    standardErrors: reportedErrors,
    confidenceIntervals95: reportedIntervals,
    boundaryDiagnostics,
    profileLikelihoodDiagnostics: mappedProfiles,
    fitDiagnostics: {
      identifiability: fit.fitDiagnostics.identifiability,
      convergence: {
        status: fit.converged ? "CONVERGED" : "NOT_CONVERGED",
        terminationReason: fit.optimization?.terminationReason ?? null,
      },
      boundary: { status: "ASSESSED", parametersAtBound },
      sigmaAtLowerBound: fit.resolvedParameters.errorSigmaLog10 <= sigmaLower + sigmaTolerance,
      profileLikelihood: profileAssessed
        ? { status: "ASSESSED", reason: null }
        : {
          status: "NOT_ASSESSED",
          reason: profileSelected ? "profile_refits_not_all_converged" : context.profileLikelihood
            ? "profile_likelihood_not_selected_for_strain"
            : "profile_likelihood_not_requested",
        },
    },
    unitGrowthRateIdentifiability: unitIdentifiabilitySummary,
    bootstrapReplicates: bootstrap?.replicates ?? 0,
    bootstrapConvergence: bootstrap
      ? {
        requestedReplicates: bootstrap.requestedReplicates,
        attemptedReplicates: bootstrap.attemptedReplicates,
        convergedReplicates: bootstrap.convergedReplicates,
        optimizerConvergedReplicates: bootstrap.optimizerConvergedReplicates,
        convergedAndIdentifiableReplicates: bootstrap.convergedAndIdentifiableReplicates,
        boundaryReplicates: bootstrap.boundaryReplicates,
        boundaryReplicateFraction: bootstrap.boundaryReplicateFraction,
        nonConvergedReplicates: bootstrap.nonConvergedReplicates,
        terminationReasons: bootstrap.terminationReasons,
        intervalBasis: bootstrap.intervalBasis,
      }
      : null,
    converged: fit.converged,
    terminationReason: fit.optimization?.terminationReason ?? null,
    objectiveValue: fit.objectiveValue,
    trainingObservationCount: training.length,
    validationObservationCount: validation.length,
    trainingMetrics: validationMetrics(training, trainingPredictions),
    validationMetrics: context.fitAllRolesForOracle ? null : validationMetrics(validation, validationPredictions),
    predictiveDiagnostics: context.fitAllRolesForOracle ? {
      status: "unavailable",
      reason: "oracle_fit_uses_validation_observations",
      evidenceLevel: "in_sample_oracle",
      validationIndependentUnitIds,
      bootstrapSampleCount: 0,
    } : predictiveDiagnostics,
    fitDataScope: context.fitAllRolesForOracle ? "all_roles_oracle_in_sample" : "training_only",
    oracleMetrics: context.fitAllRolesForOracle ? validationMetrics(strainObservations, fullDataPredictions) : null,
    incompleteUnits: strainUnits
      .filter((unit) => unit.missingTimes?.length)
      .map((unit) => ({ independentUnitId: unit.independentUnitId, missingTimes: unit.missingTimes })),
  };
}

/**
 * Run the kill-curve workflow: import → gates → QC → fingerprint → locked split →
 * one-step censored fit per strain → locked validation. The OD600 Stage 4 workflow
 * is not involved.
 */
export async function runKillWorkflow(options = {}) {
  record(options, "options");
  const datasetInput = options.datasetInput ?? options.dataset ?? options.datasetJson;
  if (datasetInput === undefined) fail("DATASET_INPUT_REQUIRED", "datasetInput, dataset, or datasetJson is required.", "datasetInput");
  const seed = uint32(options.seed ?? 0x6b1c1a55, "seed");
  const restarts = Number.isInteger(options.restarts) && options.restarts > 0 ? options.restarts : 12;
  const carryingCapacityLog10 = Math.max(
    DEFAULT_CARRYING_CAPACITY_LOG10,
    finite(options.carryingCapacityLog10CfuPerMl ?? options.resolvedModel?.parameters?.carryingCapacityLog10CfuPerMl ?? DEFAULT_CARRYING_CAPACITY_LOG10, "carryingCapacityLog10CfuPerMl"),
  );
  const runtime = options.runtime ?? {};
  const check = typeof runtime.check === "function" ? runtime.check : () => {};
  const progress = typeof options.onProgress === "function" ? options.onProgress : () => {};
  const emit = (phase, completed, total) => progress({ phase, completed, total, fraction: total ? completed / total : 0 });

  emit("dataset_import", 0, 1);
  const imported = importObservationDataset(datasetInput, {
    format: options.datasetFormat ?? "auto",
    datasetMetadata: options.datasetMetadata,
  });
  const dataset = imported.dataset;
  emit("dataset_import", 1, 1);

  await check();
  emit("dataset_qc", 0, 1);
  const facts = assertKillDataset(dataset);
  const quality = assessDatasetQuality(dataset, { keyConditionFields: ["organism", "strain", "medium", "temperatureC"] });
  if (!quality.valid) fail("DATASET_QUALITY_FAILED", "Dataset quality checks reported errors.", "dataset", quality.errors);
  const datasetFingerprint = await fingerprintJson(dataset);
  emit("dataset_qc", 1, 1);

  await check();
  emit("dataset_split", 0, 1);
  const split = await createDatasetSplit(dataset, {
    sourceDatasetFingerprint: datasetFingerprint,
    strategy: "declared_training_validation_roles_by_complete_independent_unit",
    lockedValidation: true,
  });
  emit("dataset_split", 1, 1);

  const context = {
    seed,
    restarts,
    carryingCapacityLog10,
    bootstrapStartingParametersByStrain: options.bootstrapStartingParametersByStrain ?? {},
    bootstrapReplicates: Number.isInteger(options.bootstrapReplicates) && options.bootstrapReplicates >= 0
      ? options.bootstrapReplicates
      : 100,
    bootstrapMaxAttemptsMultiplier: Number.isInteger(options.bootstrapMaxAttemptsMultiplier)
      ? Math.max(3, Math.min(20, options.bootstrapMaxAttemptsMultiplier))
      : 3,
    profileLikelihood: options.profileLikelihood !== false,
    profileLikelihoodStrains: new Set(Array.isArray(options.profileLikelihoodStrains)
      ? options.profileLikelihoodStrains.filter((strain) => typeof strain === "string")
      : []),
    profilePoints: Number.isInteger(options.profilePoints) && options.profilePoints >= 5 && options.profilePoints <= 21
      ? options.profilePoints
      : 5,
    fitAllRolesForOracle: options.fitAllRolesForOracle === true,
  };
  const strains = {};
  for (const [strain, strainUnits] of facts.strains) {
    await check();
    emit(`fit:${strain}`, 0, 1);
    strains[strain] = fitStrain(strain, strainUnits, dataset.observations, facts, context);
    emit(`fit:${strain}`, 1, 1);
  }

  emit("manifest", 0, 1);
  const result = {
    kind: KILL_WORKFLOW_KIND,
    applicationVersion: options.applicationVersion ?? "unknown",
    status: Object.values(strains).every((row) => row.status === "NOT_IDENTIFIABLE")
      ? "NOT_IDENTIFIABLE"
      : Object.values(strains).some((row) => row.status === "NOT_IDENTIFIABLE") ? "PARTIALLY_IDENTIFIABLE" : "FIT_COMPLETED",
    runMetadata: {
      applicationVersion: options.applicationVersion ?? "unknown",
      seed,
      randomAlgorithm: RNG_ALGORITHM,
      settings: {
        restarts,
        bootstrapReplicates: context.bootstrapReplicates,
        bootstrapMaxAttemptsMultiplier: context.bootstrapMaxAttemptsMultiplier,
        profileLikelihood: context.profileLikelihood,
        profileLikelihoodStrains: [...context.profileLikelihoodStrains].sort(),
        profilePoints: context.profilePoints,
        fitAllRolesForOracle: context.fitAllRolesForOracle,
        carryingCapacityLog10CfuPerMl: carryingCapacityLog10,
      },
    },
    measurementType: KILL_MEASUREMENT_TYPE,
    datasetId: dataset.metadata.datasetId,
    datasetTitle: dataset.metadata.title,
    datasetFingerprint,
    splitFingerprint: split.splitFingerprint ?? null,
    lockedPlan: {
      strategy: "declared_training_validation_roles_by_complete_independent_unit",
      lockedValidation: true,
      trainingUnitCount: split.roles?.training?.independentUnitCount ?? facts.trainingUnitCount,
      validationUnitCount: split.roles?.validation?.independentUnitCount ?? facts.validationUnitCount,
      note: "Roles are declared per complete independent unit and validated non-overlapping before fitting; validation units are never used for fitting.",
    },
    carryingCapacityLog10CfuPerMl: carryingCapacityLog10,
    sourceTimeHours: facts.sourceTimes,
    maximumTimeHours: facts.maximumTimeHours,
    strains,
    crossGroupFitComparison: Object.fromEntries(Object.entries(strains).map(([strain, row]) => [strain, {
      trainingRmseLog10: row.trainingMetrics?.rmseLog10 ?? null,
      trainingMaeLog10: row.trainingMetrics?.maeLog10 ?? null,
      validationRmseLog10: row.validationMetrics?.rmseLog10 ?? null,
      validationMaeLog10: row.validationMetrics?.maeLog10 ?? null,
      comparisonMetricPolicy: "RMSE and MAE only; objective values are fit-specific diagnostics and are not compared across groups",
    }])),
    warnings: [
      ...(imported.warnings ?? []).map((warning) => warning.code ?? String(warning)),
      ...Object.entries(strains)
        .filter(([, row]) => row.unitGrowthRateIdentifiability.unidentifiedUnitCount > 0)
        .map(([strain, row]) => `Growth-rate point estimates are not identifiable for ${row.unitGrowthRateIdentifiability.unidentifiedUnitCount} of ${row.unitGrowthRateIdentifiability.unitCount} independent concentration groups in ${strain}: ${row.unitGrowthRateIdentifiability.unidentifiedUnitIds.join(", ")}. Each group reports its status; a point estimate or one-sided profile bound is included only when supported by the available observations and completed profile.`),
      "Carrying capacity is an educational ceiling (not fitted); latent log10 CFU is reported directly, so the OD observation layer is identity.",
      "Rates inside Ecolab are log10-fold/h; divide by ln(10) to compare with ln/h literature values. kappa and zMIC are unchanged by the conversion.",
    ],
  };
  emit("manifest", 1, 1);
  return result;
}

export const runEcolabKillWorkflow = runKillWorkflow;
export const runKillCurveWorkflow = runKillWorkflow;
