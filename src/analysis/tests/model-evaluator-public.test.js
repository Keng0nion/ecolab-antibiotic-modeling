import test from "node:test";
import assert from "node:assert/strict";
import {
  createObservationDatasetEvaluator,
  createObservationPredictionEvaluator,
  createScalarSummaryEvaluator,
  evaluateObservationDataset,
  evaluateObservationSeries,
} from "../model-evaluator.js";

function resolvedModel() {
  return {
    kind: "ResolvedModel",
    ref: {
      id: "ecolab.single-population.regoes-logistic",
      version: "1.0.0",
      implementationId: "regoes-logistic-piecewise-analytic-v1",
      parameterSetId: "base",
      parameterSetVersion: "1.0.0",
    },
    parameters: {
      psiMaxLog10PerHour: 0.3,
      carryingCapacityLog10CfuPerMl: 9,
      drugs: {
        ciprofloxacin: {
          zMicMgPerL: 1,
          hillKappa: 2,
          psiMinLog10PerHour: -1,
          paperBrothDilutionMicMgPerL: 1,
        },
      },
    },
    warnings: [],
  };
}

function observation(overrides = {}) {
  return {
    observationId: "o-0",
    seriesId: "series-a",
    independentUnitId: "unit-a",
    role: "training",
    timeHours: 0,
    drugId: "ciprofloxacin",
    concentrationMgPerL: 0,
    measurementType: "log10_cfu_per_ml",
    value: 6,
    censoring: "none",
    censoringBounds: null,
    replicate: "r1",
    conditions: {},
    ...overrides,
  };
}

function dataset(observations) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId: "dataset-a", title: "Evaluator data" },
    observations,
  };
}

const initialStates = {
  "series-a": { log10PopulationDensity: 6 },
  "series-b": { log10PopulationDensity: 5 },
};

test("observation-derived protocols preserve right-continuous switch boundaries", () => {
  const result = evaluateObservationSeries({
    resolvedModel: resolvedModel(),
    initialStates,
    observations: [
      observation(),
      observation({ observationId: "o-1", timeHours: 1, concentrationMgPerL: 10 }),
      observation({ observationId: "o-2", timeHours: 2, concentrationMgPerL: 10 }),
    ],
  });
  assert.deepEqual(
    result.protocol.segments.map(({ startHours, endHours, concentrationMgPerL }) => ({
      startHours,
      endHours,
      concentrationMgPerL,
    })),
    [
      { startHours: 0, endHours: 1, concentrationMgPerL: 0 },
      { startHours: 1, endHours: 2, concentrationMgPerL: 10 },
    ],
  );
  assert.equal(result.protocol.boundaryConvention, "segments_are_[start,end);_final_endpoint_included");
  assert.equal(result.trajectory[1].concentrationMgPerL, 10);
  assert.ok(result.predictions[1] > result.predictions[0], "pre-boundary interval should use concentration zero");
  assert.ok(result.predictions[2] < result.predictions[1], "post-boundary interval should use concentration ten");
});

test("ambiguous terminal concentration changes require an explicit protocol builder", () => {
  const observations = [
    observation(),
    observation({ observationId: "o-1", timeHours: 1, concentrationMgPerL: 10 }),
  ];
  assert.throws(
    () => evaluateObservationSeries({ resolvedModel: resolvedModel(), initialStates, observations }),
    { code: "TERMINAL_EXPOSURE_AMBIGUOUS" },
  );
  const result = evaluateObservationSeries({
    resolvedModel: resolvedModel(),
    initialStates,
    observations,
    protocolBuilder: (series) => ({
      kind: "piecewise_constant",
      drugId: series.drugId,
      segments: [{
        start: { value: 0, unit: "h" },
        end: { value: 1, unit: "h" },
        concentration: { value: 0, unit: "mg/L" },
      }],
    }),
  });
  assert.ok(result.predictions[1] > result.predictions[0]);
});

test("dataset evaluation groups by series and restores original observation alignment", () => {
  const observations = [
    observation({ observationId: "a-1", timeHours: 1 }),
    observation({ observationId: "b-0", seriesId: "series-b", independentUnitId: "unit-b" }),
    observation({ observationId: "a-0" }),
    observation({
      observationId: "b-1",
      seriesId: "series-b",
      independentUnitId: "unit-b",
      timeHours: 1,
    }),
  ];
  const result = evaluateObservationDataset({
    resolvedModel: resolvedModel(),
    initialStates,
    dataset: dataset(observations),
  });
  assert.deepEqual(result.predictionRecords.map(({ observationId }) => observationId), ["a-1", "b-0", "a-0", "b-1"]);
  assert.equal(result.predictions[2], 6);
  assert.equal(result.predictions[1], 5);
  assert.equal(result.seriesCount, 2);
});

