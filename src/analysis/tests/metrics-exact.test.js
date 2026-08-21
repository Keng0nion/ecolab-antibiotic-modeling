import test from "node:test";
import assert from "node:assert/strict";
import { calculateMetrics } from "../metrics.js";

test("metrics exactly distinguish macro and pooled RMSE by independent unit", () => {
  const observations = [
    { independentUnitId: "A", value: 1 },
    { independentUnitId: "A", value: 3 },
    { independentUnitId: "B", value: 10 },
  ];
  const result = calculateMetrics({
    observations,
    predictions: [0, 2, 13],
    predeclaredBaseline: {
      id: "zero-error-reference",
      predictions: [1, 3, 10],
    },
  });
  assert.equal(result.macroRmse, 2);
  assert.equal(result.pooledRmse, Math.sqrt(11 / 3));
  assert.equal(result.mae, 5 / 3);
  assert.equal(result.meanResidual, -1 / 3);
  assert.equal(result.medianAbsoluteError, 1);
  assert.deepEqual(result.perUnit, [
    {
      independentUnitId: "A",
      count: 2,
      rmse: 1,
      mae: 1,
      meanResidual: 1,
      medianAbsoluteError: 1,
    },
    {
      independentUnitId: "B",
      count: 1,
      rmse: 3,
      mae: 3,
      meanResidual: -3,
      medianAbsoluteError: 3,
    },
  ]);
  assert.equal(result.baselineComparison.baselineId, "zero-error-reference");
  assert.equal(result.baselineComparison.predeclared, true);
  assert.equal(result.baselineComparison.baselineMetrics.pooledRmse, 0);
});
