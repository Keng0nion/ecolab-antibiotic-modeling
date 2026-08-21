import test from "node:test";
import assert from "node:assert/strict";
import { runParameterScan } from "../parameter-scan.js";

const parameterSpace = {
  parameters: [
    {
      name: "psiMaxLog10PerHour",
      lower: 0,
      upper: 4,
      rationale: "Synthetic scan test range.",
    },
  ],
};

test("parameter scan retains failed candidates and reports progress", () => {
  const progress = [];
  const result = runParameterScan({
    method: "cartesian",
    parameterSpace,
    values: { psiMaxLog10PerHour: [1, 2, 3] },
    evaluator: ({ psiMaxLog10PerHour }) => {
      if (psiMaxLog10PerHour === 2) throw Object.assign(new Error("synthetic failure"), { code: "SYNTHETIC" });
      return psiMaxLog10PerHour ** 2;
    },
    onProgress: (entry) => progress.push(entry),
  });
  assert.equal(result.candidateCount, 3);
  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  assert.deepEqual(result.results.map((entry) => entry.status), ["ok", "failed", "ok"]);
  assert.equal(result.results[1].parameters.psiMaxLog10PerHour, 2);
  assert.equal(result.results[1].error.code, "SYNTHETIC");
  assert.equal(progress.at(-1).fraction, 1);
});

test("cartesian, one-at-a-time and explicit cases enumerate correctly", () => {
  const twoParameterSpace = {
    parameters: [
      { name: "psiMaxLog10PerHour", lower: 0, upper: 4, rationale: "Synthetic." },
      { name: "carryingCapacityLog10CfuPerMl", lower: 5, upper: 10, rationale: "Synthetic." },
    ],
  };
  const evaluator = (parameters) => parameters;
  const cartesian = runParameterScan({
    parameterSpace: twoParameterSpace,
    values: {
      psiMaxLog10PerHour: [1, 2],
      carryingCapacityLog10CfuPerMl: [7, 8, 9],
    },
    evaluator,
  });
  assert.equal(cartesian.candidateCount, 6);
  const oat = runParameterScan({
    method: "one-at-a-time",
    parameterSpace: twoParameterSpace,
    baseline: { psiMaxLog10PerHour: 1.5, carryingCapacityLog10CfuPerMl: 8 },
    values: {
      psiMaxLog10PerHour: [1, 2],
      carryingCapacityLog10CfuPerMl: [7, 9],
    },
    evaluator,
  });
  assert.equal(oat.candidateCount, 5);
  const explicit = runParameterScan({
    method: "explicit",
    parameterSpace: twoParameterSpace,
    cases: [
      { psiMaxLog10PerHour: 1, carryingCapacityLog10CfuPerMl: 7 },
      { psiMaxLog10PerHour: 2, carryingCapacityLog10CfuPerMl: 9 },
    ],
    evaluator,
  });
  assert.equal(explicit.candidateCount, 2);
});
