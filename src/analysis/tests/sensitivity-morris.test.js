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
