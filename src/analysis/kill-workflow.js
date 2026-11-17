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

import { simulatePiecewise } from "../model.js";
import { importObservationDataset } from "./dataset-import.js";
import { assessDatasetQuality } from "./dataset-quality.js";
import { fingerprintJson } from "./fingerprint.js";
import { createDatasetSplit } from "./split.js";
import { fitParameters } from "./fitting.js";
import { censoredGaussianLogLikelihood } from "./likelihood.js";
import { createRandom } from "./random.js";

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
  const h = names.map((name) => 1e-4 * Math.max(1, Math.abs(center[name] ?? 0)));
  const hessian = names.map((_, i) => names.map((_, j) => {
    const pp = { ...center }; pp[names[i]] += h[i]; pp[names[j]] += h[j];
    const pm = { ...center }; pm[names[i]] += h[i]; pm[names[j]] -= h[j];
    const mp = { ...center }; mp[names[i]] -= h[i]; mp[names[j]] += h[j];
    const mm = { ...center }; mm[names[i]] -= h[i]; mm[names[j]] -= h[j];
    return (
      negativeLogLikelihood(pp, observations, context)
      - negativeLogLikelihood(pm, observations, context)
      - negativeLogLikelihood(mp, observations, context)
      + negativeLogLikelihood(mm, observations, context)
    ) / (4 * h[i] * h[j]);
  }));
  const inverse = invertMatrix(hessian);
  if (!inverse) return Object.fromEntries(names.map((name) => [name, null]));
  const out = {};
  names.forEach((name, index) => {
    const variance = inverse[index][index];
    out[name] = Number.isFinite(variance) && variance > 0 ? Math.sqrt(variance) : null;
  });
  return out;
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
  };
}

function percentile(sorted, q) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index];
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
  const samples = [];
  for (let b = 0; b < replicates; b += 1) {
    const picked = unitIds.map(() => unitIds[Math.floor(rng.next() * unitIds.length)]);
    const obs = picked.flatMap((id) => byUnit.get(id));
    const refit = fitParameters({
      ...fitOptions,
      observations: obs,
      initialParameters: fit.resolvedParameters,
      restarts: 1,
      differentialEvolution: { populationSize: 16, maxEvaluations: 250, tolerance: 1e-3, objectiveTolerance: 1e-4 },
      nelderMead: { maxEvaluations: 200 },
      seed: deriveSeed(context.seed, "bootstrap", strain, b),
    });
    samples.push(refit.resolvedParameters);
  }
  const intervals = {};
  for (const name of names) {
    const values = samples.map((s) => s[name]).sort((a, b) => a - b);
    intervals[name] = [percentile(values, 0.025), percentile(values, 0.975)];
  }
  return { replicates, intervals };
}

function fitStrain(strain, strainUnits, observations, facts, context) {
  const training = observations.filter((o) => facts.units.get(o.independentUnitId).strain === strain && o.role === "training");
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
    [`drugs.${drugId}.psiMinLog10PerHour`]: [-12, -1e-4],
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
    method: "censored_gaussian_likelihood",
    sigma: { parameter: "errorSigmaLog10" },
    evaluator,
    seed: deriveSeed(context.seed, "kill", strain),
    restarts: context.restarts,
    differentialEvolution: { populationSize: 32, maxEvaluations: 4000, tolerance: 1e-3, objectiveTolerance: 1e-4 },
    nelderMead: { maxEvaluations: 800 },
  };
  const fit = fitParameters(fitOptions);
  const errors = standardErrors(fit, names, training, fitContext);
  const bootstrap = bootstrapIntervals(fit, names, training, fitOptions, context, strain);
  const { fittedParameters, standardErrors: reportedErrors } = reportParams(fit.resolvedParameters, errors, drugId);
  const intervalNameMap = {
    psiMaxLog10PerHour: "psiMaxLog10PerHour",
    [`drugs.${drugId}.psiMinLog10PerHour`]: "psiMinLog10PerHour",
    [`drugs.${drugId}.zMicMgPerL`]: "zMicMgPerL",
    [`drugs.${drugId}.hillKappa`]: "hillKappa",
    [`initialStates.${KILL_INITIAL_STATE_SERIES}.log10PopulationDensity`]: "initialLog10PopulationDensity",
    errorSigmaLog10: "sigmaLog10Residual",
  };
  const reportedIntervals = bootstrap
    ? Object.fromEntries(Object.entries(bootstrap.intervals).map(([name, [lo, hi]]) => [intervalNameMap[name] ?? name, [lo, hi]]))
    : null;
  const validationPredictions = killPredictions(fit.resolvedParameters, validation, fitContext);
  const trainingPredictions = killPredictions(fit.resolvedParameters, training, fitContext);
  return {
    strain,
    drugId,
    concentrationsMgPerL: concentrations,
    fittedParameters,
    standardErrors: reportedErrors,
    confidenceIntervals95: reportedIntervals,
    bootstrapReplicates: bootstrap?.replicates ?? 0,
    converged: fit.converged,
    terminationReason: fit.optimization?.terminationReason ?? null,
    objectiveValue: fit.objectiveValue,
    trainingObservationCount: training.length,
    validationObservationCount: validation.length,
    trainingMetrics: validationMetrics(training, trainingPredictions),
    validationMetrics: validationMetrics(validation, validationPredictions),
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
    bootstrapReplicates: Number.isInteger(options.bootstrapReplicates) && options.bootstrapReplicates >= 0
      ? options.bootstrapReplicates
      : 100,
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
    warnings: [
      ...(imported.warnings ?? []).map((warning) => warning.code ?? String(warning)),
      "Carrying capacity is an educational ceiling (not fitted); latent log10 CFU is reported directly, so the OD observation layer is identity.",
      "Rates inside Ecolab are log10-fold/h; divide by ln(10) to compare with ln/h literature values. kappa and zMIC are unchanged by the conversion.",
    ],
  };
  emit("manifest", 1, 1);
  return result;
}

export const runEcolabKillWorkflow = runKillWorkflow;
export const runKillCurveWorkflow = runKillWorkflow;
