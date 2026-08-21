import test from "node:test";
import assert from "node:assert/strict";
import {
  advancePopulationAnalytically,
  evaluateRegoesNetGrowth,
  simulatePiecewise,
} from "../model/index.js";
import { loadResolvedModel } from "./helpers/fixtures.js";

const resolvedModel = await loadResolvedModel();
const parameters = resolvedModel.parameters;

function close(actual, expected, tolerance = 1e-12) {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${actual} was not within ${tolerance} of ${expected}`,
  );
}

test("doubling time resolves to the expected log10 growth rate", () => {
  close(parameters.psiMaxLog10PerHour, 0.4300428509485446, 1e-15);
});

test("Regoes function is exact at zero and zMIC", () => {
  for (const [drugId, drug] of Object.entries(parameters.drugs)) {
    assert.equal(evaluateRegoesNetGrowth(parameters, drugId, 0), parameters.psiMaxLog10PerHour);
    assert.equal(evaluateRegoesNetGrowth(parameters, drugId, drug.zMicMgPerL), 0);
  }
});

test("Regoes function is monotone and stable at extreme finite concentrations", () => {
  for (const [drugId, drug] of Object.entries(parameters.drugs)) {
    let previous = parameters.psiMaxLog10PerHour;
    for (const ratio of [1e-12, 1e-6, 0.01, 0.25, 1, 4, 1e6, 1e300]) {
      const result = evaluateRegoesNetGrowth(
        parameters,
        drugId,
        drug.zMicMgPerL * ratio,
      );
      assert.ok(Number.isFinite(result));
      assert.ok(result <= previous + 1e-12);
      previous = result;
    }
    const extreme = evaluateRegoesNetGrowth(parameters, drugId, Number.MAX_VALUE);
    assert.ok(Number.isFinite(extreme));
    close(extreme, drug.psiMinLog10PerHour, 1e-12);
  }
});

test("unknown drugs and invalid concentrations are rejected", () => {
  assert.throws(
    () => evaluateRegoesNetGrowth(parameters, "ciprofloxacim", 0.1),
    { code: "UNKNOWN_DRUG" },
  );
  for (const invalid of [-1, Number.NaN, Infinity, "0.1"]) {
    assert.throws(
      () => evaluateRegoesNetGrowth(parameters, "ciprofloxacin", invalid),
      { code: "INVALID_NUMBER" },
    );
  }
});

test("negative and zero growth integrate exactly in log10 space", () => {
  assert.equal(advancePopulationAnalytically(6, 0, 10, 9), 6);
  close(advancePopulationAnalytically(6, -2, 0.5, 9), 5);
});

test("positive logistic integration is composition invariant", () => {
  const whole = advancePopulationAnalytically(6, parameters.psiMaxLog10PerHour, 4, 9);
  const half = advancePopulationAnalytically(6, parameters.psiMaxLog10PerHour, 2, 9);
  const split = advancePopulationAnalytically(half, parameters.psiMaxLog10PerHour, 2, 9);
  close(split, whole, 1e-12);
  assert.ok(whole < 9);
  assert.equal(advancePopulationAnalytically(9, parameters.psiMaxLog10PerHour, 100, 9), 9);
});

test("piecewise protocol uses right-continuous concentration at boundaries", () => {
  const result = simulatePiecewise(resolvedModel, {
    initialState: { populationDensity: { value: 1e6, unit: "CFU/mL" } },
    protocol: {
      kind: "piecewise_constant",
      drugId: "ciprofloxacin",
      segments: [
        {
          start: { value: 0, unit: "min" },
          end: { value: 60, unit: "min" },
          concentration: { value: 0, unit: "mg/L" },
        },
        {
          start: { value: 60, unit: "min" },
          end: { value: 120, unit: "min" },
          concentration: { value: 0.068, unit: "mg/L" },
        },
      ],
    },
    sampleTimes: [
      { value: 0, unit: "min" },
      { value: 60, unit: "min" },
      { value: 120, unit: "min" },
    ],
    observation: { detectionLimit: { value: 10, unit: "CFU/mL" } },
  });

  assert.equal(result.trajectory[1].timeHours, 1);
  assert.equal(result.trajectory[1].concentrationMgPerL, 0.068);
  assert.ok(result.trajectory[1].netGrowthLog10PerHour < 0);
  assert.ok(result.trajectory[1].latentLog10PopulationDensity > 6);
  assert.ok(
    result.trajectory[2].latentLog10PopulationDensity <
      result.trajectory[1].latentLog10PopulationDensity,
  );
});

test("detection limit censors observations without truncating latent state", () => {
  const result = simulatePiecewise(resolvedModel, {
    initialState: { populationDensity: { value: 20, unit: "CFU/mL" } },
    protocol: {
      kind: "piecewise_constant",
      drugId: "ciprofloxacin",
      segments: [
        {
          start: { value: 0, unit: "h" },
          end: { value: 2, unit: "h" },
          concentration: { value: 17, unit: "mg/L" },
        },
      ],
    },
    sampleTimes: [
      { value: 0, unit: "h" },
      { value: 2, unit: "h" },
    ],
    observation: { detectionLimit: { value: 10, unit: "CFU/mL" } },
  });

  const final = result.trajectory.at(-1);
  assert.equal(final.belowDetectionLimit, true);
  assert.ok(final.latentLog10PopulationDensity < 1);
});

test("protocol gaps, overlaps and nonzero control concentrations are rejected", () => {
  const base = {
    initialState: { populationDensity: { value: 1e6, unit: "CFU/mL" } },
    sampleTimes: [{ value: 120, unit: "min" }],
    observation: {},
  };
  assert.throws(
    () =>
      simulatePiecewise(resolvedModel, {
        ...base,
        protocol: {
          kind: "piecewise_constant",
          drugId: "ampicillin",
          segments: [
            {
              start: { value: 0, unit: "min" },
              end: { value: 60, unit: "min" },
              concentration: { value: 1, unit: "mg/L" },
            },
            {
              start: { value: 70, unit: "min" },
              end: { value: 120, unit: "min" },
              concentration: { value: 1, unit: "mg/L" },
            },
          ],
        },
      }),
    { code: "PROTOCOL_GAP" },
  );
  assert.throws(
    () =>
      simulatePiecewise(resolvedModel, {
        ...base,
        protocol: {
          kind: "piecewise_constant",
          drugId: "none",
          segments: [
            {
              start: { value: 0, unit: "min" },
              end: { value: 120, unit: "min" },
              concentration: { value: 1, unit: "mg/L" },
            },
          ],
        },
      }),
    { code: "CONTROL_WITH_NONZERO_CONCENTRATION" },
  );
});
