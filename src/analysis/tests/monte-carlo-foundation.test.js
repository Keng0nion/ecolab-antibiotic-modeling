import test from "node:test";
import assert from "node:assert/strict";
import { runMonteCarlo } from "../monte-carlo.js";

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("Monte Carlo recovers known uniform statistics and uses the scientific interval label", () => {
  const result = runMonteCarlo({
    seed: 2026,
    sampleCount: 12_000,
    distributions: {
      psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
    },
    evaluator: ({ psiMaxLog10PerHour }) => psiMaxLog10PerHour,
  });
  assert.equal(result.intervalName, "parameter_uncertainty_simulation_interval");
  close(result.mean, 0.5, 0.01);
  close(result.variance, 1 / 12, 0.005);
  close(result.quantiles["0.025"], 0.025, 0.01);
  close(result.quantiles["0.5"], 0.5, 0.015);
  close(result.quantiles["0.975"], 0.975, 0.01);
  assert.equal(result.failureFraction, 0);
});

test("observation error propagation changes the interval label and failures are counted", () => {
  const result = runMonteCarlo({
    seed: 7,
    sampleCount: 100,
    propagateObservationError: true,
    distributions: {
      psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
    },
    evaluator: ({ psiMaxLog10PerHour }) => {
      if (psiMaxLog10PerHour < 0.2) throw new Error("synthetic sample failure");
      return psiMaxLog10PerHour;
    },
  });
  assert.equal(result.intervalName, "predictive_simulation_interval");
  assert.ok(result.failureFraction > 0);
  assert.equal(result.failureCount, result.failures.length);
  assert.equal(result.results.length, 100);
});

test("Monte Carlo sample values are invariant to parameter object order", () => {
  const first = runMonteCarlo({
    seed: 19,
    sampleCount: 50,
    distributions: {
      psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
      carryingCapacityLog10CfuPerMl: { type: "normal", mean: 8, standardDeviation: 0.2 },
    },
    evaluator: (parameters) => parameters.psiMaxLog10PerHour + parameters.carryingCapacityLog10CfuPerMl,
  });
  const second = runMonteCarlo({
    seed: 19,
    sampleCount: 50,
    distributions: {
      carryingCapacityLog10CfuPerMl: { type: "normal", mean: 8, standardDeviation: 0.2 },
      psiMaxLog10PerHour: { type: "uniform", minimum: 0, maximum: 1 },
    },
    evaluator: (parameters) => parameters.psiMaxLog10PerHour + parameters.carryingCapacityLog10CfuPerMl,
  });
  assert.deepEqual(
    first.results.map((entry) => entry.parameters),
    second.results.map((entry) => entry.parameters),
  );
});
