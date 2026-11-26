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

test("log optimization coordinates preserve natural-scale estimates and predictions", () => {
  const result = fitParameters({
    observations: [0, 1, 2, 3].map((x, index) => ({
      id: `log-${index}`, role: "training", independentUnitId: `log-u-${index}`,
      x, value: 0.04 * x - 0.2, measurementType: "log10_cfu",
    })),
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["rate", "negativeRate"],
    bounds: { rate: [1e-4, 2], negativeRate: [-12, -1e-4] },
    initialParameters: { rate: 0.3, negativeRate: -1 },
    optimizationTransforms: { rate: "log", negativeRate: "negative_log" },
    predictor: (parameters, observation) => parameters.rate * observation.x + parameters.negativeRate,
    method: "exact_log10_least_squares",
    seed: 42,
    restarts: 2,
    differentialEvolution: { maxEvaluations: 1200, populationSize: 24 },
    nelderMead: { maxEvaluations: 500 },
  });
  assert.ok(Math.abs(result.fittedParameters.rate - 0.04) < 1e-4);
  assert.ok(Math.abs(result.fittedParameters.negativeRate + 0.2) < 1e-4);
  assert.ok(Math.abs(result.resolvedParameters.rate - 0.04) < 1e-4);
  assert.equal(result.optimization.coordinateSpace, "transformed");
  assert.deepEqual(result.bounds, { rate: [1e-4, 2], negativeRate: [-12, -1e-4] });
  assert.deepEqual(result.optimizationCoordinates.transforms, {
    rate: "log", negativeRate: "negative_log",
  });
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
  assert.equal(result.status, "NOT_IDENTIFIABLE");
  assert.equal(result.fittedParameters, null);
  assert.equal(result.resolvedParameters, null);
  assert.deepEqual(result.fitDiagnostics.identifiability, {
    status: "NOT_IDENTIFIABLE",
    method: "uncensored_observation_count",
    exactObservationCount: 1,
    requiredExactObservationCount: 2,
    freeParameterCount: 1,
    reason: "insufficient_uncensored_observations",
  });
});

test("least-squares fit with too few exact observations returns status without numeric estimates", () => {
  const result = fitParameters({
    observations: observations.slice(0, 2),
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope", "intercept"],
    bounds: { slope: [0, 5], intercept: [-2, 2] },
    predictor: (parameters, observation) => parameters.slope * observation.x + parameters.intercept,
    method: "least_squares",
  });

  assert.equal(result.status, "NOT_IDENTIFIABLE");
  assert.equal(result.parameterPolicy, "generic_test_adapter");
  assert.equal(result.fittedParameters, null);
  assert.equal(result.resolvedParameters, null);
  assert.equal(result.objectiveValue, null);
  assert.equal(result.predictions, null);
  assert.equal(result.fitDiagnostics.identifiability.reason, "insufficient_uncensored_observations");
  assert.equal(result.optimization, null, "the optimizer must not run on ineligible exact data");
});

test("least-squares local rank deficiency withholds parameter numbers", () => {
  const result = fitParameters({
    observations,
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope"],
    bounds: { slope: [0, 5] },
    predictor: () => 1,
    method: "least_squares",
    seed: 42,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 100, populationSize: 8 },
    nelderMead: { maxEvaluations: 80 },
  });

  assert.equal(result.status, "NOT_IDENTIFIABLE");
  assert.equal(result.fittedParameters, null);
  assert.equal(result.fitDiagnostics.identifiability.method, "local_prediction_jacobian");
  assert.equal(result.fitDiagnostics.identifiability.rank, 0);
  assert.equal(result.fitDiagnostics.identifiability.parameterCount, 1);
});

test("fit diagnostics list every parameter at either fitted bound", () => {
  const result = fitParameters({
    observations: observations.map((observation) => ({ ...observation, value: 10 * observation.x })),
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope"],
    bounds: { slope: [0, 2] },
    predictor: (parameters, observation) => parameters.slope * observation.x,
    method: "least_squares",
    seed: 43,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 600, populationSize: 16 },
    nelderMead: { maxEvaluations: 400 },
  });

  assert.equal(result.fitDiagnostics.boundary.status, "ASSESSED");
  assert.deepEqual(result.fitDiagnostics.boundary.parametersAtBound.map(({ parameter, side }) => ({ parameter, side })), [
    { parameter: "slope", side: "upper" },
  ]);
});

test("fit diagnostics expose optimizer non-convergence and unassessed profiles", () => {
  const result = fitParameters({
    observations,
    parameterPolicy: "generic_test_adapter",
    parameterWhitelist: ["slope"],
    bounds: { slope: [0, 5] },
    predictor: (parameters, observation) => parameters.slope * observation.x,
    method: "least_squares",
    seed: 44,
    restarts: 1,
    differentialEvolution: { maxEvaluations: 20, populationSize: 4 },
    nelderMead: { maxEvaluations: 1 },
  });

  assert.equal(result.fitDiagnostics.convergence.status, "NOT_CONVERGED");
  assert.equal(result.fitDiagnostics.profileLikelihood.status, "NOT_ASSESSED");
  assert.equal(result.fitDiagnostics.profileLikelihood.reason, "profile_likelihood_not_run_by_shared_fitter");
});
