import test from "node:test";
import assert from "node:assert/strict";
import { createRandom } from "../../../src/analysis/random.js";
import {
  ar1Residuals,
  gaussian,
  requiredCalibrationUnits,
  sampleStandardDeviation,
  simulateCoverage,
  wilsonInterval,
} from "../lib/prediction-coverage.js";

test("conformal order-statistic resolution requires 4, 9 and 19 calibration units", () => {
  assert.equal(requiredCalibrationUnits(0.8), 4);
  assert.equal(requiredCalibrationUnits(0.9), 9);
  assert.equal(requiredCalibrationUnits(0.95), 19);
  assert.equal(requiredCalibrationUnits(0.5), 1);
  assert.throws(() => requiredCalibrationUnits(0), RangeError);
  assert.throws(() => requiredCalibrationUnits(1), RangeError);
});

test("Wilson interval brackets the point estimate and stays inside [0, 1]", () => {
  const interval = wilsonInterval(8, 10);
  assert.ok(interval.lower < 0.8 && interval.upper > 0.8);
  assert.ok(interval.lower >= 0 && interval.upper <= 1);
  assert.deepEqual(wilsonInterval(0, 10).lower, 0);
  assert.ok(wilsonInterval(10, 10).upper > 0.999);
  assert.throws(() => wilsonInterval(11, 10), RangeError);
  assert.throws(() => wilsonInterval(1, 0), RangeError);
});

test("gaussian draws are deterministic per seed and finite", () => {
  const first = createRandom(42);
  const second = createRandom(42);
  const left = Array.from({ length: 50 }, () => gaussian(first));
  const right = Array.from({ length: 50 }, () => gaussian(second));
  assert.deepEqual(left, right);
  assert.ok(left.every(Number.isFinite));
});

test("AR(1) residuals preserve length, marginal scale and lag-one correlation", () => {
  const rng = createRandom(7);
  const residuals = ar1Residuals(rng, 20_000, 0.01, 0.8);
  assert.equal(residuals.length, 20_000);
  const mean = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const variance = residuals.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (residuals.length - 1);
  assert.ok(Math.abs(mean) < 0.0005);
  assert.ok(Math.abs(Math.sqrt(variance) - 0.01) < 0.0008);
  let covariance = 0;
  for (let index = 1; index < residuals.length; index += 1) covariance += residuals[index] * residuals[index - 1];
  covariance /= residuals.length - 1;
  assert.ok(Math.abs(covariance / variance - 0.8) < 0.05);
  assert.throws(() => ar1Residuals(rng, 10, 0, 0.5), RangeError);
  assert.throws(() => ar1Residuals(rng, 10, 1, 1), RangeError);
});

test("simulateCoverage is deterministic and respects degenerate radii", () => {
  const base = { count: 12, sigma: 0.01, replicates: 500, seed: 11 };
  const first = simulateCoverage({ ...base, radius: 0.02 });
  const second = simulateCoverage({ ...base, radius: 0.02 });
  assert.deepEqual(first, second);
  assert.equal(simulateCoverage({ ...base, radius: 0 }).covered, 0);
  const generous = simulateCoverage({ ...base, sigma: 1e-9, radius: 0.02 });
  assert.equal(generous.covered, generous.replicates);
  assert.equal(generous.pointCoverage, 1);
});

test("AR(1) smoothing lowers the mean maximum residual and does not reduce simultaneous coverage", () => {
  // Positive within-trajectory correlation reduces the effective number of independent
  // time points, so the maximum absolute residual is smaller than the IID case at the
  // same marginal scale. Simultaneous coverage therefore stays at or above the IID value.
  const common = { count: 44, sigma: 0.00483, radius: 0.013, replicates: 4_000 };
  const iid = simulateCoverage({ ...common, seed: 21 });
  const ar1 = simulateCoverage({ ...common, seed: 21, phi: 0.8 });
  assert.ok(ar1.meanMaximumAbsoluteResidual < iid.meanMaximumAbsoluteResidual);
  assert.ok(ar1.coverage >= iid.coverage - 0.02, `AR(1) ${ar1.coverage} vs IID ${iid.coverage}`);
});

test("larger between-curve offsets lower coverage and raise the mean maximum residual", () => {
  const common = { count: 44, sigma: 0.00265, radius: 0.013, replicates: 4_000, seed: 33 };
  const small = simulateCoverage({ ...common, offsetSigma: 0.0023 });
  const large = simulateCoverage({ ...common, offsetSigma: 0.009 });
  assert.ok(large.coverage < small.coverage, `large ${large.coverage} should be below small ${small.coverage}`);
  assert.ok(large.meanMaximumAbsoluteResidual > small.meanMaximumAbsoluteResidual);
  assert.ok(small.coverage > 0.9);
});

test("sample standard deviation uses n − 1 and rejects degenerate input", () => {
  assert.equal(sampleStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9]), Math.sqrt(32 / 7));
  assert.equal(sampleStandardDeviation([1]), null);
  assert.equal(sampleStandardDeviation([1, Number.NaN]), null);
});
