import { validationError } from "./errors.js";
import { assertFiniteNumber, assertPlainObject } from "./validate.js";

export const CANONICAL_UNITS = Object.freeze({
  time: "h",
  concentration: "mg/L",
  population: "log10(CFU/mL)",
  linearPopulation: "CFU/mL",
  rate: "log10-fold/h",
  dimensionless: "dimensionless",
});

const TIME_TO_HOURS = Object.freeze({
  min: 1 / 60,
  h: 1,
});

const CONCENTRATION_TO_MG_PER_L = Object.freeze({
  "mg/L": 1,
  "ug/mL": 1,
  "µg/mL": 1,
  "μg/mL": 1,
});

export function assertQuantity(quantity, path) {
  assertPlainObject(quantity, path);
  assertFiniteNumber(quantity.value, `${path}.value`);
  if (typeof quantity.unit !== "string") {
    throw validationError(
      "INVALID_UNIT",
      `${path}.unit`,
      "unit string",
      quantity.unit,
      `${path}.unit must be a unit string.`,
    );
  }
  return quantity;
}

function convert(quantity, factors, canonicalUnit, path) {
  assertQuantity(quantity, path);
  const factor = factors[quantity.unit];
  if (factor === undefined) {
    throw validationError(
      "UNIT_MISMATCH",
      `${path}.unit`,
      Object.keys(factors),
      quantity.unit,
      `${path}.unit is not compatible with ${canonicalUnit}.`,
    );
  }
  return quantity.value * factor;
}

export function timeToHours(quantity, path = "time") {
  return convert(quantity, TIME_TO_HOURS, CANONICAL_UNITS.time, path);
}

export function concentrationToMgPerL(quantity, path = "concentration") {
  const value = convert(
    quantity,
    CONCENTRATION_TO_MG_PER_L,
    CANONICAL_UNITS.concentration,
    path,
  );
  if (value < 0) {
    throw validationError(
      "NEGATIVE_CONCENTRATION",
      `${path}.value`,
      ">= 0",
      quantity.value,
      `${path}.value cannot be negative.`,
    );
  }
  return value;
}

export function populationToLog10(quantity, path = "populationDensity") {
  assertQuantity(quantity, path);
  if (quantity.unit === CANONICAL_UNITS.population) return quantity.value;
  if (quantity.unit !== CANONICAL_UNITS.linearPopulation) {
    throw validationError(
      "UNIT_MISMATCH",
      `${path}.unit`,
      [CANONICAL_UNITS.linearPopulation, CANONICAL_UNITS.population],
      quantity.unit,
      `${path}.unit must represent population density.`,
    );
  }
  if (quantity.value <= 0) {
    throw validationError(
      "NON_POSITIVE_POPULATION",
      `${path}.value`,
      "> 0",
      quantity.value,
      `${path}.value must be greater than zero.`,
    );
  }
  return Math.log10(quantity.value);
}

export function log10PopulationToLinear(log10PopulationDensity) {
  assertFiniteNumber(
    log10PopulationDensity,
    "log10PopulationDensity",
  );
  const value = 10 ** log10PopulationDensity;
  return {
    value: Number.isFinite(value) && value > 0 ? value : null,
    unit: CANONICAL_UNITS.linearPopulation,
    underflowed: value === 0,
    overflowed: value === Infinity,
  };
}

export function makeQuantity(value, unit) {
  assertFiniteNumber(value, "quantity.value");
  return { value, unit };
}
