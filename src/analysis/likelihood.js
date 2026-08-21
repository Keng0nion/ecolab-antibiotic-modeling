const LOG_TWO_PI = Math.log(2 * Math.PI);
const LOG_HALF = Math.log(0.5);
const SQRT_TWO = Math.SQRT2;

function fail(code, message) {
  const error = new RangeError(message);
  error.code = code;
  throw error;
}

function assertNumber(value, name, { allowInfinity = false } = {}) {
  const valid =
    typeof value === "number" &&
    !Number.isNaN(value) &&
    (allowInfinity || Number.isFinite(value));
  if (!valid) fail("INVALID_NUMBER", `${name} must be a valid number.`);
  return value;
}

function assertSigma(sigma) {
  if (typeof sigma !== "number" || !Number.isFinite(sigma) || sigma <= 0) {
    fail("INVALID_SIGMA", "sigma must be finite and strictly greater than zero.");
  }
  return sigma;
}

const ERF_T = [
  9.604973739870516,
  90.02601972038427,
  2232.005345946843,
  7003.325141128051,
  55592.30100510965,
];
const ERF_U = [
  33.56171416475031,
  521.3579497801527,
  4594.323829709801,
  22629.000061389095,
  49267.39426086359,
];
const ERFC_P = [
  2.461969814735305e-10,
  0.5641895648310688,
  7.463210564422699,
  48.63719709856814,
  196.5208329560771,
  526.4451949954773,
  934.5285271719576,
  1027.5518868951572,
  557.5353353693993,
];
const ERFC_Q = [
  13.228195115474499,
  86.70721408859897,
  354.9377788878199,
  975.7085017432055,
  1823.9091668790973,
  2246.3376081871097,
  1656.6630919416134,
  557.5353408177277,
];
const ERFC_R = [
  0.5641895835477551,
  1.275366707599781,
  5.019050422511805,
  6.160210979930536,
  7.4097426995044895,
  2.9788666537210022,
];
const ERFC_S = [
  2.2605286322011726,
  9.396035249380014,
  12.048953980809666,
  17.08144507475659,
  9.60896809063286,
  3.369076451000815,
];

function polynomial(x, coefficients) {
  let value = coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1) {
    value = value * x + coefficients[index];
  }
  return value;
}

function polynomialWithLeadingOne(x, coefficients) {
  let value = x + coefficients[0];
  for (let index = 1; index < coefficients.length; index += 1) {
    value = value * x + coefficients[index];
  }
  return value;
}

function erfSmall(x) {
  const squared = x * x;
  return (
    (x * polynomial(squared, ERF_T)) /
    polynomialWithLeadingOne(squared, ERF_U)
  );
}

// Cephes rational approximations, evaluated directly in log space for tails.
function logErfcPositive(x) {
  if (x < 1) return Math.log1p(-erfSmall(x));
  const numerator = polynomial(x, x < 8 ? ERFC_P : ERFC_R);
  const denominator = polynomialWithLeadingOne(x, x < 8 ? ERFC_Q : ERFC_S);
  return -x * x + Math.log(numerator) - Math.log(denominator);
}

export function logStandardNormalCdf(z) {
  assertNumber(z, "z", { allowInfinity: true });
  if (z === -Infinity) return -Infinity;
  if (z === Infinity) return 0;
  if (z <= 0) return LOG_HALF + logErfcPositive(-z / SQRT_TWO);
  const logTail = logStandardNormalCdf(-z);
  return Math.log1p(-Math.exp(logTail));
}

export function logStandardNormalSurvival(z) {
  assertNumber(z, "z", { allowInfinity: true });
  return logStandardNormalCdf(-z);
}

export function standardNormalCdf(z) {
  if (z < 0) return Math.exp(logStandardNormalCdf(z));
  return -Math.expm1(logStandardNormalSurvival(z));
}

export function standardNormalSurvival(z) {
  if (z > 0) return Math.exp(logStandardNormalSurvival(z));
  return -Math.expm1(logStandardNormalCdf(z));
}

export function logDifferenceExp(logA, logB) {
  assertNumber(logA, "logA", { allowInfinity: true });
  assertNumber(logB, "logB", { allowInfinity: true });
  if (logB > logA) {
    fail("INVALID_LOG_DIFFERENCE", "logA must be greater than or equal to logB.");
  }
  if (logB === -Infinity) return logA;
  if (logA === logB) return -Infinity;
  return logA + Math.log(-Math.expm1(logB - logA));
}

export function gaussianLogLikelihood(observed, mean, sigma) {
  assertNumber(observed, "observed");
  assertNumber(mean, "mean");
  assertSigma(sigma);
  const z = (observed - mean) / sigma;
  return -0.5 * (LOG_TWO_PI + 2 * Math.log(sigma) + z * z);
}

export function logNormalCdf(limit, mean, sigma) {
  assertNumber(limit, "limit", { allowInfinity: true });
  assertNumber(mean, "mean");
  assertSigma(sigma);
  return logStandardNormalCdf((limit - mean) / sigma);
}

