import test from "node:test";
import assert from "node:assert/strict";
import {
  censoredGaussianLogLikelihood,
  gaussianLogLikelihood,
  logNormalIntervalProbability,
  logStandardNormalCdf,
  logStandardNormalSurvival,
} from "../likelihood.js";

test("Gaussian exact likelihood is normalized and sigma is strict", () => {
  assert.ok(Math.abs(gaussianLogLikelihood(0, 0, 1) + 0.5 * Math.log(2 * Math.PI)) < 1e-14);
  assert.throws(() => gaussianLogLikelihood(0, 0, 0), { code: "INVALID_SIGMA" });
});

test("normal log tails stay finite and symmetric at extreme z scores", () => {
  const left = logStandardNormalCdf(-40);
  const right = logStandardNormalSurvival(40);
  assert.ok(Number.isFinite(left));
  assert.ok(left < -800);
  assert.equal(left, right);
});

test("left, right and interval censored likelihoods use stable tails", () => {
  const left = censoredGaussianLogLikelihood({ censoring: "left", upper: -40 }, 0, 1);
  const right = censoredGaussianLogLikelihood({ censoring: "right", lower: 40 }, 0, 1);
  const interval = censoredGaussianLogLikelihood(
    { censoring: "interval", lower: 39.9, upper: 40 },
    0,
    1,
  );
  assert.equal(left, right);
  assert.ok(Number.isFinite(interval));
  assert.ok(interval > right);
  assert.equal(interval, logNormalIntervalProbability(39.9, 40, 0, 1));
  assert.equal(
    censoredGaussianLogLikelihood(
      { censoring: "interval", censoringBounds: { lower: 39.9, upper: 40 } },
      0,
      1,
    ),
    interval,
  );
});
