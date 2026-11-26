import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeGaussianMixturePredictions,
  summarizeConformalTrajectoryScores,
  summarizeTemporalResidualTrends,
} from "../predictive-diagnostics.js";

function close(actual, expected, tolerance = 1e-5) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("a one-component Gaussian returns its analytic median and central prediction interval", () => {
  const result = summarizeGaussianMixturePredictions({
    observations: [{ observationId: "x", value: 2, censoring: "none" }],
    samples: [{ means: [2], sigmas: [1] }],
    intervalLevel: 0.95,
  });
  const row = result.predictions[0];
  assert.equal(result.status, "available");
  assert.equal(result.sampleCount, 1);
  close(row.median, 2);
  close(row.lower, 2 - 1.959963984540054);
  close(row.upper, 2 + 1.959963984540054);
  assert.equal(row.intervalCovered, true);
  close(row.exactLogPredictiveDensity, -Math.log(2 * Math.PI) / 2);
});

test("a Gaussian mixture averages component probabilities before reporting density and quantiles", () => {
  const result = summarizeGaussianMixturePredictions({
    observations: [{ observationId: "x", value: 0, censoring: "none" }],
    samples: [
      { means: [-1], sigmas: [1] },
      { means: [1], sigmas: [1] },
    ],
    intervalLevel: 0.95,
  });
  const row = result.predictions[0];
  close(row.median, 0);
  close(row.exactLogPredictiveDensity, -0.5 * Math.log(2 * Math.PI) - 0.5);
  close(row.lower, -row.upper);
  assert.equal(row.intervalCovered, true);
});

test("left-censored observations are scored as an event below the limit, not as exact values", () => {
  const result = summarizeGaussianMixturePredictions({
    observations: [{ observationId: "lod", value: 0, censoring: "left", censoringBounds: { upper: 0 } }],
    samples: [{ means: [0], sigmas: [1] }],
    intervalLevel: 0.95,
  });
  const row = result.predictions[0];
  close(row.censorProbability, 0.5);
  close(row.censoredLogScore, Math.log(0.5));
  assert.equal(row.intervalCovered, null);
  assert.equal(row.exactLogPredictiveDensity, null);
  assert.equal(result.summary.exactObservationCount, 0);
  assert.equal(result.summary.leftCensoredObservationCount, 1);
});

test("empty draws, invalid sigmas, and misaligned vectors are rejected explicitly", () => {
  const input = {
    observations: [{ observationId: "x", value: 0, censoring: "none" }],
    samples: [{ means: [0], sigmas: [1] }],
    intervalLevel: 0.95,
  };
  assert.throws(() => summarizeGaussianMixturePredictions({ ...input, samples: [] }), { code: "EMPTY_PREDICTIVE_SAMPLES" });
  assert.throws(() => summarizeGaussianMixturePredictions({ ...input, samples: [{ means: [0], sigmas: [0] }] }), { code: "INVALID_PREDICTIVE_SIGMA" });
  assert.throws(() => summarizeGaussianMixturePredictions({ ...input, samples: [{ means: [], sigmas: [] }] }), { code: "PREDICTIVE_VECTOR_LENGTH_MISMATCH" });
  assert.throws(() => summarizeGaussianMixturePredictions({ ...input, intervalLevel: 1 }), { code: "INVALID_PREDICTIVE_INTERVAL_LEVEL" });
});

test("trajectory calibration uses a whole-unit max residual and the finite-sample conformal rank", () => {
  const result = summarizeConformalTrajectoryScores({
    scores: [
      { independentUnitId: "culture-a", maximumAbsoluteResidual: 0.2 },
      { independentUnitId: "culture-b", maximumAbsoluteResidual: 0.5 },
      { independentUnitId: "culture-c", maximumAbsoluteResidual: 0.1 },
    ],
    intervalLevels: [0.5, 0.8, 0.95],
  });
  assert.equal(result.method, "split_conformal_max_absolute_trajectory_residual");
  assert.deepEqual(result.calibrationIndependentUnitIds, ["culture-a", "culture-b", "culture-c"]);
  assert.deepEqual(result.levels["0.5"], {
    status: "available", intervalLevel: 0.5, calibrationUnitCount: 3,
    oneBasedOrderStatistic: 2, radius: 0.2,
  });
  assert.equal(result.levels["0.8"].status, "insufficient_finite_sample_resolution");
  assert.equal(result.levels["0.8"].oneBasedOrderStatistic, 4);
  assert.equal(result.levels["0.8"].radius, null);
  assert.equal(result.levels["0.95"].radius, null);
});

