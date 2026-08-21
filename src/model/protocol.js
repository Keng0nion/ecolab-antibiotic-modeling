import { validationError } from "./errors.js";
import {
  assertArray,
  assertFiniteNumber,
  assertNonEmptyString,
  assertPlainObject,
  deepFreeze,
} from "./validate.js";
import { concentrationToMgPerL, timeToHours } from "./units.js";

const TIME_TOLERANCE_HOURS = 1e-12;

export function normalizePiecewiseProtocol(protocol) {
  assertPlainObject(protocol, "protocol");
  if (protocol.kind !== "piecewise_constant") {
    throw validationError(
      "UNSUPPORTED_PROTOCOL",
      "protocol.kind",
      "piecewise_constant",
      protocol.kind,
      "Only piecewise-constant protocols are supported.",
    );
  }
  const drugId = assertNonEmptyString(protocol.drugId, "protocol.drugId");
  assertArray(protocol.segments, "protocol.segments", { minLength: 1 });

  const normalizedSegments = protocol.segments.map((segment, index) => {
    const path = `protocol.segments.${index}`;
    assertPlainObject(segment, path);
    const startHours = timeToHours(segment.start, `${path}.start`);
    const endHours = timeToHours(segment.end, `${path}.end`);
    const concentrationMgPerL = concentrationToMgPerL(
      segment.concentration,
      `${path}.concentration`,
    );
    if (endHours <= startHours) {
      throw validationError(
        "INVALID_SEGMENT_DURATION",
        path,
        "end > start",
        { startHours, endHours },
        `${path} must have positive duration.`,
      );
    }
    if (drugId === "none" && concentrationMgPerL !== 0) {
      throw validationError(
        "CONTROL_WITH_NONZERO_CONCENTRATION",
        `${path}.concentration`,
        0,
        concentrationMgPerL,
        "The no-antibiotic protocol must have zero concentration.",
      );
    }
    return { startHours, endHours, concentrationMgPerL };
  });

  if (Math.abs(normalizedSegments[0].startHours) > TIME_TOLERANCE_HOURS) {
    throw validationError(
      "PROTOCOL_MUST_START_AT_ZERO",
      "protocol.segments.0.start",
      0,
      normalizedSegments[0].startHours,
      "The first protocol segment must start at time zero.",
    );
  }

  for (let index = 1; index < normalizedSegments.length; index += 1) {
    const previous = normalizedSegments[index - 1];
    const current = normalizedSegments[index];
    const difference = current.startHours - previous.endHours;
    if (Math.abs(difference) > TIME_TOLERANCE_HOURS) {
      throw validationError(
        difference > 0 ? "PROTOCOL_GAP" : "PROTOCOL_OVERLAP",
        `protocol.segments.${index}.start`,
        previous.endHours,
        current.startHours,
        "Protocol segments must be contiguous and non-overlapping.",
      );
    }
    current.startHours = previous.endHours;
  }

  return deepFreeze({
    kind: "piecewise_constant",
    drugId,
    boundaryConvention: "segments_are_[start,end);_final_endpoint_included",
    segments: normalizedSegments,
    endHours: normalizedSegments.at(-1).endHours,
  });
}

export function normalizeSampleTimes(sampleTimes, protocolEndHours) {
  assertArray(sampleTimes, "sampleTimes", { minLength: 1 });
  const normalized = sampleTimes.map((time, index) => {
    const timeHours = timeToHours(time, `sampleTimes.${index}`);
    assertFiniteNumber(timeHours, `sampleTimes.${index}`, {
      minimum: 0,
      maximum: protocolEndHours,
    });
    return timeHours;
  });

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] <= normalized[index - 1]) {
      throw validationError(
        "SAMPLE_TIMES_NOT_STRICTLY_INCREASING",
        `sampleTimes.${index}`,
        `> ${normalized[index - 1]}`,
        normalized[index],
        "Sample times must be unique and strictly increasing.",
      );
    }
  }

  if (normalized[0] !== 0) normalized.unshift(0);
  if (Math.abs(normalized.at(-1) - protocolEndHours) > TIME_TOLERANCE_HOURS) {
    normalized.push(protocolEndHours);
  } else {
    normalized[normalized.length - 1] = protocolEndHours;
  }
  return normalized;
}

export function segmentAtTime(normalizedProtocol, timeHours, segmentIndex = 0) {
  let index = segmentIndex;
  while (
    index < normalizedProtocol.segments.length - 1 &&
    timeHours >= normalizedProtocol.segments[index].endHours - TIME_TOLERANCE_HOURS
  ) {
    index += 1;
  }
  return { segment: normalizedProtocol.segments[index], segmentIndex: index };
}
