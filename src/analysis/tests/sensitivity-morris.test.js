import test from "node:test";
import assert from "node:assert/strict";
import { morrisSensitivity } from "../sensitivity-morris.js";

function close(actual, expected, tolerance = 1e-10) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("Morris elementary effects recover a linear additive function", () => {
  const result = morrisSensitivity({
    seed: 123,
    trajectories: 20,
    levels: 4,
    parameterSpace: {
      parameters: [
        { name: "psiMaxLog10PerHour", lower: 0, upper: 1, rationale: "Synthetic Morris test." },
        { name: "carryingCapacityLog10CfuPerMl", lower: 0, upper: 1, rationale: "Synthetic Morris test." },
      ],
    },
    evaluator: ({ psiMaxLog10PerHour: x, carryingCapacityLog10CfuPerMl: y }) => 2 * x - 3 * y + 5,
  });
  const x = result.byParameter.psiMaxLog10PerHour;
  const y = result.byParameter.carryingCapacityLog10CfuPerMl;
  close(x.mu, 2);
  close(x.muStar, 2);
  close(x.sigma, 0);
  close(y.mu, -3);
  close(y.muStar, 3);
  close(y.sigma, 0);
  const repeat = morrisSensitivity({
    seed: 123,
    trajectories: 20,
    levels: 4,
    parameterSpace: result.parameterSpace,
    evaluator: ({ psiMaxLog10PerHour: a, carryingCapacityLog10CfuPerMl: b }) => 2 * a - 3 * b + 5,
  });
  assert.deepEqual(repeat.byParameter, result.byParameter);
});

const unequalBounds = {
  parameters: [
    { name: "psiMaxLog10PerHour", lower: 0, upper: 2, rationale: "Synthetic unequal-span oracle." },
    { name: "carryingCapacityLog10CfuPerMl", lower: 0, upper: 10, rationale: "Synthetic unequal-span oracle." },
  ],
};

test("Morris reports effects per normalized unit-cube coordinate, not per physical unit", () => {
  const result = morrisSensitivity({
    parameterSpace: unequalBounds,
    seed: 123,
    trajectories: 20,
    evaluator: ({ psiMaxLog10PerHour: x, carryingCapacityLog10CfuPerMl: y }) => 2 * x - 3 * y + 5,
  });
  close(result.byParameter.psiMaxLog10PerHour.mu, 4);
  close(result.byParameter.carryingCapacityLog10CfuPerMl.mu, -30);
  close(result.byParameter.psiMaxLog10PerHour.muStar, 4);
  close(result.byParameter.carryingCapacityLog10CfuPerMl.muStar, 30);
  close(result.byParameter.psiMaxLog10PerHour.sigma, 0);
  close(result.byParameter.carryingCapacityLog10CfuPerMl.sigma, 0);
  assert.equal(result.coordinate, "normalized_unit_cube");
  assert.equal(result.effectScale, "output_per_unit_normalized_coordinate");
  assert.equal(result.byParameter.psiMaxLog10PerHour.sigmaEstimable, true);
});

test("Morris normalizes the declared logarithmic transform before computing effects", () => {
  const result = morrisSensitivity({
    parameters: [{
      name: "psiMaxLog10PerHour", lower: 1, upper: 100, transform: "log10",
      rationale: "Synthetic log-coordinate oracle.",
    }],
    seed: 99,
    evaluator: ({ psiMaxLog10PerHour: x }) => ({ logResponse: 2 * Math.log10(x) }),
  });
  close(result.byParameter.psiMaxLog10PerHour.outputs.logResponse.mu, 4);
  assert.equal(result.byParameter.psiMaxLog10PerHour.transform, "log10");
});

test("Morris rejects delta values incompatible with the declared grid before evaluating", () => {
  let evaluations = 0;
  assert.throws(() => morrisSensitivity({
    parameterSpace: unequalBounds,
    levels: 4,
    delta: 0.5,
    evaluator: () => { evaluations += 1; return 1; },
  }), { code: "INVALID_MORRIS_DELTA" });
  assert.equal(evaluations, 0);
});

test("Morris accepts grid-compatible delta values and keeps every point on the grid", () => {
  for (const [levels, delta] of [[4, 1 / 3], [4, 2 / 3], [5, 0.5], [11, 0.3], [2, 1]]) {
    const result = morrisSensitivity({
      parameterSpace: unequalBounds,
      seed: 123,
      trajectories: 10,
      levels,
      delta,
      evaluator: ({ psiMaxLog10PerHour: x, carryingCapacityLog10CfuPerMl: y }) => {
        for (const normalized of [x / 2, y / 10]) {
          assert.ok(normalized >= -1e-12 && normalized <= 1 + 1e-12);
          close(normalized * (levels - 1), Math.round(normalized * (levels - 1)));
        }
        return 2 * x - 3 * y + 5;
      },
    });
    close(result.byParameter.psiMaxLog10PerHour.mu, 4);
    close(result.byParameter.carryingCapacityLog10CfuPerMl.mu, -30);
    assert.equal(result.evaluationCount, 30);
  }
});

test("one Morris trajectory cannot estimate between-trajectory sigma", () => {
  const result = morrisSensitivity({
    parameterSpace: unequalBounds,
    r: 1,
    evaluator: ({ psiMaxLog10PerHour: x }) => x,
  });
  for (const summary of result.sensitivities) {
    assert.equal(summary.count, 1);
    assert.equal(summary.sigma, null);
    assert.equal(summary["σ"], null);
    assert.equal(summary.sigmaEstimable, false);
    assert.ok(Number.isFinite(summary.mu));
  }
});