test("trajectory calibration rejects duplicate units, negative scores, and invalid coverage levels", () => {
  const scores = [
    { independentUnitId: "a", maximumAbsoluteResidual: 0.1 },
    { independentUnitId: "a", maximumAbsoluteResidual: 0.2 },
  ];
  assert.throws(() => summarizeConformalTrajectoryScores({ scores, intervalLevels: [0.5] }), { code: "DUPLICATE_CALIBRATION_UNIT" });
  assert.throws(() => summarizeConformalTrajectoryScores({
    scores: [{ independentUnitId: "a", maximumAbsoluteResidual: -1 }], intervalLevels: [0.5],
  }), { code: "INVALID_TRAJECTORY_SCORE" });
  assert.throws(() => summarizeConformalTrajectoryScores({ scores: [], intervalLevels: [0.5] }), { code: "EMPTY_TRAJECTORY_CALIBRATION" });
  assert.throws(() => summarizeConformalTrajectoryScores({ scores: [{ independentUnitId: "a", maximumAbsoluteResidual: 1 }], intervalLevels: [1] }), { code: "INVALID_PREDICTIVE_INTERVAL_LEVEL" });
});

test("temporal residual screening ranks ties and excludes left-censored values", () => {
  const result = summarizeTemporalResidualTrends({
    observations: [
      { independentUnitId: "culture-a", timeHours: 0, value: 1, censoring: "none" },
      { independentUnitId: "culture-a", timeHours: 1, value: 1, censoring: "none" },
      { independentUnitId: "culture-a", timeHours: 2, value: 0, censoring: "left" },
      { independentUnitId: "culture-a", timeHours: 3, value: 2, censoring: "none" },
      { independentUnitId: "culture-a", timeHours: 4, value: 3, censoring: "none" },
      { independentUnitId: "culture-a", timeHours: 5, value: 3, censoring: "none" },
    ],
    predictions: [0, 0, 100, 0, 0, 0],
  });
  assert.equal(result.method, "descriptive_spearman_time_residual_by_independent_unit");
  assert.equal(result.trajectoryCount, 1);
  assert.equal(result.evaluatedTrajectoryCount, 1);
  assert.equal(result.highMagnitudeTrendTrajectoryCount, 1);
  assert.deepEqual(result.trajectories[0], {
    independentUnitId: "culture-a",
    exactObservationCount: 5,
    leftCensoredObservationCount: 1,
    status: "evaluated",
    spearmanRho: 0.9486832980505138,
    highMagnitudeTrend: true,
  });
  assert.match(result.interpretation, /no p-values/i);
});

test("temporal residual screening labels small samples and constant vectors without inventing correlations", () => {
  const result = summarizeTemporalResidualTrends({
    observations: [
      ...[0, 1, 2, 3].map((timeHours) => ({
        independentUnitId: "small",
        timeHours,
        value: timeHours,
        censoring: "none",
      })),
      ...[0, 1, 2, 3, 4].map((timeHours) => ({
        independentUnitId: "constant",
        timeHours,
        value: 0,
        censoring: "none",
      })),
    ],
    predictions: [0, 0, 0, 0, 0, 0, 0, 0, 0],
  });
  assert.equal(result.insufficientExactPointTrajectoryCount, 1);
  assert.equal(result.undefinedCorrelationTrajectoryCount, 1);
  assert.deepEqual(result.trajectories.map(({ independentUnitId, status, spearmanRho, highMagnitudeTrend }) => ({
    independentUnitId, status, spearmanRho, highMagnitudeTrend,
  })), [
    { independentUnitId: "constant", status: "undefined_correlation", spearmanRho: null, highMagnitudeTrend: false },
    { independentUnitId: "small", status: "insufficient_exact_points", spearmanRho: null, highMagnitudeTrend: false },
  ]);
});
