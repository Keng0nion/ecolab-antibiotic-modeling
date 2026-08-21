import test from "node:test";
import assert from "node:assert/strict";
import {
  applyParameterOverrides,
  parseParameterName,
  validateParameterSpace,
} from "../parameter-space.js";

const snapshot = Object.freeze({
  kind: "ResolvedModel",
  parameters: Object.freeze({
    psiMaxLog10PerHour: 0.4,
    carryingCapacityLog10CfuPerMl: 9,
    drugs: Object.freeze({
      ampicillin: Object.freeze({
        zMicMgPerL: 1,
        hillKappa: 2,
        psiMinLog10PerHour: -3,
        paperBrothDilutionMicMgPerL: 4,
      }),
    }),
  }),
  initialStates: Object.freeze({
    seriesA: Object.freeze({ log10PopulationDensity: 6 }),
  }),
});

test("parameter space enforces exact whitelist, finite bounds and rationale", () => {
  const space = validateParameterSpace({
    initialStateSeriesIds: ["seriesA"],
    drugIds: ["ampicillin"],
    parameters: [
      { name: "psiMaxLog10PerHour", lower: 0.1, upper: 1, rationale: "Exploratory growth range." },
      { name: "drugs.ampicillin.hillKappa", lower: 0.5, upper: 5, rationale: "Evidence-bounded response shape." },
      { name: "initialStates.seriesA.log10PopulationDensity", lower: 4, upper: 8, rationale: "Declared inoculum range." },
    ],
  });
  assert.equal(space.parameters.length, 3);
  assert.throws(
    () => validateParameterSpace({ parameters: [{ name: "doublingTimeHours", lower: 1, upper: 2, rationale: "x" }] }),
    { code: "PARAMETER_NOT_WHITELISTED" },
  );
  assert.throws(
    () => validateParameterSpace({ parameters: [{ name: "psiMaxLog10PerHour", lower: 0, upper: Infinity, rationale: "x" }] }),
    { code: "INVALID_PARAMETER_VALUE" },
  );
  assert.throws(
    () => validateParameterSpace({ parameters: [{ name: "psiMaxLog10PerHour", lower: 0, upper: 1, rationale: "" }] }),
    { code: "INVALID_STRING" },
  );
  assert.throws(
    () => parseParameterName("initialStates.seriesA.log10PopulationDensity"),
    { code: "UNDECLARED_INITIAL_STATE_PARAMETER" },
  );
});

test("overrides create a frozen snapshot without mutating the resolved model", () => {
  const result = applyParameterOverrides(
    snapshot,
    {
      psiMaxLog10PerHour: 0.7,
      "drugs.ampicillin.zMicMgPerL": 2,
      "initialStates.seriesA.log10PopulationDensity": 5.5,
    },
    { initialStateSeriesIds: ["seriesA"] },
  );
  assert.equal(result.parameters.psiMaxLog10PerHour, 0.7);
  assert.equal(result.parameters.drugs.ampicillin.zMicMgPerL, 2);
  assert.equal(result.initialStates.seriesA.log10PopulationDensity, 5.5);
  assert.equal(snapshot.parameters.psiMaxLog10PerHour, 0.4);
  assert.equal(snapshot.parameters.drugs.ampicillin.zMicMgPerL, 1);
  assert.equal(snapshot.initialStates.seriesA.log10PopulationDensity, 6);
  assert.notEqual(result, snapshot);
  assert.notEqual(result.parameters, snapshot.parameters);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.parameters.drugs.ampicillin));
});
