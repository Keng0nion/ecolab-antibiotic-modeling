import test from "node:test";
import assert from "node:assert/strict";
import { normalizeObservationDataset } from "../dataset-import.js";
import { createDatasetSplit } from "../split.js";
import { quantileR7 } from "../monte-carlo.js";
import { readFile } from "node:fs/promises";
import * as growth from "../growth-comparison.js";

const PARAMETERS = { baselineOd: 0.08, amplitudeOd: 0.7, ratePerHour: 0.85, timingHours: 5.2 };
const BOUNDS = {
  baselineOd: [0, 0.2],
  amplitudeOd: [0.3, 1],
  ratePerHour: [0.15, 2],
  timingHours: [2, 9],
};
const TIMES = [0, 0.17, 0.8, 1.7, 2.4, 3.6, 4.2, 5.1, 6.4, 7.8, 9.5, 12, 16];

function oracle(model, time, parameters = PARAMETERS) {
  const { baselineOd: b, amplitudeOd: a, ratePerHour: r, timingHours: c } = parameters;
  return b + a * (model === "logistic"
    ? 1 / (1 + Math.exp(-r * (time - c)))
    : Math.exp(-Math.exp(-r * (time - c))));
}

async function fixture({ model = "logistic", trainingIds = ["culture/α", "vial:z", "9", "flask B"], value } = {}) {
  const observations = [...trainingIds, "dev/x", "dev/λ"].flatMap((id, unit) => TIMES.map((timeHours, time) => ({
    observationId: `${id}:reading-${time}`,
    seriesId: `series:${id}`,
    independentUnitId: id,
    role: unit < trainingIds.length ? "training" : "development",
    timeHours,
    drugId: "none",
    concentrationMgPerL: 0,
    measurementType: "od600",
    value: value ? value(timeHours, unit, time) : oracle(model, timeHours),
    censoring: "none",
    censoringBounds: null,
    replicate: `arbitrary replicate ${unit}`,
    conditions: {},
  })));
  const normalized = normalizeObservationDataset({
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId: "synthetic-mathematical-oracle", title: "Synthetic, not experimental validation", sourceIds: [], conditions: {} },
    observations,
  });
  const dataset = normalized.dataset ?? normalized;
  return { dataset, split: await createDatasetSplit(dataset) };
}

