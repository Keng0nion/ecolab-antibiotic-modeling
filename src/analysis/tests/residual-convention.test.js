import test from "node:test";
import assert from "node:assert/strict";
import { computeResiduals, residualForObservation } from "../residuals.js";

test("point residual convention is observed minus predicted", () => {
  const residual = residualForObservation({ value: 4.5 }, 3.25);
  assert.equal(residual.residual, 1.25);
});

test("censored observations return residual intervals and likelihood contributions", () => {
  const [left, right, interval] = computeResiduals(
    [
      { censoring: "left", upper: 1 },
      { censoring: "right", lower: 2 },
      { censoring: "interval", lower: 3, upper: 4 },
    ],
    [1.5, 1.5, 3.5],
    { sigma: 0.4 },
  );
  assert.deepEqual(left.residualInterval, { lower: -Infinity, upper: -0.5 });
  assert.deepEqual(right.residualInterval, { lower: 0.5, upper: Infinity });
  assert.deepEqual(interval.residualInterval, { lower: -0.5, upper: 0.5 });
  for (const value of [left, right, interval]) {
    assert.equal(value.kind, "interval");
    assert.equal(Object.hasOwn(value, "residual"), false);
    assert.ok(Number.isFinite(value.logLikelihoodContribution));
  }
});
