const DEFAULT_MINIMUM_SCALE_OD = 1e-12;

function fail(code, message, path = null, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  error.path = path;
  throw error;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_OD_OBSERVATION_VALUE", `${path} must be a finite number.`, path);
  }
  return value;
}

function nonNegative(value, path) {
  finite(value, path);
  if (value < 0) {
    fail("NEGATIVE_OD_OBSERVATION_VALUE", `${path} must be non-negative.`, path, RangeError);
  }
  return value;
}

function positive(value, path) {
  finite(value, path);
  if (value <= 0) {
    fail("NON_POSITIVE_OD_SCALE", `${path} must be greater than zero.`, path, RangeError);
  }
  return value;
}

function numericArray(value, path, options = {}) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_OD_OBSERVATION_ARRAY", `${path} must be a non-empty array.`, path);
  }
  return value.map((item, index) => {
    const number = options.nonNegative === true
      ? nonNegative(item, `${path}[${index}]`)
      : finite(item, `${path}[${index}]`);
    if (options.maximum !== undefined && number > options.maximum) {
      fail(
        "LATENT_FRACTION_OUT_OF_RANGE",
        `${path}[${index}] must be <= ${options.maximum}.`,
        `${path}[${index}]`,
        RangeError,
      );
    }
    return number;
  });
}

function sumSquaredErrors(latentFractions, observedOd, baselineOd, scaleOd) {
  let sum = 0;
  for (let index = 0; index < latentFractions.length; index += 1) {
    const residual = observedOd[index] - (baselineOd + scaleOd * latentFractions[index]);
    sum += residual * residual;
  }
  return sum;
}

function candidate(latentFractions, observedOd, baselineOd, scaleOd, constraint) {
  const normalizedBaseline = Math.max(0, baselineOd);
  const normalizedScale = scaleOd;
  if (!(normalizedScale > 0) || !Number.isFinite(normalizedScale)) return null;
  return {
    baselineOd: normalizedBaseline,
    scaleOd: normalizedScale,
    sumSquaredErrors: sumSquaredErrors(
      latentFractions,
      observedOd,
      normalizedBaseline,
      normalizedScale,
    ),
    activeConstraint: constraint,
  };
}

/** Apply the explicit OD600 observation layer OD600 = baselineOd + scaleOd * (N/K). */
export function applyOdObservationLayer(latentFraction, nuisanceParameters) {
  const fraction = nonNegative(latentFraction, "latentFraction");
  if (fraction > 1 + 1e-9) {
    fail(
      "LATENT_FRACTION_OUT_OF_RANGE",
      "latentFraction must represent N/K and cannot exceed 1 beyond numerical tolerance.",
      "latentFraction",
      RangeError,
    );
  }
  if (!nuisanceParameters || typeof nuisanceParameters !== "object" || Array.isArray(nuisanceParameters)) {
    fail("INVALID_OD_NUISANCE_PARAMETERS", "nuisanceParameters must be an object.", "nuisanceParameters");
  }
  const baselineOd = nonNegative(nuisanceParameters.baselineOd, "nuisanceParameters.baselineOd");
  const scaleOd = positive(nuisanceParameters.scaleOd, "nuisanceParameters.scaleOd");
  return baselineOd + scaleOd * fraction;
}

export function predictOdFromLatentFractions(latentFractions, nuisanceParameters) {
  return numericArray(latentFractions, "latentFractions", { nonNegative: true, maximum: 1 + 1e-9 })
    .map((fraction) => applyOdObservationLayer(fraction, nuisanceParameters));
}

/**
 * Profile common observation-layer nuisance parameters by constrained least
 * squares. The constraints are baselineOd >= 0 and scaleOd > 0. This is an OD
 * observation model, not a CFU conversion or a correction of source values.
 */
export function profileOdObservationLayer(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    fail("INVALID_OD_PROFILE_OPTIONS", "profileOdObservationLayer requires an options object.");
  }
  const latentFractions = numericArray(
    options.latentFractions ?? options.fractions,
    "latentFractions",
    { nonNegative: true, maximum: 1 + 1e-9 },
  );
  const observedOd = numericArray(options.observedOd ?? options.observations, "observedOd", {
    nonNegative: true,
  });
  if (latentFractions.length !== observedOd.length) {
    fail(
      "OD_PROFILE_LENGTH_MISMATCH",
      "latentFractions and observedOd must have equal length.",
      "observedOd",
    );
  }
  const minimumScaleOd = positive(
    options.minimumScaleOd ?? DEFAULT_MINIMUM_SCALE_OD,
    "minimumScaleOd",
  );
  const count = latentFractions.length;
  const meanX = latentFractions.reduce((sum, value) => sum + value, 0) / count;
  const meanY = observedOd.reduce((sum, value) => sum + value, 0) / count;
  let centeredX = 0;
  let centeredXy = 0;
  let sumXy = 0;
  let sumX2 = 0;
  for (let index = 0; index < count; index += 1) {
    const x = latentFractions[index];
    const y = observedOd[index];
    centeredX += (x - meanX) ** 2;
    centeredXy += (x - meanX) * (y - meanY);
    sumXy += x * y;
    sumX2 += x * x;
  }

  const candidates = [];
  if (centeredX > 0) {
    const scaleOd = centeredXy / centeredX;
    const baselineOd = meanY - scaleOd * meanX;
    if (baselineOd >= 0 && scaleOd >= minimumScaleOd) {
      candidates.push(candidate(latentFractions, observedOd, baselineOd, scaleOd, "none"));
    }
  }

  const zeroBaselineScale = sumX2 > 0
    ? Math.max(minimumScaleOd, sumXy / sumX2)
    : minimumScaleOd;
  candidates.push(candidate(
    latentFractions,
    observedOd,
    0,
    zeroBaselineScale,
    "baselineOd_lower_bound",
  ));

  const scaleBoundaryBaseline = Math.max(0, meanY - minimumScaleOd * meanX);
  candidates.push(candidate(
    latentFractions,
    observedOd,
    scaleBoundaryBaseline,
    minimumScaleOd,
    "scaleOd_lower_limit",
  ));

  const feasible = candidates.filter(Boolean);
  feasible.sort((left, right) =>
    left.sumSquaredErrors - right.sumSquaredErrors ||
    left.baselineOd - right.baselineOd ||
    left.scaleOd - right.scaleOd ||
    left.activeConstraint.localeCompare(right.activeConstraint));
  const best = feasible[0];
  const predictions = predictOdFromLatentFractions(latentFractions, best);

  return {
    kind: "profiled_od600_observation_layer",
    equation: "OD600 = baselineOd + scaleOd * (N/K)",
    terminology: "observation-layer nuisance parameters",
    baselineOd: best.baselineOd,
    scaleOd: best.scaleOd,
    constraints: {
      baselineOd: ">= 0",
      scaleOd: `>= ${minimumScaleOd} (numerical representation of > 0)`,
    },
    minimumScaleOd,
    activeConstraint: best.activeConstraint,
    sumSquaredErrors: best.sumSquaredErrors,
    rootMeanSquaredError: Math.sqrt(best.sumSquaredErrors / count),
    observationCount: count,
    predictions,
  };
}

export const OD_OBSERVATION_MODEL_EQUATION = "OD600 = baselineOd + scaleOd * (N/K)";
export const MINIMUM_SCALE_OD = DEFAULT_MINIMUM_SCALE_OD;
