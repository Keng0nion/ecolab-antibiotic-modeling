import test from "node:test";
import assert from "node:assert/strict";
import {
  concentrationToMgPerL,
  populationToLog10,
  timeToHours,
} from "../model/units.js";

test("supported time and concentration units convert explicitly", () => {
  assert.equal(timeToHours({ value: 60, unit: "min" }), 1);
  assert.equal(timeToHours({ value: 1, unit: "h" }), 1);
  assert.equal(concentrationToMgPerL({ value: 1, unit: "ug/mL" }), 1);
  assert.equal(concentrationToMgPerL({ value: 1, unit: "µg/mL" }), 1);
});

test("population quantities convert to the canonical log10 representation", () => {
  assert.equal(populationToLog10({ value: 1e6, unit: "CFU/mL" }), 6);
  assert.equal(populationToLog10({ value: -2, unit: "log10(CFU/mL)" }), -2);
});

test("unit mismatches, strings and non-positive linear populations are rejected", () => {
  assert.throws(() => timeToHours({ value: 1, unit: "mg/L" }), {
    code: "UNIT_MISMATCH",
  });
  assert.throws(() => concentrationToMgPerL({ value: "1", unit: "mg/L" }), {
    code: "INVALID_NUMBER",
  });
  assert.throws(() => populationToLog10({ value: 0, unit: "CFU/mL" }), {
    code: "NON_POSITIVE_POPULATION",
  });
});
