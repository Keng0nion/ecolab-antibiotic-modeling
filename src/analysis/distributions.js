const SUPPORTED_DISTRIBUTIONS = Object.freeze([
  "fixed",
  "uniform",
  "triangular",
  "normal",
  "truncated_normal",
  "lognormal",
  "empirical_discrete",
]);

export { SUPPORTED_DISTRIBUTIONS };

function fail(code, message, path = "distribution", ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  error.path = path;
  throw error;
}

function plainObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("INVALID_DISTRIBUTION", `${path} must be a plain object.`, path);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_DISTRIBUTION_NUMBER", `${path} must be a finite number.`, path);
  }
  return value;
}

function positive(value, path) {
  finite(value, path);
  if (value <= 0) fail("INVALID_DISTRIBUTION_NUMBER", `${path} must be greater than zero.`, path);
  return value;
}

function exactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail("UNKNOWN_DISTRIBUTION_FIELD", `${path}.${key} is not allowed.`, `${path}.${key}`);
    }
  }
}

function cloneFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFreeze));
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneFreeze(child);
    return Object.freeze(result);
  }
  return value;
}

function typeOf(specification) {
  return specification.type ?? specification.kind ?? specification.distribution;
}

function normalMean(specification, path) {
  if (specification.mean !== undefined) return finite(specification.mean, `${path}.mean`);
  if (specification.mu !== undefined) return finite(specification.mu, `${path}.mu`);
  fail("MISSING_DISTRIBUTION_FIELD", `${path}.mean is required.`, `${path}.mean`);
}

function normalStandardDeviation(specification, path) {
  const value = specification.standardDeviation ?? specification.sd ?? specification.sigma;
  if (value === undefined) {
    fail(
      "MISSING_DISTRIBUTION_FIELD",
      `${path}.standardDeviation is required; literature standard errors are never inferred.`,
      `${path}.standardDeviation`,
    );
  }
  return positive(value, `${path}.standardDeviation`);
}

function validateEmpirical(specification, path) {
  exactKeys(specification, ["type", "kind", "distribution", "values", "probabilities", "weights"], path);
  if (!Array.isArray(specification.values) || specification.values.length === 0) {
    fail("INVALID_EMPIRICAL_VALUES", `${path}.values must be a non-empty array.`, `${path}.values`);
  }
  const values = specification.values.map((value, index) => finite(value, `${path}.values[${index}]`));
  const supplied = specification.probabilities ?? specification.weights;
  let probabilities;
  if (supplied === undefined) {
    probabilities = values.map(() => 1 / values.length);
  } else {
    if (!Array.isArray(supplied) || supplied.length !== values.length) {
      fail(
        "INVALID_EMPIRICAL_PROBABILITIES",
        `${path}.probabilities must have one entry per value.`,
        `${path}.probabilities`,
      );
    }
    const weights = supplied.map((value, index) => {
      finite(value, `${path}.probabilities[${index}]`);
      if (value < 0) {
        fail(
          "INVALID_EMPIRICAL_PROBABILITIES",
          `${path}.probabilities[${index}] cannot be negative.`,
          `${path}.probabilities[${index}]`,
        );
      }
      return value;
    });
    const total = weights.reduce((sum, value) => sum + value, 0);
    if (!Number.isFinite(total) || total <= 0) {
      fail(
        "INVALID_EMPIRICAL_PROBABILITIES",
        `${path}.probabilities must have a positive finite sum.`,
        `${path}.probabilities`,
      );
    }
    probabilities = weights.map((value) => value / total);
  }
  return { type: "empirical_discrete", values, probabilities };
}

