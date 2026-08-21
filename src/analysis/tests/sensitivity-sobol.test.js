import test from "node:test";
import assert from "node:assert/strict";
import { sobolJansenSensitivity } from "../sensitivity-sobol.js";

function close(actual, expected, tolerance) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);
}

test("Sobol–Jansen approximates canonical Ishigami first and total indices", () => {
  const a = 7;
  const b = 0.1;
  const result = sobolJansenSensitivity({
    seed: 20260821,
    sampleCount: 12_000,
    distributions: {
      x1: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
      x2: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
      x3: { type: "uniform", minimum: -Math.PI, maximum: Math.PI },
    },
    evaluator: ({ x1, x2, x3 }) => Math.sin(x1) + a * Math.sin(x2) ** 2 + b * x3 ** 4 * Math.sin(x1),
  });
  close(result.byParameter.x1.firstOrder, 0.3139, 0.045);
  close(result.byParameter.x2.firstOrder, 0.4424, 0.045);
  close(result.byParameter.x3.firstOrder, 0, 0.05);
  close(result.byParameter.x1.totalOrder, 0.5576, 0.05);
  close(result.byParameter.x2.totalOrder, 0.4424, 0.045);
  close(result.byParameter.x3.totalOrder, 0.2437, 0.05);
});

test("Sobol explicitly rejects correlated inputs", () => {
  assert.throws(
    () => sobolJansenSensitivity({
      seed: 1,
      sampleCount: 100,
      correlations: [[1, 0.5], [0.5, 1]],
      distributions: {
        x1: { type: "uniform", minimum: 0, maximum: 1 },
        x2: { type: "uniform", minimum: 0, maximum: 1 },
      },
      evaluator: ({ x1, x2 }) => x1 + x2,
    }),
    { code: "CORRELATED_INPUTS_UNSUPPORTED" },
  );
});