test("only exact CFU measurement types are automatic and OD requires a callback", () => {
  const cfu = evaluateObservationSeries({
    resolvedModel: resolvedModel(),
    initialStates,
    observations: [
      observation({ measurementType: "cfu_per_ml", value: 1_000_000 }),
      observation({ observationId: "o-1", timeHours: 1, measurementType: "cfu_per_ml", value: 1 }),
    ],
  });
  assert.equal(cfu.predictions[0], 1_000_000);
  const odObservations = [
    observation({ measurementType: "od600", value: 0.1 }),
    observation({ observationId: "o-1", timeHours: 1, measurementType: "od600", value: 0.2 }),
  ];
  assert.throws(
    () => evaluateObservationSeries({ resolvedModel: resolvedModel(), initialStates, observations: odObservations }),
    { code: "OD_OBSERVATION_MODEL_REQUIRED" },
  );
  const od = evaluateObservationSeries({
    resolvedModel: resolvedModel(),
    initialStates,
    observations: odObservations,
    odObservationModel: (_reportedLog10, _observation, context) => context.latentCfuPerMl / 1e7,
  });
  assert.equal(od.predictions[0], 0.1);
  assert.throws(
    () => evaluateObservationSeries({
      resolvedModel: resolvedModel(),
      initialStates,
      observations: [observation({ measurementType: "OD600" }), observation({ observationId: "o-1", timeHours: 1 })],
    }),
    { code: "UNSUPPORTED_MEASUREMENT_TYPE" },
  );
});

test("detection limits are explicit reporting rules and never censor latent dynamics", () => {
  const observations = [
    observation({ concentrationMgPerL: 100, value: 2 }),
    observation({ observationId: "o-1", timeHours: 5, concentrationMgPerL: 100, value: 2 }),
  ];
  const options = {
    resolvedModel: resolvedModel(),
    initialStates: { "series-a": { log10PopulationDensity: 2 } },
    observations,
    detectionLimit: { value: 100, unit: "CFU/mL" },
  };
  const latent = evaluateObservationSeries(options);
  const reported = evaluateObservationSeries({ ...options, detectionLimitHandling: "report_at_limit" });
  assert.ok(latent.predictions[1] < 2);
  assert.equal(reported.predictions[1], 2);
  assert.equal(reported.predictionRecords[1].belowDetectionLimit, true);
  assert.equal(reported.trajectory[1].latentLog10PopulationDensity, latent.trajectory[1].latentLog10PopulationDensity);
});

test("public evaluator adapters apply only whitelisted overrides and support scalar summaries", () => {
  const observations = [observation(), observation({ observationId: "o-1", timeHours: 1 })];
  const base = {
    resolvedModel: resolvedModel(),
    initialStates,
    dataset: dataset(observations),
  };
  const evaluator = createObservationDatasetEvaluator(base);
  const baseline = evaluator();
  const faster = evaluator({ psiMaxLog10PerHour: 0.6 });
  assert.ok(faster.predictions[1] > baseline.predictions[1]);
  assert.throws(() => evaluator({ arbitrary: 1 }), { code: "PARAMETER_NOT_WHITELISTED" });

  const predictionEvaluator = createObservationPredictionEvaluator(base);
  assert.deepEqual(predictionEvaluator(), baseline.predictions);

  const scalar = createScalarSummaryEvaluator({
    ...base,
    summary: { kind: "final_prediction", seriesId: "series-a" },
  });
  assert.equal(scalar(), baseline.predictions[1]);
  assert.equal(
    scalar({ "initialStates.series-a.log10PopulationDensity": 5 }),
    evaluator({ "initialStates.series-a.log10PopulationDensity": 5 }).predictions[1],
  );
});

test("the evaluator never infers initial state or permits multiple drugs in one series", () => {
  const observations = [observation(), observation({ observationId: "o-1", timeHours: 1 })];
  assert.throws(
    () => evaluateObservationSeries({ resolvedModel: resolvedModel(), observations }),
    { code: "INITIAL_LATENT_STATE_REQUIRED" },
  );
  assert.throws(
    () => evaluateObservationSeries({
      resolvedModel: resolvedModel(),
      initialStates,
      observations: [observations[0], { ...observations[1], drugId: "none", concentrationMgPerL: 0 }],
    }),
    { code: "MULTIPLE_DRUGS_IN_SERIES" },
  );
});
