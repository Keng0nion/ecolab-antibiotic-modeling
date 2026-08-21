import test from "node:test";
import assert from "node:assert/strict";
import { assessDatasetQuality } from "../dataset-quality.js";

function observation(overrides = {}) {
  return {
    observationId: "obs-1",
    seriesId: "series-1",
    independentUnitId: "unit-1",
    role: "training",
    timeHours: 0,
    drugId: "none",
    concentrationMgPerL: 0,
    measurementType: "log10_cfu_per_ml",
    value: 6,
    censoring: "none",
    censoringBounds: null,
    replicate: "replicate-1",
    conditions: {
      organism: "Escherichia coli",
      strain: "BW25113",
      medium: "M9",
      temperature: { value: 37, unit: "degC" },
    },
    ...overrides,
  };
}

function dataset(observations, metadata = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId: "quality-dataset", title: "Quality", ...metadata },
    observations,
  };
}

test("a consistent dataset produces a valid report and complete summary", () => {
  const input = dataset([
    observation(),
    observation({ observationId: "obs-2", timeHours: 2 }),
    observation({
      observationId: "obs-3",
      seriesId: "series-2",
      independentUnitId: "unit-2",
      role: "validation",
      measurementType: "od600",
      value: 0.3,
      replicate: "replicate-2",
    }),
  ]);
  const snapshot = structuredClone(input);
  const report = assessDatasetQuality(input);
  assert.equal(report.valid, true);
  assert.equal(report.summary.observationCount, 3);
  assert.equal(report.summary.uniqueObservationIdCount, 3);
  assert.equal(report.summary.seriesCount, 2);
  assert.equal(report.summary.independentUnitCount, 2);
  assert.deepEqual(report.summary.byRole, { training: 2, validation: 1, development: 0 });
  assert.equal(report.summary.byMeasurementType.od600, 1);
  assert.ok(report.info.some(({ code }) => code === "OD_SEMANTICS_PRESERVED"));
  assert.deepEqual(input, snapshot);
});

test("quality report enumerates duplicate IDs, invalid values, inconsistent series, and role leakage", () => {
  const report = assessDatasetQuality(dataset([
    observation(),
    observation({
      observationId: "obs-1",
      independentUnitId: "unit-1",
      role: "validation",
      timeHours: -1,
      measurementType: "od600",
      value: -0.2,
      drugId: "ciprofloxacin",
      concentrationMgPerL: -1,
      replicate: "replicate-2",
      conditions: {
        organism: "Escherichia coli",
        strain: "MG1655",
        medium: "LB",
        temperature: { value: 30, unit: "degC" },
      },
    }),
  ]));
  const codes = new Set(report.errors.map(({ code }) => code));
  assert.equal(report.valid, false);
  assert.ok(codes.has("DUPLICATE_OBSERVATION_ID"));
  assert.ok(codes.has("INVALID_TIME"));
  assert.ok(codes.has("INVALID_CONCENTRATION"));
  assert.ok(codes.has("NEGATIVE_MEASUREMENT_VALUE"));
  assert.ok(codes.has("INCONSISTENT_SERIES_MEASUREMENT"));
  assert.ok(codes.has("INCONSISTENT_SERIES_FIELD"));
  assert.ok(codes.has("INCONSISTENT_SERIES_CONDITIONS"));
  assert.ok(codes.has("INDEPENDENT_UNIT_ROLE_LEAKAGE"));
  const leakage = report.errors.find(({ code }) => code === "INDEPENDENT_UNIT_ROLE_LEAKAGE");
  assert.deepEqual(leakage.details.roles, ["training", "validation"]);
});

test("dataset-level conditions satisfy only explicitly documented missing condition fields", () => {
  const conditions = {
    organism: "Escherichia coli",
    strain: "BW25113",
    medium: "M9",
    temperature: { value: 37, unit: "degC" },
  };
  const inherited = assessDatasetQuality(dataset([
    observation({ conditions: {} }),
  ], { conditions }));
  assert.equal(inherited.warnings.some(({ code }) => code === "MISSING_KEY_CONDITION_METADATA"), false);

  const missing = assessDatasetQuality(dataset([
    observation({ conditions: { organism: "Escherichia coli" } }),
  ]));
  const warning = missing.warnings.find(({ code }) => code === "MISSING_KEY_CONDITION_METADATA");
  assert.deepEqual(warning.details.missing, ["strain", "medium", "temperature"]);
});

test("censoring validation checks exact bounds and reports retained-value inconsistencies", () => {
  const report = assessDatasetQuality(dataset([
    observation({
      observationId: "left-invalid",
      seriesId: "left",
      censoring: "left",
      censoringBounds: { lower: 1 },
    }),
    observation({
      observationId: "right-warning",
      seriesId: "right",
      independentUnitId: "unit-2",
      censoring: "right",
      censoringBounds: { lower: 7 },
      value: 6,
    }),
    observation({
      observationId: "interval-invalid",
      seriesId: "interval",
      independentUnitId: "unit-3",
      censoring: "interval",
      censoringBounds: { lower: 7, upper: 6 },
    }),
    observation({
      observationId: "none-invalid",
      seriesId: "none",
      independentUnitId: "unit-4",
      censoring: "none",
      censoringBounds: { upper: 1 },
    }),
  ]));
  const errorCodes = new Set(report.errors.map(({ code }) => code));
  const warningCodes = new Set(report.warnings.map(({ code }) => code));
  assert.ok(errorCodes.has("INVALID_LEFT_CENSORING_BOUNDS"));
  assert.ok(errorCodes.has("INVALID_INTERVAL_CENSORING_BOUNDS"));
  assert.ok(errorCodes.has("UNEXPECTED_CENSORING_BOUNDS"));
  assert.ok(warningCodes.has("CENSORED_VALUE_BELOW_LOWER_BOUND"));
  assert.ok(report.info.some(({ code }) => code === "CENSORING_PRESENT"));
  assert.equal(report.summary.byCensoring.left, 1);
  assert.equal(report.summary.byCensoring.right, 1);
  assert.equal(report.summary.byCensoring.interval, 1);
});

test("repeated time points are warnings while mixed measurement semantics remain errors", () => {
  const report = assessDatasetQuality(dataset([
    observation(),
    observation({ observationId: "obs-2" }),
  ]));
  assert.ok(report.warnings.some(({ code }) => code === "DUPLICATE_SERIES_TIME"));
  assert.equal(report.errors.some(({ code }) => code === "INCONSISTENT_SERIES_MEASUREMENT"), false);
});

test("invalid dataset shape returns a structured report rather than mutating or throwing", () => {
  const report = assessDatasetQuality({ metadata: null, observations: "no" });
  assert.equal(report.valid, false);
  assert.deepEqual(report.errors.map(({ code }) => code), ["INVALID_DATASET_METADATA", "INVALID_OBSERVATIONS"]);
  assert.equal(report.summary.observationCount, 0);
});
