import test from "node:test";
import assert from "node:assert/strict";
import { analyzeIdentifiability } from "../identifiability.js";

test("identifiability warns for correlated/rank-deficient parameters, bounds and near optima", () => {
  const result = analyzeIdentifiability({
    parameters: { a: 0, b: 0.5 },
    bounds: { a: [0, 1], b: [0, 1] },
    evaluator: ({ a, b }) => [a + b, 2 * (a + b), 3 * (a + b)],
    optima: [
      { parameters: { a: 0, b: 0.5 }, objectiveValue: 1 },
      { parameters: { a: 0.5, b: 0 }, objectiveValue: 1 + 1e-9 },
    ],
    profiles: { parameters: ["a"], points: 5 },
    objective: ({ a, b }) => (a + b - 0.5) ** 2,
  });
  const codes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(codes.has("RANK_DEFICIENT_JACOBIAN"));
  assert.ok(codes.has("HIGH_CONDITION_NUMBER"));
  assert.ok(codes.has("STRONG_PARAMETER_CORRELATION"));
  assert.ok(codes.has("PARAMETER_AT_BOUND"));
  assert.ok(codes.has("MULTIPLE_NEAR_OPTIMA"));
  assert.equal(result.rank, 1);
  assert.equal(result.JtJ.length, 2);
});

test("limited profiles warn when flat and open", () => {
  const result = analyzeIdentifiability({
    parameters: { x: 0 },
    bounds: { x: [0, 1] },
    evaluator: () => [1, 1],
    profiles: true,
    objective: () => 5,
  });
  const codes = new Set(result.warnings.map((warning) => warning.code));
  assert.ok(codes.has("FLAT_PROFILE"));
  assert.ok(codes.has("OPEN_PROFILE"));
});
