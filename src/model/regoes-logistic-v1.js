import { validationError } from "./errors.js";
import { assertFiniteNumber, assertPlainObject } from "./validate.js";

const LN_10 = Math.log(10);
const ZERO_TOLERANCE = 1e-14;

function logistic(value) {
  if (value >= 0) {
    const expNegative = Math.exp(-value);
    return 1 / (1 + expNegative);
  }
  const expPositive = Math.exp(value);
  return expPositive / (1 + expPositive);
}

function softplus(value) {
  if (value > 36) return value;
  if (value < -36) return Math.exp(value);
  return Math.log1p(Math.exp(value));
}

export function validateGrowthParameters(parameters) {
  assertPlainObject(parameters, "parameters");
  assertFiniteNumber(parameters.psiMaxLog10PerHour, "parameters.psiMaxLog10PerHour", {
    minimum: 0,
    exclusiveMinimum: true,
  });
  assertFiniteNumber(
    parameters.carryingCapacityLog10CfuPerMl,
    "parameters.carryingCapacityLog10CfuPerMl",
  );
  assertPlainObject(parameters.drugs, "parameters.drugs");

  for (const [drugId, drug] of Object.entries(parameters.drugs)) {
    assertPlainObject(drug, `parameters.drugs.${drugId}`);
    assertFiniteNumber(drug.zMicMgPerL, `parameters.drugs.${drugId}.zMicMgPerL`, {
      minimum: 0,
      exclusiveMinimum: true,
    });
    assertFiniteNumber(drug.hillKappa, `parameters.drugs.${drugId}.hillKappa`, {
      minimum: 0,
      exclusiveMinimum: true,
    });
    assertFiniteNumber(
      drug.psiMinLog10PerHour,
      `parameters.drugs.${drugId}.psiMinLog10PerHour`,
      { maximum: 0 },
    );
    if (drug.psiMinLog10PerHour >= 0) {
      throw validationError(
        "INVALID_PSI_MIN",
        `parameters.drugs.${drugId}.psiMinLog10PerHour`,
        "< 0",
        drug.psiMinLog10PerHour,
        "psiMin must be negative.",
      );
    }
  }

  return parameters;
}

export function evaluateRegoesNetGrowth(parameters, drugId, concentrationMgPerL) {
  validateGrowthParameters(parameters);
  assertFiniteNumber(concentrationMgPerL, "concentrationMgPerL", { minimum: 0 });

  if (drugId === "none") {
    if (concentrationMgPerL !== 0) {
      throw validationError(
        "CONTROL_WITH_NONZERO_CONCENTRATION",
        "concentrationMgPerL",
        0,
        concentrationMgPerL,
        "The no-antibiotic control must have zero concentration.",
      );
    }
    return parameters.psiMaxLog10PerHour;
  }

  const drug = parameters.drugs[drugId];
  if (!drug) {
    throw validationError(
      "UNKNOWN_DRUG",
      "drugId",
      Object.keys(parameters.drugs),
      drugId,
      `Unknown drug ID: ${drugId}.`,
    );
  }
  if (concentrationMgPerL === 0) return parameters.psiMaxLog10PerHour;

  const logPower =
    drug.hillKappa * Math.log(concentrationMgPerL / drug.zMicMgPerL);
  const logQ = Math.log(
    -drug.psiMinLog10PerHour / parameters.psiMaxLog10PerHour,
  );
  const effectFraction = logistic(logPower - logQ);
  const result =
    parameters.psiMaxLog10PerHour * (1 - effectFraction) +
    drug.psiMinLog10PerHour * effectFraction;

  return Math.abs(result) < ZERO_TOLERANCE ? 0 : result;
}

export function advancePopulationAnalytically(
  log10PopulationDensity,
  netGrowthLog10PerHour,
  durationHours,
  carryingCapacityLog10CfuPerMl,
) {
  assertFiniteNumber(log10PopulationDensity, "state.log10PopulationDensity");
  assertFiniteNumber(netGrowthLog10PerHour, "netGrowthLog10PerHour");
  assertFiniteNumber(durationHours, "durationHours", { minimum: 0 });
  assertFiniteNumber(
    carryingCapacityLog10CfuPerMl,
    "carryingCapacityLog10CfuPerMl",
  );

  if (log10PopulationDensity > carryingCapacityLog10CfuPerMl) {
    throw validationError(
      "POPULATION_ABOVE_CAPACITY",
      "state.log10PopulationDensity",
      `<= ${carryingCapacityLog10CfuPerMl}`,
      log10PopulationDensity,
      "Population density cannot start above carrying capacity.",
    );
  }
  if (durationHours === 0 || netGrowthLog10PerHour === 0) {
    return log10PopulationDensity;
  }

  if (netGrowthLog10PerHour < 0) {
    return log10PopulationDensity + netGrowthLog10PerHour * durationHours;
  }
  if (log10PopulationDensity === carryingCapacityLog10CfuPerMl) {
    return carryingCapacityLog10CfuPerMl;
  }

  const naturalLogFraction =
    LN_10 * (log10PopulationDensity - carryingCapacityLog10CfuPerMl);
  const logOneMinusFraction =
    naturalLogFraction < -36
      ? 0
      : Math.log(-Math.expm1(naturalLogFraction));
  const initialLogOdds = naturalLogFraction - logOneMinusFraction;
  const finalLogOdds =
    initialLogOdds + LN_10 * netGrowthLog10PerHour * durationHours;
  const finalNaturalLogFraction = -softplus(-finalLogOdds);
  const result =
    carryingCapacityLog10CfuPerMl + finalNaturalLogFraction / LN_10;

  return Math.min(carryingCapacityLog10CfuPerMl, result);
}

export function advanceConstantExposure(resolvedModel, state, exposure) {
  assertPlainObject(resolvedModel, "resolvedModel");
  assertPlainObject(state, "state");
  assertPlainObject(exposure, "exposure");

  const netGrowthLog10PerHour = evaluateRegoesNetGrowth(
    resolvedModel.parameters,
    exposure.drugId,
    exposure.concentrationMgPerL,
  );
  const log10PopulationDensity = advancePopulationAnalytically(
    state.log10PopulationDensity,
    netGrowthLog10PerHour,
    exposure.durationHours,
    resolvedModel.parameters.carryingCapacityLog10CfuPerMl,
  );

  return {
    timeHours: state.timeHours + exposure.durationHours,
    log10PopulationDensity,
    netGrowthLog10PerHour,
  };
}
