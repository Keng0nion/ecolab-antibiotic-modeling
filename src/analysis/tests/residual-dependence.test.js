import test from "node:test";
import assert from "node:assert/strict";
import {
  ar1BlockSummaries,
  estimateVarianceComponents,
  groupResidualsByCurve,
  pooledAr1Coefficient,
  randomInterceptAr1ProfileNegativeLogLikelihood,
  refineThresholdCrossing,
} from "../residual-dependence.js";

function observationsFromSeries(series, unit = "u1", step = 1) {
  return series.map((value, index) => ({
    independentUnitId: unit,
    timeHours: index * step,
    value,
  }));
}

function denseAr1Inverse(size, phi) {
  const matrix = Array.from({ length: size }, () => Array(size).fill(0));
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      matrix[row][column] = phi ** Math.abs(row - column);
    }
  }
  const augmented = matrix.map((row, index) => [...row, ...Array.from({ length: size }, (_, column) => (column === index ? 1 : 0))]);
  for (let pivot = 0; pivot < size; pivot += 1) {
    let best = pivot;
    for (let row = pivot + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][pivot]) > Math.abs(augmented[best][pivot])) best = row;
    }
    [augmented[pivot], augmented[best]] = [augmented[best], augmented[pivot]];
    const divisor = augmented[pivot][pivot];
    for (let column = 0; column < 2 * size; column += 1) augmented[pivot][column] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === pivot) continue;
      const factor = augmented[row][pivot];
      for (let column = 0; column < 2 * size; column += 1) augmented[row][column] -= factor * augmented[pivot][column];
    }
  }
  return augmented.map((row) => row.slice(size));
}

test("AR(1) block summaries match a dense matrix inverse", () => {
  const series = [0.3, -0.7, 0.2, 0.9, -0.4];
  const phi = 0.55;
  const inverse = denseAr1Inverse(series.length, phi);
  const quadratic = series.reduce((sum, value, row) => sum
    + value * inverse[row].reduce((inner, entry, column) => inner + entry * series[column], 0), 0);
  const sumRE = series.reduce((sum, value, row) => sum
    + value * inverse[row].reduce((inner, entry) => inner + entry, 0), 0);
  const sumR1 = inverse.reduce((sum, row) => sum + row.reduce((inner, entry) => inner + entry, 0), 0);
  const summaries = ar1BlockSummaries(series, phi);
  assert.ok(Math.abs(summaries.quadratic - quadratic) < 1e-12);
  assert.ok(Math.abs(summaries.sumRE - sumRE) < 1e-12);
  assert.ok(Math.abs(summaries.sumR1 - sumR1) < 1e-12);
  assert.ok(Math.abs(summaries.logDeterminant - (series.length - 1) * Math.log(1 - phi * phi)) < 1e-12);
});

test("pooled AR(1) coefficient recovers a synthetic persistent series", () => {
  const phi = 0.8;
  const series = [0.4];
  let state = 123456789;
  const innovation = () => {
    state = (1664525 * state + 1013904223) % 4294967296;
    return state / 4294967296 - 0.5;
  };
  for (let index = 1; index < 200; index += 1) {
    series.push(phi * series[index - 1] + innovation());
  }
  const observations = observationsFromSeries(series);
  const residuals = series.map((value) => ({ residual: value }));
  const estimate = pooledAr1Coefficient(observations, residuals);
  assert.ok(estimate.phi > 0.7 && estimate.phi < 0.9, `phi=${estimate.phi}`);
  assert.equal(estimate.pairs, 199);
});

test("zero dependence reduces to the IID profiled Gaussian likelihood", () => {
  const series = [0.2, -0.3, 0.5, -0.1];
  const observations = observationsFromSeries(series);
  const residuals = series.map((value) => ({ residual: value }));
  const sumSquares = series.reduce((sum, value) => sum + value * value, 0);
  const expected = 0.5 * series.length * Math.log(sumSquares / series.length);
  const actual = randomInterceptAr1ProfileNegativeLogLikelihood({
    observations, residuals, phi: 0, lambda: 0,
  });
  assert.ok(Math.abs(actual - expected) < 1e-12);
});

test("random-intercept AR(1) likelihood is finite and penalises a larger offset variance", () => {
  const first = [0.2, -0.1, 0.3, 0.1];
  const second = [1.2, 0.9, 1.1, 1.0];
  const series = [...first, ...second];
  const observations = [
    ...observationsFromSeries(first, "a"),
    ...observationsFromSeries(second, "b"),
  ];
  const residuals = series.map((value) => ({ residual: value }));
  const components = estimateVarianceComponents(observations, residuals);
  assert.ok(components.lambda > 0);
  assert.ok(components.icc > 0 && components.icc < 1);
  const nll = randomInterceptAr1ProfileNegativeLogLikelihood({
    observations, residuals, phi: 0.3, lambda: components.lambda,
  });
  assert.ok(Number.isFinite(nll));
  const independent = randomInterceptAr1ProfileNegativeLogLikelihood({
    observations, residuals, phi: 0.3, lambda: 0,
  });
  assert.notEqual(nll, independent);
});

test("bisection refines a threshold crossing deterministically", async () => {
  const threshold = 1;
  const delta = (value) => (value - 2) ** 2;
  const upper = await refineThresholdCrossing({
    evaluate: async (value) => ({ delta: delta(value) }),
    inner: 2.5, outer: 5, innerDelta: delta(2.5), outerDelta: delta(5),
    threshold, relativeTolerance: 1e-9, maxIterations: 20,
  });
  assert.ok(Math.abs(upper.value - 3) < 1e-6, `upper=${upper.value}`);
  assert.equal(upper.converged, true);
  assert.ok(upper.evaluations > 5);
  const lower = await refineThresholdCrossing({
    evaluate: async (value) => ({ delta: delta(value) }),
    inner: 1.5, outer: -2, innerDelta: delta(1.5), outerDelta: delta(-2),
    threshold, relativeTolerance: 1e-9, maxIterations: 20,
  });
  assert.ok(Math.abs(lower.value - 1) < 1e-6, `lower=${lower.value}`);
});

test("bisection reports a failed bracket evaluation without inventing a root", async () => {
  const result = await refineThresholdCrossing({
    evaluate: async () => ({ delta: Number.NaN }),
    inner: 0, outer: 1, innerDelta: 0, outerDelta: 2, threshold: 1,
    relativeTolerance: 1e-6, maxIterations: 4,
  });
  assert.equal(result.converged, false);
  assert.equal(result.failed, true);
});

test("unequal time spacing is rejected instead of silently mis-modelled", () => {
  const observations = [
    { independentUnitId: "u", timeHours: 0, value: 0 },
    { independentUnitId: "u", timeHours: 1, value: 0 },
    { independentUnitId: "u", timeHours: 3, value: 0 },
  ];
  assert.equal(groupResidualsByCurve(observations, [0, 0, 0]).length, 1);
  assert.throws(
    () => pooledAr1Coefficient(observations, [0.1, 0.2, 0.3]),
    /equally spaced/,
  );
});
