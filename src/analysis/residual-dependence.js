/**
 * Residual-dependence utilities for profile-likelihood intervals.
 *
 * The research workflow fits a Gaussian least-squares model that treats every
 * observation as independent. Training OD residuals are strongly serially
 * correlated within a curve and share a curve-level offset, so the IID profile
 * interval is a working-independence approximation. This module supplies the
 * deterministic pieces needed to report an interval under a random-intercept
 * AR(1) working covariance without changing the point estimate:
 *
 *   Sigma_b = sigma^2 * (R(phi) + lambda * 1 1^T)
 *
 * where R(phi) is the AR(1) correlation matrix of one curve, lambda is the
 * between-curve variance divided by the within-curve variance, and sigma^2 is
 * profiled analytically. Everything here is pure, synchronous and free of wall
 * clock or random state so that benchmark outputs are reproducible.
 */

function fail(code, message) {
  const error = new RangeError(message);
  error.code = code;
  throw error;
}

function assertFinite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_NUMBER", `${name} must be a finite number.`);
  }
  return value;
}

function residualValue(entry) {
  if (typeof entry === "number") return entry;
  if (entry && typeof entry.residual === "number") return entry.residual;
  fail("INVALID_RESIDUAL", "Each residual must be a number or an object with a numeric residual field.");
}

function timeValue(observation) {
  if (!observation || typeof observation !== "object") {
    fail("INVALID_OBSERVATION", "Each observation must be an object.");
  }
  return assertFinite(observation.timeHours, "observation.timeHours");
}

function unitValue(observation, index) {
  const unit = observation.independentUnitId ?? observation.unitId ?? observation.seriesId;
  if (typeof unit !== "string" || unit === "") {
    fail("MISSING_INDEPENDENT_UNIT", `observations[${index}] has no independent unit identifier.`);
  }
  return unit;
}

/**
 * Group aligned observations and residuals into curves ordered by time.
 * Returns blocks of { unit, times, residuals, index }.
 */
export function groupResidualsByCurve(observations, residuals) {
  if (!Array.isArray(observations) || !Array.isArray(residuals)) {
    fail("INVALID_ARRAY", "observations and residuals must be arrays.");
  }
  if (observations.length !== residuals.length) {
    fail("LENGTH_MISMATCH", "observations and residuals must have equal length.");
  }
  const blocks = new Map();
  observations.forEach((observation, index) => {
    const unit = unitValue(observation, index);
    const time = timeValue(observation);
    if (!blocks.has(unit)) blocks.set(unit, []);
    blocks.get(unit).push({ time, residual: residualValue(residuals[index]), index });
  });
  return [...blocks.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([unit, rows]) => {
      rows.sort((left, right) => left.time - right.time || left.index - right.index);
      return {
        unit,
        times: rows.map(({ time }) => time),
        residuals: rows.map(({ residual }) => residual),
        index: rows.map(({ index }) => index),
      };
    });
}

function assertEqualSpacing(block) {
  if (block.times.length < 2) return 0;
  const step = block.times[1] - block.times[0];
  if (!(step > 0)) fail("INVALID_TIME_ORDER", `Curve ${block.unit} has non-increasing times.`);
  for (let index = 2; index < block.times.length; index += 1) {
    const candidate = block.times[index] - block.times[index - 1];
    if (Math.abs(candidate - step) > 1e-9 * Math.max(1, Math.abs(step))) {
      fail(
        "AR1_REQUIRES_EQUAL_SPACING",
        `Curve ${block.unit} is not equally spaced; a continuous-time covariance is required.`,
      );
    }
  }
  return step;
}

/**
 * Pooled lag-one autocorrelation of residuals within curves.
 * phi = sum_t e_t e_{t-1} / sum_t e_{t-1}^2, pooled over curves.
 */
export function pooledAr1Coefficient(observations, residuals) {
  const blocks = groupResidualsByCurve(observations, residuals);
  let numerator = 0;
  let denominator = 0;
  let pairs = 0;
  for (const block of blocks) {
    assertEqualSpacing(block);
    const series = block.residuals;
    for (let index = 1; index < series.length; index += 1) {
      numerator += series[index] * series[index - 1];
      denominator += series[index - 1] * series[index - 1];
      pairs += 1;
    }
  }
  if (!(denominator > 0)) return { phi: 0, pairs, curveCount: blocks.length };
  const raw = numerator / denominator;
  const phi = Math.max(-0.99, Math.min(0.99, raw));
  return { phi, raw, pairs, curveCount: blocks.length };
}

