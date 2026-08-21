import { validationError } from "./errors.js";
import { advanceConstantExposure } from "./regoes-logistic-v1.js";
import {
  normalizePiecewiseProtocol,
  normalizeSampleTimes,
  segmentAtTime,
} from "./protocol.js";
import { normalizeObservation, observePopulation } from "./observe.js";
import { assertPlainObject } from "./validate.js";
import { populationToLog10 } from "./units.js";

const TIME_TOLERANCE_HOURS = 1e-12;

function trajectoryRow(state, segment, drugId, observation) {
  const observed = observePopulation(state.log10PopulationDensity, observation);
  return {
    timeHours: state.timeHours,
    drugId,
    concentrationMgPerL: segment.concentrationMgPerL,
    netGrowthLog10PerHour: state.netGrowthLog10PerHour,
    ...observed,
  };
}

export function simulatePiecewise(resolvedModel, request) {
  assertPlainObject(resolvedModel, "resolvedModel");
  assertPlainObject(request, "request");
  const protocol = normalizePiecewiseProtocol(request.protocol);
  if (
    protocol.drugId !== "none" &&
    !resolvedModel.parameters.drugs[protocol.drugId]
  ) {
    throw validationError(
      "UNKNOWN_DRUG",
      "protocol.drugId",
      Object.keys(resolvedModel.parameters.drugs),
      protocol.drugId,
      `Unknown drug ID: ${protocol.drugId}.`,
    );
  }

  const sampleTimes = normalizeSampleTimes(request.sampleTimes, protocol.endHours);
  const observation = normalizeObservation(request.observation ?? {});
  let state = {
    timeHours: 0,
    log10PopulationDensity: populationToLog10(
      request.initialState.populationDensity,
      "initialState.populationDensity",
    ),
    netGrowthLog10PerHour: null,
  };

  if (
    state.log10PopulationDensity >
    resolvedModel.parameters.carryingCapacityLog10CfuPerMl
  ) {
    throw validationError(
      "POPULATION_ABOVE_CAPACITY",
      "initialState.populationDensity",
      `<= ${resolvedModel.parameters.carryingCapacityLog10CfuPerMl} log10(CFU/mL)`,
      state.log10PopulationDensity,
      "Initial population cannot exceed carrying capacity.",
    );
  }

  let segmentIndex = 0;
  let located = segmentAtTime(protocol, 0, segmentIndex);
  state = advanceConstantExposure(resolvedModel, state, {
    drugId: protocol.drugId,
    concentrationMgPerL: located.segment.concentrationMgPerL,
    durationHours: 0,
  });
  const trajectory = [
    trajectoryRow(state, located.segment, protocol.drugId, observation),
  ];

  for (const targetTimeHours of sampleTimes.slice(1)) {
    while (state.timeHours < targetTimeHours - TIME_TOLERANCE_HOURS) {
      located = segmentAtTime(protocol, state.timeHours, segmentIndex);
      segmentIndex = located.segmentIndex;
      const nextTimeHours = Math.min(
        targetTimeHours,
        located.segment.endHours,
      );
      state = advanceConstantExposure(resolvedModel, state, {
        drugId: protocol.drugId,
        concentrationMgPerL: located.segment.concentrationMgPerL,
        durationHours: nextTimeHours - state.timeHours,
      });
    }

    located = segmentAtTime(protocol, targetTimeHours, segmentIndex);
    segmentIndex = located.segmentIndex;
    if (Math.abs(state.timeHours - targetTimeHours) <= TIME_TOLERANCE_HOURS) {
      state.timeHours = targetTimeHours;
    }
    state = advanceConstantExposure(resolvedModel, state, {
      drugId: protocol.drugId,
      concentrationMgPerL: located.segment.concentrationMgPerL,
      durationHours: 0,
    });
    trajectory.push(
      trajectoryRow(state, located.segment, protocol.drugId, observation),
    );
  }

  return {
    model: resolvedModel.ref,
    protocol,
    trajectory,
    diagnostics: {
      integration: "piecewise analytic",
      latentStateIsCensoredByDetectionLimit: false,
      warnings: [...resolvedModel.warnings],
    },
  };
}