function options(data, overrides = {}) {
  return {
    ...data,
    seed: 3817,
    bounds: structuredClone(BOUNDS),
    optimizer: {
      restarts: 1,
      populationSize: 20,
      differentialEvolutionMaxEvaluations: 1600,
      nelderMeadMaxEvaluations: 1800,
      tolerance: 1e-7,
      objectiveTolerance: 1e-12,
    },
    bootstrap: { samples: 0, intervalLevel: 0.95 },
    runtime: { yieldControl: async () => {} },
    ...overrides,
  };
}

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected} (tolerance ${tolerance})`);
}

test("public OD curve evaluator and comparison runner exist", () => {
  assert.equal(typeof growth.evaluateOdGrowthCurve, "function");
  assert.equal(typeof growth.runGrowthModelComparison, "function");
});

for (const model of ["logistic", "gompertz"]) {
  test(`${model} uses a direct baseline-plus-amplitude OD equation, with empirical inflection timing/rate`, () => {
    for (const time of TIMES) close(growth.evaluateOdGrowthCurve(model, time, PARAMETERS), oracle(model, time));
    const { baselineOd: b, amplitudeOd: a, ratePerHour: r, timingHours: c } = PARAMETERS;
    close(growth.evaluateOdGrowthCurve(model, c, PARAMETERS), b + a / (model === "logistic" ? 2 : Math.E));
    const step = 1e-4;
    const derivative = (growth.evaluateOdGrowthCurve(model, c + step, PARAMETERS)
      - growth.evaluateOdGrowthCurve(model, c - step, PARAMETERS)) / (2 * step);
    close(derivative, a * r / (model === "logistic" ? 4 : Math.E), 1e-8);
    close(growth.evaluateOdGrowthCurve(model, 0, { ...PARAMETERS, timingHours: 1e300 }), b);
    close(growth.evaluateOdGrowthCurve(model, 1e300, PARAMETERS), b + a);
  });
}

test("curve evaluator rejects malformed parameters, unsupported models and non-finite times", () => {
  for (const [model, time, parameters] of [
    ["log-population-gompertz", 0, PARAMETERS],
    ["logistic", NaN, PARAMETERS],
    ["logistic", -1, PARAMETERS],
    ["logistic", 1, { ...PARAMETERS, amplitudeOd: 0 }],
    ["gompertz", 1, { ...PARAMETERS, ratePerHour: -1 }],
    ["gompertz", 1, { ...PARAMETERS, baselineOd: Infinity }],
    ["gompertz", 1, null],
  ]) assert.throws(() => growth.evaluateOdGrowthCurve(model, time, parameters), { name: "GrowthComparisonError" });
});

for (const model of ["logistic", "gompertz"]) {
  test(`bounded DE/NM recovers synthetic ${model} parameters without asserting a real-data winner`, async () => {
    const data = await fixture({ model });
    const before = structuredClone(data);
    const result = await growth.runGrowthModelComparison(options(data));
    const fit = result.trainingFits[model];
    for (const name of Object.keys(PARAMETERS)) close(fit.parameters[name], PARAMETERS[name], 2e-4);
    assert.ok(fit.metrics.pooledRmse < 1e-6);
    assert.equal(fit.optimizer.restarts.length, 1);
    assert.ok(fit.optimizer.restarts[0].differentialEvolution.evaluationCount <= 1600);
    assert.ok(fit.optimizer.restarts[0].nelderMead.evaluationCount <= 1800);
    assert.equal(fit.converged, true);
    assert.match(result.models[model].interpretation, /empirical.*OD/i);
    assert.match(result.models[model].interpretation, /not.*physiological/i);
    assert.equal(result.models[model].cfuConversion, false);
    assert.deepEqual(data, before);
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
}

test("complete-trajectory folds use their own exact-time training means and deterministic macro-RMSE selection", async () => {
  const data = await fixture({ value: (time, unit) => oracle("logistic", time) + unit * 0.02 });
  const ids = data.split.roles.training.independentUnitIds;
  const folds = [[ids[0], ids[1]], [ids[2]], [ids[3]]];
  const result = await growth.runGrowthModelComparison(options(data, { crossValidation: { folds, tieTolerance: 100 } }));
  assert.equal(result.crossValidation.metric, "macroRmse");
  assert.deepEqual(result.selection.tieOrder, ["training_mean", "logistic", "gompertz"]);
  assert.equal(result.selection.selectedModel, "training_mean");
  assert.equal(result.selection.sourceRole, "training");
  const candidate = result.crossValidation.candidates.training_mean;
  assert.equal(candidate.folds.length, folds.length);
  const allHeldOut = [];
  for (const fold of candidate.folds) {
    const held = new Set(fold.heldOutIndependentUnitIds);
    assert.ok(fold.trainingIndependentUnitIds.every((id) => !held.has(id)));
    allHeldOut.push(...fold.heldOutIndependentUnitIds);
    for (const prediction of fold.predictions) {
      const source = data.dataset.observations.filter((row) => row.role === "training"
        && !held.has(row.independentUnitId) && row.timeHours === prediction.timeHours);
      close(prediction.predicted, source.reduce((sum, row) => sum + row.value, 0) / source.length);
    }
    assert.equal(fold.predictions.length, held.size * TIMES.length);
  }
  assert.deepEqual(allHeldOut.sort(), [...ids].sort());
  close(candidate.score, candidate.metrics.perUnit.reduce((sum, unit) => sum + unit.rmse, 0) / ids.length);
  assert.equal(result.development.role, "development_comparison");
  assert.equal(result.development.previouslyViewed, true);
  assert.equal(result.development.eligibleAsValidationEvidence, false);
  assert.equal(result.development.fittedOnThisData, false);
  assert.equal(result.development.selectedModel, result.selection.selectedModel);
  assert.equal(result.development.selected.predictions.length, data.split.roles.development.observationIds.length);
  for (const row of result.development.selected.predictions) close(row.residual, row.observed - row.predicted);
});

test("selection chooses a smooth sigmoid on synthetic high-frequency noise, not a hardcoded baseline", async () => {
  const data = await fixture({ value: (time, unit, index) => oracle("logistic", time)
    + (unit < 4 ? [1, 1, -1, -1][unit] * (index % 2 ? -1 : 1) * 0.025 : 0) });
  const result = await growth.runGrowthModelComparison(options(data));
  assert.equal(result.selection.selectedModel, "logistic", JSON.stringify(Object.fromEntries(
    Object.entries(result.crossValidation.candidates).map(([model, candidate]) => [model, candidate.score]),
  )));
  assert.ok(result.crossValidation.candidates.logistic.score < result.crossValidation.candidates.training_mean.score);
  close(result.crossValidation.candidates.training_mean.score, 0.025 * 4 / 3);
});

test("development changes cannot affect training fits, CV, selection, seeds, or bootstrap", async () => {
  const data = await fixture({ value: (time, unit, index) => oracle("logistic", time)
    + (unit < 4 ? [1, 1, -1, -1][unit] * (index % 2 ? -1 : 1) * 0.025 : 0) });
  const original = options(data, { bootstrap: { samples: 5, intervalLevel: 0.8 } });
  const first = await growth.runGrowthModelComparison(original);
  assert.equal(first.selection.selectedModel, "logistic");
  const changed = structuredClone(data);
  for (const row of changed.dataset.observations) if (row.role === "development") {
    row.value = 20 + row.value * 11;
    row.timeHours += 0.031;
  }
  changed.split = await createDatasetSplit(changed.dataset);
  const second = await growth.runGrowthModelComparison(options(changed, { bootstrap: original.bootstrap }));
  for (const key of ["configuration", "trainingFits", "crossValidation", "selection", "bootstrap"]) {
    assert.deepEqual(second[key], first[key], key);
  }
  assert.notDeepEqual(first.development, second.development);
  assert.equal(second.development.baseline.status, "unavailable");
  assert.equal(second.development.baseline.metrics, null);
  assert.ok(second.warnings.some(({ code }) => code === "EXACT_TIME_BASELINE_UNAVAILABLE"));
  assert.deepEqual(await growth.runGrowthModelComparison(original), first);
  const reordered = structuredClone(data);
  reordered.dataset.observations.reverse();
  assert.deepEqual(await growth.runGrowthModelComparison(options(reordered, { bootstrap: original.bootstrap })), first);
});

test("bootstrap retains paired whole-trajectory draws, joint parameter vectors, refit diagnostics, and conditional R7 intervals", async () => {
  const data = await fixture({ value: (time, unit, index) => oracle("logistic", time)
    + (unit < 4 ? [1, 1, -1, -1][unit] * (index % 2 ? -1 : 1) * 0.025 : 0) });
  const result = await growth.runGrowthModelComparison(options(data, { bootstrap: { samples: 8, intervalLevel: 0.8 } }));
  const bootstrap = result.bootstrap;
  assert.equal(bootstrap.selectedModel, "logistic");
  assert.equal(bootstrap.resamplingUnit, "whole_training_trajectory");
  assert.equal(bootstrap.independenceAssumption, "unverified");
  assert.equal(bootstrap.samples.length, 8);
  assert.equal(bootstrap.successfulSamples + bootstrap.failures.length, 8);
  assert.ok(bootstrap.successfulSamples >= 2);
  for (const sample of bootstrap.samples) {
    assert.equal(sample.sampledIndependentUnitIds.length, 4);
    assert.equal(sample.sampledObservationIds.length, 4);
    for (let draw = 0; draw < 4; draw += 1) {
      const id = sample.sampledIndependentUnitIds[draw];
      assert.ok(data.split.roles.training.independentUnitIds.includes(id));
      assert.deepEqual([...sample.sampledObservationIds[draw]].sort(), data.dataset.observations
        .filter((row) => row.independentUnitId === id).map((row) => row.observationId).sort());
    }
    assert.deepEqual(sample.parameterVector, bootstrap.parameterNames.map((name) => sample.parameters[name]));
    assert.ok(sample.optimizer.evaluationCount > 0);
  }
  assert.ok(bootstrap.samples.some((sample) => new Set(sample.sampledIndependentUnitIds).size < 4));
  const intervals = bootstrap.intervals;
  assert.equal(intervals.kind, "exploratory_conditional_percentile_intervals");
  assert.equal(intervals.includesModelSelectionUncertainty, false);
  assert.equal(intervals.includesObservationNoise, false);
  assert.equal(intervals.parameterIndependenceAssumed, false);
  assert.equal(intervals.status, "available");
  assert.ok(bootstrap.samples.some((sample) => sample.parameters.timingHours !== result.trainingFits.logistic.parameters.timingHours));
  const successful = bootstrap.samples.filter(({ status }) => status === "success");
  for (const name of bootstrap.parameterNames) {
    const values = successful.map(({ parameters }) => parameters[name]).sort((a, b) => a - b);
    close(intervals.parameters[name].lower, quantileR7(values, 0.1));
    close(intervals.parameters[name].upper, quantileR7(values, 0.9));
  }
  assert.deepEqual(intervals.predictions.map(({ timeHours }) => timeHours), TIMES);
  assert.ok(result.warnings.some(({ code }) => code === "LOW_BOOTSTRAP_SAMPLE_COUNT"));
});

test("a selected exact-time mean baseline is resampled as joint mean curves, not given fictitious sigmoid parameters", async () => {
  const data = await fixture({ value: (time, unit) => oracle("logistic", time) + unit * 0.01 });
  const result = await growth.runGrowthModelComparison(options(data, {
    crossValidation: { tieTolerance: 100 },
    bootstrap: { samples: 4, intervalLevel: 0.8 },
  }));
  assert.equal(result.bootstrap.selectedModel, "training_mean");
  assert.deepEqual(result.bootstrap.parameterNames, []);
  assert.deepEqual(result.bootstrap.intervals.parameters, {});
  for (const sample of result.bootstrap.samples) {
    assert.equal(sample.parameters, null);
    assert.equal(sample.parameterVector, null);
    assert.equal(sample.optimizer, null);
    for (const row of sample.meanOdByTime) {
      const values = sample.sampledIndependentUnitIds.map((id) => data.dataset.observations
        .find((observation) => observation.independentUnitId === id && observation.timeHours === row.timeHours).value);
      close(row.meanOd, values.reduce((sum, value) => sum + value, 0) / values.length);
    }
  }
});

test("low budgets preserve nonconvergence and bootstrap failures rather than fabricating precision", async () => {
  const data = await fixture({ trainingIds: ["a", "b"] });
  // Disjoint irregular supports make only the parametric candidates CV-eligible.
  for (const row of data.dataset.observations) if (row.independentUnitId === "b") row.timeHours += 0.04;
  data.split = await createDatasetSplit(data.dataset);
  const result = await growth.runGrowthModelComparison(options(data, {
    optimizer: { restarts: 1, populationSize: 4, differentialEvolutionMaxEvaluations: 1, nelderMeadMaxEvaluations: 1 },
    bootstrap: { samples: 3, intervalLevel: 0.95 },
  }));
  assert.equal(result.crossValidation.candidates.training_mean.eligible, false);
  assert.equal(result.crossValidation.candidates.training_mean.score, null);
  assert.notEqual(result.selection.selectedModel, "training_mean");
  assert.equal(result.trainingFits.logistic.converged, false);
  assert.equal(result.bootstrap.successfulSamples, 0);
  assert.equal(result.bootstrap.failures.length, 3);
  assert.ok(result.bootstrap.failures.every(({ reason }) => reason === "optimizer_not_converged"));
  assert.equal(result.bootstrap.intervals.status, "unavailable");
  assert.deepEqual(result.bootstrap.intervals.predictions, []);
  assert.ok(result.bootstrap.samples.every((sample) => sample.parameterVector.length === 4));
  for (const code of ["LOW_OPTIMIZER_BUDGET", "OPTIMIZER_NOT_CONVERGED", "BOOTSTRAP_REFIT_FAILURES"]) {
    assert.ok(result.warnings.some((warning) => warning.code === code), code);
  }
});

test("legacy validation curves require an explicit developmentRole and remain development evidence", async () => {
  const data = await fixture();
  for (const row of data.dataset.observations) if (row.role === "development") row.role = "validation";
  data.split = await createDatasetSplit(data.dataset);
  await assert.rejects(growth.runGrowthModelComparison(options(data)), { code: "EMPTY_DEVELOPMENT_SPLIT" });
  const result = await growth.runGrowthModelComparison(options(data, { developmentRole: "validation" }));
  assert.equal(result.development.observationRoleUsed, "validation");
  assert.equal(result.configuration.developmentRole, "validation");
  assert.equal(result.development.eligibleAsValidationEvidence, false);
});

test("malformed dataset, exact IDs, options and non-trajectory folds are rejected", async () => {
  const data = await fixture();
  const cases = [
    (x) => { delete x.bounds; },
    (x) => { delete x.seed; },
    (x) => { x.seed = -1; },
    (x) => { x.bounds.ratePerHour = [0, 1]; },
    (x) => { x.bounds.baselineOd = [1, 0]; },
    (x) => { x.bounds.extra = [0, 1]; },
    (x) => { x.optimizer.differentialEvolutionMaxEvaluations = 0; },
    (x) => { x.optimizer.populationSize = 3; },
    (x) => { x.bootstrap.samples = -1; },
    (x) => { x.bootstrap.intervalLevel = 1; },
    (x) => { x.crossValidation = { tieTolerance: NaN }; },
    (x) => { x.crossValidation = { folds: [["culture/α"], ["dev/x"]] }; },
    (x) => { x.crossValidation = { folds: [["culture/α"], ["culture/α"]] }; },
    (x) => { x.crossValidation = { folds: [x.split.roles.training.independentUnitIds] }; },
    (x) => { x.split.roles.training.observationIds.pop(); },
    (x) => { x.split.roles.training.independentUnitIds.push("unknown"); },
    (x) => { x.split.roles.development.independentUnitIds.push("culture/α"); },
    (x) => { x.dataset.observations[0].value = NaN; },
    (x) => { delete x.dataset.observations[1]; },
    (x) => { x.dataset.observations[0].measurementType = "cfu_per_ml"; },
    (x) => { x.dataset.observations[0].censoring = "left"; },
    (x) => { x.dataset.observations[0].timeHours = -1; },
    (x) => { x.dataset.observations[0].independentUnitId = ""; },
    (x) => { x.dataset.observations.push({ ...x.dataset.observations[0] }); },
    (x) => { x.dataset.observations[1].timeHours = x.dataset.observations[0].timeHours; },
    (x) => { x.runtime = { yieldControl: 42 }; },
    (x) => { x.onProgress = false; },
    (x) => { x.unknownOption = true; },
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const input = options(structuredClone(data));
    cases[index](input);
    await assert.rejects(growth.runGrowthModelComparison(input), { name: "GrowthComparisonError" }, `case ${index}`);
  }
});

test("runtime cancellation works before work, at cooperative yields, and after progress callbacks", async () => {
  const data = await fixture();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(growth.runGrowthModelComparison(options(data, { runtime: { signal: controller.signal } })), { code: "ANALYSIS_CANCELLED" });
  let yields = 0;
  const running = new AbortController();
  await assert.rejects(growth.runGrowthModelComparison(options(data, { runtime: {
    signal: running.signal,
    yieldControl: async () => { yields += 1; if (yields === 3) running.abort(); },
  } })), { code: "ANALYSIS_CANCELLED" });
  assert.equal(yields, 3);
  let checks = 0;
  const cancellation = Object.assign(new Error("host cancellation"), { code: "HOST_CANCEL" });
  await assert.rejects(growth.runGrowthModelComparison(options(data, { runtime: {
    checkCancelled: () => { checks += 1; if (checks === 30) throw cancellation; },
    yieldControl: async () => {},
  } })), (error) => error === cancellation);
  assert.equal(checks, 30, "optimizer must not swallow cancellation and spend the remaining budget");
  const afterProgress = new AbortController();
  await assert.rejects(growth.runGrowthModelComparison(options(data, {
    runtime: { signal: afterProgress.signal, yieldControl: async () => {} },
    onProgress: ({ phase }) => { if (phase === "bootstrap") afterProgress.abort(); },
    bootstrap: { samples: 2 },
  })), { code: "ANALYSIS_CANCELLED" });
});

test("Gompertz can win mathematical CV and its joint draws predict with the Gompertz equation", async () => {
  const data = await fixture({ value: (time, unit, index) => oracle("gompertz", time)
    + (unit < 4 ? [1, 1, -1, -1][unit] * (index % 2 ? -1 : 1) * 0.015 : 0) });
  const result = await growth.runGrowthModelComparison(options(data, { bootstrap: { samples: 5, intervalLevel: 0.8 } }));
  assert.equal(result.selection.selectedModel, "gompertz");
  assert.equal(result.bootstrap.selectedModel, "gompertz");
  assert.equal(result.bootstrap.intervals.status, "available");
  for (const prediction of result.development.selected.predictions) {
    close(prediction.predicted, oracle("gompertz", prediction.timeHours, result.trainingFits.gompertz.parameters));
  }
  for (const interval of result.bootstrap.intervals.predictions) {
    const values = result.bootstrap.samples.filter(({ status }) => status === "success")
      .map(({ parameters }) => oracle("gompertz", interval.timeHours, parameters)).sort((a, b) => a - b);
    close(interval.lower, quantileR7(values, 0.1));
    close(interval.upper, quantileR7(values, 0.9));
  }
});

test("irregular CV records missing exact-time support rather than interpolating held-out mean predictions", async () => {
  const data = await fixture({ trainingIds: ["a", "b", "c"] });
  const first = { ...data.dataset.observations[0], observationId: "unique-time-reading", timeHours: 21.73, value: 0.4 };
  data.dataset.observations.push(first);
  data.split = await createDatasetSplit(data.dataset);
  // Each holdout fold has the unique-time trajectory in its fit, except the fold
  // holding it out, where that absent exact time makes the mean CV-ineligible.
  const result = await growth.runGrowthModelComparison(options(data, { bootstrap: { samples: 2 } }));
  assert.equal(result.crossValidation.candidates.training_mean.eligible, false);
  const missing = result.crossValidation.candidates.training_mean.folds.find((fold) => fold.status === "unavailable");
  assert.deepEqual(missing.missingObservationIds, ["unique-time-reading"]);
  assert.equal(missing.metrics, null);
  assert.equal(missing.predictions.find(({ observationId }) => observationId === "unique-time-reading").predicted, null);
});

test("irregular training trajectories keep paired baseline bootstrap failures and available joint curves", async () => {
  const data = await fixture({ trainingIds: ["a", "b", "c", "d"] });
  data.dataset.observations = data.dataset.observations.filter((row) => !(["c", "d"].includes(row.independentUnitId)
    && row.timeHours === TIMES.at(-1)));
  data.split = await createDatasetSplit(data.dataset);
  const result = await growth.runGrowthModelComparison(options(data, { bootstrap: { samples: 64, intervalLevel: 0.8 } }));
  assert.equal(result.selection.selectedModel, "training_mean");
  const failed = result.bootstrap.samples.filter((sample) => sample.sampledIndependentUnitIds.every((id) => ["c", "d"].includes(id)));
  assert.ok(failed.length > 0);
  assert.equal(result.bootstrap.failures.length, failed.length);
  assert.ok(result.bootstrap.failures.every(({ reason }) => reason === "missing_prediction_support"));
  assert.ok(failed.every((sample) => sample.status === "failure" && sample.meanOdByTime.length === TIMES.length - 1));
  for (const sample of result.bootstrap.samples) for (let draw = 0; draw < 4; draw += 1) {
    const id = sample.sampledIndependentUnitIds[draw];
    assert.equal(sample.sampledObservationIds[draw].length, ["c", "d"].includes(id) ? TIMES.length - 1 : TIMES.length);
  }
  assert.equal(result.bootstrap.intervals.status, "available");
  assert.equal(result.bootstrap.intervals.successfulSampleCount, 64 - failed.length);
});

test("bootstrap marks poorly resolved percentile tails even when the requested sample count is not low", async () => {
  const data = await fixture();
  const result = await growth.runGrowthModelComparison(options(data, {
    bootstrap: { samples: 200, intervalLevel: 0.999 },
  }));
  const interval = result.bootstrap.intervals;
  close(interval.expectedTailSamples, interval.successfulSampleCount * 0.0005);
  assert.equal(interval.precisionAssessed, false);
  assert.equal(interval.tailResolutionAdequate, false);
  assert.ok(result.warnings.some(({ code }) => code === "BOOTSTRAP_TAILS_UNRESOLVED"));
  assert.equal(result.warnings.some(({ code }) => code === "LOW_BOOTSTRAP_SAMPLE_COUNT"), false);
});

test("canonical folds and frozen output are stable, and configured limits reject unbounded work", async () => {
  const data = await fixture();
  const ids = data.split.roles.training.independentUnitIds;
  const a = await growth.runGrowthModelComparison(options(data, { crossValidation: { folds: [[ids[0], ids[2]], [ids[1], ids[3]]] } }));
  const b = await growth.runGrowthModelComparison(options(data, { crossValidation: { folds: [[ids[3], ids[1]], [ids[2], ids[0]]] } }));
  assert.deepEqual(a, b);
  assert.ok(Object.isFrozen(a.selection));
  assert.ok(Object.isFrozen(a.trainingFits.logistic.parameters));
  assert.throws(() => { a.trainingFits.logistic.parameters.ratePerHour = 123; }, TypeError);
  for (const override of [
    { optimizer: { restarts: 6 } },
    { optimizer: { differentialEvolutionMaxEvaluations: 10001 } },
    { bootstrap: { samples: 2001 } },
    { optimizer: { restarts: 5, differentialEvolutionMaxEvaluations: 10000, nelderMeadMaxEvaluations: 10000 }, bootstrap: { samples: 2000 } },
  ]) await assert.rejects(growth.runGrowthModelComparison(options(data, override)), { name: "GrowthComparisonError" });
});

test("bundled normalized OD600 dataset and workflow split run with exact source IDs, without a preferred real-data result", async () => {
  const text = await readFile(new URL("../../../data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", import.meta.url), "utf8");
  const dataset = normalizeObservationDataset(JSON.parse(text));
  const split = await createDatasetSplit(dataset);
  const result = await growth.runGrowthModelComparison(options({ dataset, split }, {
    developmentRole: "validation",
    bounds: { baselineOd: [0, 0.3], amplitudeOd: [0.001, 1], ratePerHour: [0.001, 4], timingHours: [0, 30] },
    optimizer: { restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 40, nelderMeadMaxEvaluations: 40 },
    bootstrap: { samples: 3 },
  }));
  assert.deepEqual([...result.dataset.trainingObservationIds].sort(), [...split.roles.training.observationIds].sort());
  assert.deepEqual([...result.development.observationIds].sort(), [...split.roles.validation.observationIds].sort());
  const selected = result.crossValidation.candidates[result.selection.selectedModel];
  assert.equal(selected.eligible, true);
  assert.ok(selected.score <= result.selection.minimumScore + result.selection.tieTolerance);
  assert.equal(result.development.selected.status, "available");
  assert.equal(result.development.baseline.status, "available");
  assert.equal(result.development.eligibleAsValidationEvidence, false);
  assert.ok(result.warnings.some(({ code }) => code === "LOW_OPTIMIZER_BUDGET"));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
