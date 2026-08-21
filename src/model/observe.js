import { assertFiniteNumber, assertPlainObject } from "./validate.js";
import { populationToLog10 } from "./units.js";

export function normalizeObservation(observation = {}) {
  assertPlainObject(observation, "observation");
  const detectionLimitLog10 = observation.detectionLimit
    ? populationToLog10(observation.detectionLimit, "observation.detectionLimit")
    : null;
  return { detectionLimitLog10 };
}

export function observePopulation(log10PopulationDensity, observation) {
  assertFiniteNumber(log10PopulationDensity, "log10PopulationDensity");
  const detectionLimitLog10 = observation.detectionLimitLog10;
  return {
    latentLog10PopulationDensity: log10PopulationDensity,
    belowDetectionLimit:
      detectionLimitLog10 !== null &&
      log10PopulationDensity < detectionLimitLog10,
    detectionLimitLog10,
  };
}
