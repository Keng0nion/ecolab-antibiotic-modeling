import test from "node:test";
import assert from "node:assert/strict";
import { optimizeBounded } from "../optimizers.js";

test("bounded DE then Nelder-Mead deterministically recovers a quadratic optimum", () => {
  const options = {
    objective: ({ x, y }) => (x - 1.25) ** 2 + (y + 0.75) ** 2,
    bounds: { x: [-5, 5], y: [-5, 5] },
    seed: 0x4e6f6465,
    restarts: 2,
    differentialEvolution: { maxEvaluations: 1200, populationSize: 24 },
    nelderMead: { maxEvaluations: 500 },
  };
  const first = optimizeBounded(options);
  const second = optimizeBounded(options);
  assert.deepEqual(second, first);
  assert.ok(Math.abs(first.bestParameters.x - 1.25) < 1e-4);
  assert.ok(Math.abs(first.bestParameters.y + 0.75) < 1e-4);
  assert.equal(first.restarts.length, 2);
  assert.equal(first.starts.length, 2);
  assert.ok(first.evaluationCount > 0);
  assert.equal(first.randomAlgorithm, "xoshiro128ss-splitmix32-v1");
  assert.ok(first.restarts.every((run) => run.seed !== undefined && run.bounds));
  assert.ok(first.restarts.every((run) => Array.isArray(run.failedCandidates)));
});

test("budget exhaustion is explicitly not convergence", () => {
  const result = optimizeBounded({
    objective: ({ x }) => (x - 0.33) ** 2,
    bounds: { x: [0, 1] },
    seed: 1,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 4, populationSize: 4 },
    nelderMead: { maxEvaluations: 2 },
  });
  assert.equal(result.converged, false);
  assert.equal(result.terminationReason, "maximum_evaluations");
});