/**
 * Method-of-moments variance components for a balanced random intercept:
 * between-curve variance of curve means, within-curve residual variance.
 * lambda = max(0, between^2 / within^2).
 */
export function estimateVarianceComponents(observations, residuals) {
  const blocks = groupResidualsByCurve(observations, residuals);
  if (blocks.length === 0) fail("NO_CURVES", "At least one curve is required.");
  const sizes = blocks.map((block) => block.residuals.length);
  const balanced = sizes.every((size) => size === sizes[0]);
  if (!balanced) {
    fail("UNBALANCED_CURVES", "Random-intercept variance components require equal curve lengths.");
  }
  const perCurve = sizes[0];
  if (perCurve < 2) fail("TOO_FEW_POINTS", "Each curve needs at least two observations.");
  const means = blocks.map((block) => block.residuals.reduce((sum, value) => sum + value, 0) / perCurve);
  const grand = means.reduce((sum, value) => sum + value, 0) / means.length;
  const betweenSum = means.reduce((sum, value) => sum + (value - grand) ** 2, 0);
  const betweenVariance = means.length > 1 ? betweenSum / (means.length - 1) : 0;
  let withinSum = 0;
  blocks.forEach((block, blockIndex) => {
    for (const value of block.residuals) withinSum += (value - means[blockIndex]) ** 2;
  });
  const withinVariance = withinSum / (blocks.length * (perCurve - 1));
  const betweenCurveVariance = Math.max(0, betweenVariance - withinVariance / perCurve);
  const lambda = withinVariance > 0 ? betweenCurveVariance / withinVariance : 0;
  const icc = betweenCurveVariance + withinVariance > 0
    ? betweenCurveVariance / (betweenCurveVariance + withinVariance)
    : 0;
  return {
    curveCount: blocks.length,
    observationsPerCurve: perCurve,
    betweenCurveVariance,
    withinVariance,
    betweenCurveSd: Math.sqrt(betweenCurveVariance),
    withinCurveSd: Math.sqrt(withinVariance),
    lambda,
    icc,
  };
}

/**
 * Design effect of the fitted working covariance for the curve mean:
 * deff = (1'R1) / T + lambda * T, where 1'R1 sums the AR(1) correlations.
 * This is the factor by which the variance of a curve mean exceeds sigma^2 / T.
 */
export function ar1DesignEffect(size, phi, lambda = 0) {
  assertFinite(phi, "phi");
  assertFinite(lambda, "lambda");
  if (!Number.isInteger(size) || size < 1) fail("INVALID_SIZE", "size must be a positive integer.");
  let correlationSum = size;
  for (let lag = 1; lag < size; lag += 1) {
    correlationSum += 2 * (size - lag) * phi ** lag;
  }
  return correlationSum / size + lambda * size;
}

/**
 * Quadratic form e^T R^{-1} e and the two scalar summaries needed for the
 * random-intercept Woodbury correction, for one equally spaced curve.
 */
export function ar1BlockSummaries(series, phi) {
  assertFinite(phi, "phi");
  if (!(phi > -1 && phi < 1)) fail("INVALID_PHI", "phi must lie strictly between -1 and 1.");
  const values = series.map((value, index) => assertFinite(value, `series[${index}]`));
  const size = values.length;
  if (size === 0) return { quadratic: 0, sumRE: 0, sumR1: 0, logDeterminant: 0 };
  if (size === 1) {
    return { quadratic: values[0] ** 2, sumRE: values[0], sumR1: 1, logDeterminant: 0 };
  }
  const inverseOneMinusPhiSquared = 1 / (1 - phi * phi);
  let diagonalSum = 0;
  let interiorSum = 0;
  let lagProduct = 0;
  for (let index = 0; index < size; index += 1) {
    diagonalSum += values[index] ** 2;
    if (index > 0 && index < size - 1) interiorSum += values[index];
    if (index < size - 1) lagProduct += values[index] * values[index + 1];
  }
  const first = values[0];
  const last = values[size - 1];
  const quadratic = inverseOneMinusPhiSquared
    * (first ** 2 + last ** 2 + (1 + phi * phi) * (diagonalSum - first ** 2 - last ** 2) - 2 * phi * lagProduct);
  const sumRE = inverseOneMinusPhiSquared
    * (first + last + (1 + phi * phi) * interiorSum - phi * (first + last + 2 * interiorSum));
  const sumR1 = inverseOneMinusPhiSquared
    * (2 + (1 + phi * phi) * (size - 2) - 2 * phi * (size - 1));
  const logDeterminant = (size - 1) * Math.log1p(-phi * phi);
  return { quadratic, sumRE, sumR1, logDeterminant };
}

