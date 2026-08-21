import test from "node:test";
import assert from "node:assert/strict";
import { sampleDistribution, validateDistribution } from "../distributions.js";
import { createRandom } from "../random.js";

test("all required distribution types validate and sample finite values", () => {
  const specifications = [
    { type: "fixed", value: 2 },
    { type: "uniform", minimum: -1, maximum: 3 },
    { type: "triangular", minimum: 0, mode: 1, maximum: 4 },
    { type: "normal", mean: 0, standardDeviation: 2 },
    { type: "truncated_normal", mean: 0, standardDeviation: 1, minimum: -0.5, maximum: 0.75 },
    { type: "lognormal", logMean: 1, logStandardDeviation: 0.2, logBase: "e" },
    { type: "empirical_discrete", values: [1, 5, 9], probabilities: [0.2, 0.3, 0.5] },
  ];
  specifications.forEach((specification, index) => {
    const validated = validateDistribution(specification);
    const value = sampleDistribution(validated, createRandom(index));
    assert.ok(Number.isFinite(value));
  });
});

test("distribution validation is strict and never infers a standard error distribution", () => {
  assert.throws(
    () => validateDistribution({ type: "normal", mean: 0, standardError: 1 }),
    { code: "UNKNOWN_DISTRIBUTION_FIELD" },
  );
  assert.throws(
    () => validateDistribution({ type: "normal", mean: 0 }),
    { code: "MISSING_DISTRIBUTION_FIELD" },
  );
  assert.throws(
    () => validateDistribution({ type: "lognormal", mean: 1, standardDeviation: 0.2 }),
    { code: "UNKNOWN_DISTRIBUTION_FIELD" },
  );
  assert.throws(
    () => validateDistribution({ type: "uniform", minimum: 2, maximum: 2 }),
    { code: "INVALID_DISTRIBUTION_BOUNDS" },
  );
  assert.throws(
    () => validateDistribution({ type: "triangular", minimum: 0, mode: 3, maximum: 2 }),
    { code: "INVALID_TRIANGULAR_PARAMETERS" },
  );
  assert.throws(
    () => validateDistribution({ type: "empirical_discrete", values: [1, 2], probabilities: [0, 0] }),
    { code: "INVALID_EMPIRICAL_PROBABILITIES" },
  );
});

test("truncated normal stays within explicit finite bounds", () => {
  const specification = {
    type: "truncated_normal",
    mean: 0,
    standardDeviation: 1,
    minimum: -0.1,
    maximum: 0.2,
  };
  const random = createRandom(91);
  for (let index = 0; index < 1000; index += 1) {
    const value = sampleDistribution(specification, random);
    assert.ok(value >= -0.1 && value <= 0.2);
  }
});