export function logNormalSurvival(limit, mean, sigma) {
  assertNumber(limit, "limit", { allowInfinity: true });
  assertNumber(mean, "mean");
  assertSigma(sigma);
  return logStandardNormalSurvival((limit - mean) / sigma);
}

export function logNormalIntervalProbability(lower, upper, mean, sigma) {
  assertNumber(lower, "lower", { allowInfinity: true });
  assertNumber(upper, "upper", { allowInfinity: true });
  assertNumber(mean, "mean");
  assertSigma(sigma);
  if (lower > upper) {
    fail("INVALID_INTERVAL", "lower must be less than or equal to upper.");
  }
  if (lower === upper) return -Infinity;
  if (lower === -Infinity) return logNormalCdf(upper, mean, sigma);
  if (upper === Infinity) return logNormalSurvival(lower, mean, sigma);

  const lowerZ = (lower - mean) / sigma;
  const upperZ = (upper - mean) / sigma;
  if (lowerZ >= 0) {
    return logDifferenceExp(
      logStandardNormalSurvival(lowerZ),
      logStandardNormalSurvival(upperZ),
    );
  }
  return logDifferenceExp(
    logStandardNormalCdf(upperZ),
    logStandardNormalCdf(lowerZ),
  );
}

function normalizeCensoring(observation) {
  if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
    fail("INVALID_OBSERVATION", "observation must be an object.");
  }
  const descriptor =
    observation.censoring && typeof observation.censoring === "object"
      ? observation.censoring
      : observation;
  const rawType =
    (typeof observation.censoring === "string" ? observation.censoring : null) ??
    descriptor.type ??
    observation.censoringType ??
    observation.censorType ??
    "exact";
  const normalized = String(rawType).toLowerCase().replaceAll("-", "_");
  const type =
    normalized === "none" || normalized === "uncensored" || normalized === "observed"
      ? "exact"
      : normalized === "left_censored" || normalized === "below" || normalized === "<"
        ? "left"
        : normalized === "right_censored" || normalized === "above" || normalized === ">"
          ? "right"
          : normalized === "interval_censored"
            ? "interval"
            : normalized;
  const censoringBounds = observation.censoringBounds ?? descriptor.bounds ?? {};
  const value =
    descriptor.value ??
    observation.value ??
    observation.observed ??
    observation.observedValue ??
    observation.log10Value ??
    observation.observedLog10;
  const lower =
    descriptor.lower ??
    descriptor.lowerBound ??
    censoringBounds.lower ??
    observation.lower ??
    observation.lowerBound ??
    observation.interval?.[0] ??
    (type === "right" ? descriptor.limit ?? observation.limit : undefined);
  const upper =
    descriptor.upper ??
    descriptor.upperBound ??
    censoringBounds.upper ??
    observation.upper ??
    observation.upperBound ??
    observation.interval?.[1] ??
    (type === "left" ? descriptor.limit ?? observation.limit : undefined);
  return { type, value, lower, upper };
}

export function censoredGaussianLogLikelihood(observation, mean, sigma) {
  assertNumber(mean, "mean");
  assertSigma(sigma);
  const normalized = normalizeCensoring(observation);
  switch (normalized.type) {
    case "exact":
      return gaussianLogLikelihood(normalized.value, mean, sigma);
    case "left":
      return logNormalCdf(normalized.upper, mean, sigma);
    case "right":
      return logNormalSurvival(normalized.lower, mean, sigma);
    case "interval":
      return logNormalIntervalProbability(
        normalized.lower,
        normalized.upper,
        mean,
        sigma,
      );
    default:
      fail(
        "INVALID_CENSORING_TYPE",
        `Unsupported censoring type: ${String(normalized.type)}.`,
      );
  }
}

export function gaussianObservationLogLikelihood(observation, mean, sigma) {
  return censoredGaussianLogLikelihood(observation, mean, sigma);
}

export function sumGaussianLogLikelihood(observations, predictions, sigma) {
  if (!Array.isArray(observations) || !Array.isArray(predictions)) {
    fail("INVALID_ARRAY", "observations and predictions must be arrays.");
  }
  if (observations.length !== predictions.length) {
    fail("LENGTH_MISMATCH", "observations and predictions must have equal length.");
  }
  let total = 0;
  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const currentSigma =
      typeof sigma === "function"
        ? sigma(observation, index)
        : observation?.sigma ?? sigma;
    total +=
      typeof observation === "number"
        ? gaussianLogLikelihood(observation, predictions[index], currentSigma)
        : censoredGaussianLogLikelihood(
            observation,
            predictions[index],
            currentSigma,
          );
  }
  return total;
}

export const normalCdf = standardNormalCdf;
export const normalSurvival = standardNormalSurvival;
export const normalLogCdf = logNormalCdf;
export const normalLogSurvival = logNormalSurvival;
export const exactGaussianLogLikelihood = gaussianLogLikelihood;
export const gaussianLogPdf = gaussianLogLikelihood;
export const normalLogPdf = gaussianLogLikelihood;
export const censoredNormalLogLikelihood = censoredGaussianLogLikelihood;
export const gaussianCensoredLogLikelihood = censoredGaussianLogLikelihood;