/** Validate and canonicalize a supported distribution specification. */
export function validateDistribution(specification, path = "distribution") {
  plainObject(specification, path);
  const rawType = typeOf(specification);
  if (typeof rawType !== "string" || !SUPPORTED_DISTRIBUTIONS.includes(rawType)) {
    fail(
      "UNSUPPORTED_DISTRIBUTION",
      `${path}.type must be one of: ${SUPPORTED_DISTRIBUTIONS.join(", ")}.`,
      `${path}.type`,
    );
  }

  let result;
  switch (rawType) {
    case "fixed": {
      exactKeys(specification, ["type", "kind", "distribution", "value"], path);
      result = { type: rawType, value: finite(specification.value, `${path}.value`) };
      break;
    }
    case "uniform": {
      exactKeys(specification, ["type", "kind", "distribution", "minimum", "maximum", "min", "max"], path);
      const minimum = finite(specification.minimum ?? specification.min, `${path}.minimum`);
      const maximum = finite(specification.maximum ?? specification.max, `${path}.maximum`);
      if (minimum >= maximum) {
        fail("INVALID_DISTRIBUTION_BOUNDS", `${path} requires minimum < maximum.`, path);
      }
      result = { type: rawType, minimum, maximum };
      break;
    }
    case "triangular": {
      exactKeys(
        specification,
        ["type", "kind", "distribution", "minimum", "maximum", "mode", "min", "max"],
        path,
      );
      const minimum = finite(specification.minimum ?? specification.min, `${path}.minimum`);
      const maximum = finite(specification.maximum ?? specification.max, `${path}.maximum`);
      const mode = finite(specification.mode, `${path}.mode`);
      if (minimum >= maximum || mode < minimum || mode > maximum) {
        fail(
          "INVALID_TRIANGULAR_PARAMETERS",
          `${path} requires minimum < maximum and minimum <= mode <= maximum.`,
          path,
        );
      }
      result = { type: rawType, minimum, mode, maximum };
      break;
    }
    case "normal": {
      exactKeys(
        specification,
        ["type", "kind", "distribution", "mean", "mu", "standardDeviation", "sd", "sigma"],
        path,
      );
      result = {
        type: rawType,
        mean: normalMean(specification, path),
        standardDeviation: normalStandardDeviation(specification, path),
      };
      break;
    }
    case "truncated_normal": {
      exactKeys(
        specification,
        [
          "type",
          "kind",
          "distribution",
          "mean",
          "mu",
          "standardDeviation",
          "sd",
          "sigma",
          "minimum",
          "maximum",
          "min",
          "max",
        ],
        path,
      );
      const minimum = finite(specification.minimum ?? specification.min, `${path}.minimum`);
      const maximum = finite(specification.maximum ?? specification.max, `${path}.maximum`);
      if (minimum >= maximum) {
        fail("INVALID_DISTRIBUTION_BOUNDS", `${path} requires minimum < maximum.`, path);
      }
      result = {
        type: rawType,
        mean: normalMean(specification, path),
        standardDeviation: normalStandardDeviation(specification, path),
        minimum,
        maximum,
      };
      break;
    }
    case "lognormal": {
      exactKeys(
        specification,
        [
          "type",
          "kind",
          "distribution",
          "logMean",
          "logStandardDeviation",
          "logMu",
          "logSigma",
          "logBase",
        ],
        path,
      );
      const logMean = finite(specification.logMean ?? specification.logMu, `${path}.logMean`);
      const logStandardDeviation = positive(
        specification.logStandardDeviation ?? specification.logSigma,
        `${path}.logStandardDeviation`,
      );
      const logBase = specification.logBase ?? "e";
      if (logBase !== "e" && logBase !== 10) {
        fail(
          "INVALID_LOG_BASE",
          `${path}.logBase must be "e" or 10. Lognormal parameters must be explicit log-space parameters.`,
          `${path}.logBase`,
        );
      }
      result = { type: rawType, logMean, logStandardDeviation, logBase };
      break;
    }
    case "empirical_discrete":
      result = validateEmpirical(specification, path);
      break;
    default:
      throw new Error("Unreachable distribution type.");
  }
  return cloneFreeze(result);
}

export const normalizeDistribution = validateDistribution;

