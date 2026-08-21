import test from "node:test";
import assert from "node:assert/strict";
import { fitParameters } from "../fitting.js";

const observations = [-1, 0, 1, 2].map((x, index) => ({
  id: `o${index}`,
  role: "training",
  independentUnitId: `u${index}`,
  x,
  value: 2.5 * x - 0.4,
  measurementType: "log10_cfu",
}));

test("least-squares fitting recovers known callback parameters", () => {
  const result = fitParameters({
    observations,
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope", "intercept"],
    bounds: { slope: [0, 5], intercept: [-2, 2] },
    predictor: (parameters, observation) =>
      parameters.slope * observation.x + parameters.intercept,
    method: "exact_log10_least_squares",
    seed: 42,
    restarts: 2,
    differentialEvolution: { maxEvaluations: 1000, populationSize: 24 },
    nelderMead: { maxEvaluations: 400 },
  });
  assert.ok(Math.abs(result.fittedParameters.slope - 2.5) < 1e-4);
  assert.ok(Math.abs(result.fittedParameters.intercept + 0.4) < 1e-4);
  assert.deepEqual(
    {
      role: result.role,
      fittedOnThisData: result.fittedOnThisData,
      eligibleAsValidationEvidence: result.eligibleAsValidationEvidence,
    },
    {
      role: "training_calibration",
      fittedOnThisData: true,
      eligibleAsValidationEvidence: false,
    },
  );
});

test("fitting preserves fixed parameters outside the explicit whitelist", () => {
  const result = fitParameters({
    observations,
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope"],
    bounds: { slope: [0, 5] },
    fixedParameters: { intercept: -0.4, unrelated: 7 },
    predictor: (parameters, observation) =>
      parameters.slope * observation.x + parameters.intercept,
    seed: 7,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 600, populationSize: 16 },
    nelderMead: { maxEvaluations: 250 },
  });
  assert.ok(Math.abs(result.fittedParameters.slope - 2.5) < 1e-4);
  assert.deepEqual(result.fixedParameters, { intercept: -0.4, unrelated: 7 });
  assert.deepEqual(result.parameters, {
    intercept: -0.4,
    unrelated: 7,
    slope: result.fittedParameters.slope,
  });
});

test("scientific fitting rejects arbitrary and undeclared parameter paths", () => {
  assert.throws(
    () => fitParameters({
      observations,
      parameterWhitelist: ["slope"],
      bounds: { slope: [0, 5] },
      predictor: () => 0,
    }),
    { code: "PARAMETER_NOT_WHITELISTED" },
  );
  assert.throws(
    () => fitParameters({
      observations,
      parameterWhitelist: ["initialStates.pooled.log10PopulationDensity"],
      bounds: { "initialStates.pooled.log10PopulationDensity": [3, 8] },
      predictor: () => 0,
    }),
    { code: "UNDECLARED_INITIAL_STATE_PARAMETER" },
  );
  assert.doesNotThrow(() => fitParameters({
    observations,
    parameterWhitelist: ["initialStates.pooled.log10PopulationDensity"],
    parameterContext: { initialStateSeriesIds: ["pooled"] },
    bounds: { "initialStates.pooled.log10PopulationDensity": [3, 8] },
    predictor: () => 4,
    seed: 1,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 20, populationSize: 4 },
    nelderMead: { maxEvaluations: 10 },
  }));
});

test("fitting rejects validation observations and implicit OD-to-CFU treatment", () => {
  assert.throws(
    () =>
      fitParameters({
        observations: [{ ...observations[0], role: "validation" }],
        parameterPolicy: "generic_test_adapter",
        parameterWhitelist: ["slope"],
        bounds: { slope: [0, 5] },
        predictor: () => 0,
      }),
    { code: "VALIDATION_DATA_IN_FIT" },
  );
  assert.throws(
    () =>
      fitParameters({
        observations: [{ ...observations[0], measurementType: "OD600" }],
        parameterPolicy: "generic_test_adapter",
        parameterWhitelist: ["slope"],
        bounds: { slope: [0, 5] },
        predictor: () => 0,
      }),
    { code: "OD_OBSERVATION_MODEL_REQUIRED" },
  );
});

test("censored Gaussian fitting accepts censored training observations", () => {
  const censored = [
    { ...observations[0], censoring: "exact", value: -1 },
    { ...observations[1], censoring: "left", upper: 0.2 },
    { ...observations[2], censoring: "right", lower: 1.8 },
  ];
  const result = fitParameters({
    observations: censored,
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["mean"],
    bounds: { mean: [-2, 3] },
    predictor: ({ mean }) => mean,
    method: "censored_gaussian_likelihood",
    sigma: 0.5,
    seed: 12,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 400, populationSize: 12 },
    nelderMead: { maxEvaluations: 200 },
  });
  assert.ok(Number.isFinite(result.objectiveValue));
  assert.equal(result.residuals[1].kind, "interval");
  assert.equal(Object.hasOwn(result.residuals[1], "residual"), false);
});