/**
 * Profile negative log-likelihood under a block-diagonal random-intercept AR(1)
 * covariance, with sigma^2 profiled analytically.
 *
 * NLL = 0.5 * (n * log(Q / n) + sum_b [log|R_b| + log(1 + lambda * 1'R_b^{-1}1)])
 * Q   = sum_b [e_b'R_b^{-1}e_b - lambda (1'R_b^{-1}e_b)^2 / (1 + lambda * 1'R_b^{-1}1)]
 *
 * Constants independent of the parameters are dropped; comparisons and
 * threshold crossings are unaffected.
 */
export function randomInterceptAr1ProfileNegativeLogLikelihood({
  observations,
  residuals,
  phi,
  lambda,
}) {
  assertFinite(lambda, "lambda");
  if (lambda < 0) fail("INVALID_LAMBDA", "lambda must be non-negative.");
  const blocks = groupResidualsByCurve(observations, residuals);
  let count = 0;
  let quadratic = 0;
  let logDeterminant = 0;
  for (const block of blocks) {
    assertEqualSpacing(block);
    const summaries = ar1BlockSummaries(block.residuals, phi);
    const inflation = 1 + lambda * summaries.sumR1;
    if (!(inflation > 0)) fail("INVALID_COVARIANCE", "The random-intercept covariance is not positive definite.");
    const adjusted = summaries.quadratic
      - (lambda * summaries.sumRE ** 2) / inflation;
    if (!(adjusted > 0)) fail("INVALID_QUADRATIC_FORM", "The profiled residual quadratic form is not positive.");
    quadratic += adjusted;
    logDeterminant += summaries.logDeterminant + Math.log(inflation);
    count += block.residuals.length;
  }
  if (count === 0) fail("NO_OBSERVATIONS", "At least one residual is required.");
  return 0.5 * (count * Math.log(quadratic / count) + logDeterminant);
}

/**
 * Deterministic bracket-and-bisection refinement of a threshold crossing.
 *
 * The caller supplies a bracket in which `delta` decreases through `threshold`
 * from `outer` to `inner`. Each evaluation is expensive (a constrained refit),
 * so the loop is capped and stops on a relative width criterion. The returned
 * value is the linear interpolation of the final bracket, which is consistent
 * with the grid interpolation used before refinement and avoids pretending to
 * a precision the refits do not support.
 */
export async function refineThresholdCrossing({
  evaluate,
  inner,
  outer,
  innerDelta,
  outerDelta,
  threshold,
  relativeTolerance = 1e-6,
  maxIterations = 8,
}) {
  if (typeof evaluate !== "function") fail("INVALID_EVALUATOR", "evaluate must be a function.");
  assertFinite(inner, "inner");
  assertFinite(outer, "outer");
  assertFinite(innerDelta, "innerDelta");
  assertFinite(outerDelta, "outerDelta");
  assertFinite(threshold, "threshold");
  assertFinite(relativeTolerance, "relativeTolerance");
  assertFinite(maxIterations, "maxIterations");
  if (!(innerDelta <= threshold && outerDelta > threshold)) {
    fail("INVALID_BRACKET", "The bracket must satisfy innerDelta <= threshold < outerDelta.");
  }
  let inside = inner;
  let outside = outer;
  let insideDelta = innerDelta;
  let outsideDelta = outerDelta;
  let iterations = 0;
  let evaluations = 0;
  let failed = false;
  const scale = () => Math.max(1, Math.abs(inside), Math.abs(outside));
  while (iterations < maxIterations && Math.abs(outside - inside) > relativeTolerance * scale()) {
    const midpoint = (inside + outside) / 2;
    if (midpoint === inside || midpoint === outside) break;
    iterations += 1;
    evaluations += 1;
    let result;
    try {
      result = await evaluate(midpoint);
    } catch {
      failed = true;
      break;
    }
    if (!result || !Number.isFinite(result.delta)) {
      failed = true;
      break;
    }
    if (result.delta > threshold) {
      outside = midpoint;
      outsideDelta = result.delta;
    } else {
      inside = midpoint;
      insideDelta = result.delta;
    }
  }
  const span = outsideDelta - insideDelta;
  const fraction = span === 0 ? 0.5 : (threshold - insideDelta) / span;
  const value = inside + (outside - inside) * Math.min(1, Math.max(0, fraction));
  return {
    value,
    bracket: [inside, outside],
    bracketWidth: Math.abs(outside - inside),
    iterations,
    evaluations,
    failed,
    converged: !failed,
    method: "bracket_bisection_linear_interpolation",
    relativeTolerance,
    maxIterations,
  };
}