function randomUnit(random, open = false) {
  if (!random || typeof random !== "object") {
    fail("INVALID_RANDOM_SOURCE", "A random source object is required.", "random");
  }
  const method = open
    ? random.nextOpen ?? random.next ?? random.random
    : random.next ?? random.random;
  if (typeof method !== "function") {
    fail("INVALID_RANDOM_SOURCE", "The random source must expose next() or random().", "random");
  }
  const value = method.call(random);
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail("INVALID_RANDOM_SOURCE", "The random source returned an invalid unit value.", "random");
  }
  if (open) return Math.min(1 - Number.EPSILON, Math.max(Number.MIN_VALUE, value));
  return value === 1 ? 1 - Number.EPSILON : value;
}

function standardNormal(random) {
  const u1 = randomUnit(random, true);
  const u2 = randomUnit(random, false);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function inverseStandardNormal(probability) {
  if (probability <= 0) return -Infinity;
  if (probability >= 1) return Infinity;
  const a = [
    -3.969683028665376e1,
    2.209460984245205e2,
    -2.759285104469687e2,
    1.38357751867269e2,
    -3.066479806614716e1,
    2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1,
    1.615858368580409e2,
    -1.556989798598866e2,
    6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3,
    -3.223964580411365e-1,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    7.784695709041462e-3,
    3.224671290700398e-1,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(
      (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    );
  }
  const q = probability - 0.5;
  const r = q * q;
  return (
    (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
  );
}

function normalCdf(value) {
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const polynomial =
    t *
    (0.319381530 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const lower = 1 - density * polynomial;
  return value >= 0 ? lower : 1 - lower;
}

/** Draw one value. Validation is always performed unless a canonical frozen spec is supplied. */
export function sampleDistribution(specification, random) {
  const spec = validateDistribution(specification);
  switch (spec.type) {
    case "fixed":
      return spec.value;
    case "uniform":
      return spec.minimum + randomUnit(random) * (spec.maximum - spec.minimum);
    case "triangular": {
      const unit = randomUnit(random);
      const fraction = (spec.mode - spec.minimum) / (spec.maximum - spec.minimum);
      if (unit < fraction) {
        return spec.minimum + Math.sqrt(unit * (spec.maximum - spec.minimum) * (spec.mode - spec.minimum));
      }
      return spec.maximum - Math.sqrt((1 - unit) * (spec.maximum - spec.minimum) * (spec.maximum - spec.mode));
    }
    case "normal":
      return spec.mean + spec.standardDeviation * standardNormal(random);
    case "truncated_normal": {
      const lower = normalCdf((spec.minimum - spec.mean) / spec.standardDeviation);
      const upper = normalCdf((spec.maximum - spec.mean) / spec.standardDeviation);
      if (!(upper > lower)) {
        fail(
          "NUMERICALLY_DEGENERATE_TRUNCATION",
          "The truncated normal has negligible probability within its bounds.",
        );
      }
      const probability = lower + randomUnit(random, true) * (upper - lower);
      const result = spec.mean + spec.standardDeviation * inverseStandardNormal(probability);
      return Math.min(spec.maximum, Math.max(spec.minimum, result));
    }
    case "lognormal": {
      const logValue = spec.logMean + spec.logStandardDeviation * standardNormal(random);
      return spec.logBase === 10 ? 10 ** logValue : Math.exp(logValue);
    }
    case "empirical_discrete": {
      const unit = randomUnit(random);
      let cumulative = 0;
      for (let index = 0; index < spec.values.length; index += 1) {
        cumulative += spec.probabilities[index];
        if (unit < cumulative || index === spec.values.length - 1) return spec.values[index];
      }
      return spec.values.at(-1);
    }
    default:
      throw new Error("Unreachable distribution type.");
  }
}

export const drawDistribution = sampleDistribution;
export const sample = sampleDistribution;

export function distributionBounds(specification) {
  const spec = validateDistribution(specification);
  switch (spec.type) {
    case "fixed":
      return Object.freeze([spec.value, spec.value]);
    case "uniform":
    case "triangular":
    case "truncated_normal":
      return Object.freeze([spec.minimum, spec.maximum]);
    case "empirical_discrete":
      return Object.freeze([Math.min(...spec.values), Math.max(...spec.values)]);
    case "normal":
    case "lognormal":
      return null;
    default:
      throw new Error("Unreachable distribution type.");
  }
}
