import test from "node:test";
import assert from "node:assert/strict";
import { nelderMead, optimizeBounded } from "../optimizers.js";

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

test("Nelder-Mead retains a better reflection when the expansion budget is exhausted", () => {
  const evaluated = [];
  const result = nelderMead({
    objective: ({ x }) => {
      evaluated.push(x);
      return (x - 0.8) ** 2;
    },
    bounds: { x: [0, 1] },
    start: { x: 0.2 },
    maxEvaluations: 3,
  });
  assert.deepEqual(evaluated, [0.2, 0.25, 0.3]);
  assert.equal(result.bestParameters.x, 0.3);
  assert.equal(result.bestValue, 0.25);
  assert.equal(result.evaluationCount, 3);
  assert.equal(result.converged, false);
  assert.equal(result.terminationReason, "maximum_evaluations");
});

test("Nelder-Mead returns the best actually evaluated point for incomplete budgets", () => {
  for (const maxEvaluations of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
    const evaluated = [];
    const result = nelderMead({
      objective: (vector) => {
        const value = (vector[0] - 0.8) ** 2 + 2 * (vector[1] - 0.7) ** 2;
        evaluated.push({ vector: [...vector], value });
        return value;
      },
      bounds: [[0, 1], [0, 1]],
      start: [0.2, 0.3],
      maxEvaluations,
    });
    const best = evaluated.reduce((left, right) => right.value < left.value ? right : left);
    assert.deepEqual(result.bestParameters, best.vector, `budget ${maxEvaluations}`);
    assert.equal(result.bestValue, best.value, `budget ${maxEvaluations}`);
    assert.equal(result.evaluationCount, maxEvaluations);
    assert.equal(evaluated.length, maxEvaluations);
    assert.equal(result.converged, false);
    assert.equal(result.terminationReason, "maximum_evaluations");
  }
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
