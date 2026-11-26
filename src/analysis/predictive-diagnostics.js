import { gaussianLogLikelihood, normalCdf } from "./likelihood.js";

export class PredictiveDiagnosticsError extends RangeError {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PredictiveDiagnosticsError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new PredictiveDiagnosticsError(code, message, details);
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_PREDICTIVE_NUMBER", `${name} must be finite.`);
  }
  return value;
}

function mixtureCdf(value, means, sigmas) {
  let probability = 0;
  for (let index = 0; index < means.length; index += 1) {
    probability += normalCdf((value - means[index]) / sigmas[index]);
  }
  return probability / means.length;
}

function mixtureQuantile(probability, means, sigmas) {
  let lower = Infinity;
  let upper = -Infinity;
  for (let index = 0; index < means.length; index += 1) {
    lower = Math.min(lower, means[index] - 12 * sigmas[index]);
    upper = Math.max(upper, means[index] + 12 * sigmas[index]);
  }
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const middle = lower + (upper - lower) / 2;
    if (mixtureCdf(middle, means, sigmas) < probability) lower = middle;
    else upper = middle;
  }
  return lower + (upper - lower) / 2;
}

function logMeanExp(values) {
  const maximum = Math.max(...values);
  if (maximum === -Infinity) return -Infinity;
  let sum = 0;
  for (const value of values) sum += Math.exp(value - maximum);
  return maximum + Math.log(sum / values.length);
}

function normalizeInputs({ observations, samples, intervalLevel = 0.95 }) {
  if (!Array.isArray(observations) || observations.length === 0) {
    fail("EMPTY_PREDICTIVE_OBSERVATIONS", "observations must be a non-empty array.");
  }
  if (!Array.isArray(samples) || samples.length === 0) {
    fail("EMPTY_PREDICTIVE_SAMPLES", "samples must be a non-empty array.");
  }
  if (typeof intervalLevel !== "number" || !Number.isFinite(intervalLevel) || intervalLevel <= 0 || intervalLevel >= 1) {
    fail("INVALID_PREDICTIVE_INTERVAL_LEVEL", "intervalLevel must be strictly between zero and one.");
  }
  const normalizedSamples = samples.map((sample, sampleIndex) => {
    if (!sample || !Array.isArray(sample.means) || !Array.isArray(sample.sigmas)
      || sample.means.length !== observations.length || sample.sigmas.length !== observations.length) {
      fail("PREDICTIVE_VECTOR_LENGTH_MISMATCH", `sample ${sampleIndex} must have one mean and sigma per observation.`);
    }
    const means = sample.means.map((value, observationIndex) => finite(value, `samples[${sampleIndex}].means[${observationIndex}]`));
    const sigmas = sample.sigmas.map((value, observationIndex) => {
      finite(value, `samples[${sampleIndex}].sigmas[${observationIndex}]`);
      if (value <= 0) fail("INVALID_PREDICTIVE_SIGMA", `samples[${sampleIndex}].sigmas[${observationIndex}] must be positive.`);
      return value;
    });
    return { means, sigmas };
  });
  const normalizedObservations = observations.map((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      fail("INVALID_PREDICTIVE_OBSERVATION", `observations[${index}] must be an object.`);
    }
    const censoring = observation.censoring ?? "none";
    if (censoring !== "none" && censoring !== "left") {
      fail("UNSUPPORTED_PREDICTIVE_CENSORING", `observations[${index}] supports only exact or left censoring.`);
    }
    const value = finite(observation.value, `observations[${index}].value`);
    const upper = censoring === "left"
      ? finite(observation.censoringBounds?.upper, `observations[${index}].censoringBounds.upper`)
      : null;
    return { observationId: observation.observationId ?? null, value, censoring, upper };
  });
  return { observations: normalizedObservations, samples: normalizedSamples, intervalLevel };
}

/**
 * Summarize a finite mixture of Gaussian observation predictions.
 * Each sample is one joint parameter-bootstrap fit, with one predicted mean and
 * residual sigma per observation. Left-censored values are scored as events.
 */
export function summarizeGaussianMixturePredictions(options) {
  const { observations, samples, intervalLevel } = normalizeInputs(options ?? {});
  const tailProbability = (1 - intervalLevel) / 2;
  const predictions = observations.map((observation, observationIndex) => {
    const means = samples.map(({ means: values }) => values[observationIndex]);
    const sigmas = samples.map(({ sigmas: values }) => values[observationIndex]);
    const mean = means.reduce((sum, value) => sum + value, 0) / means.length;
    const lower = mixtureQuantile(tailProbability, means, sigmas);
    const median = mixtureQuantile(0.5, means, sigmas);
    const upper = mixtureQuantile(1 - tailProbability, means, sigmas);
    if (observation.censoring === "left") {
      const censorProbability = mixtureCdf(observation.upper, means, sigmas);
      return {
        observationId: observation.observationId,
        censoring: "left",
        mean,
        lower,
        median,
        upper,
        censorProbability,
        censoredLogScore: Math.log(Math.max(censorProbability, Number.MIN_VALUE)),
        intervalCovered: null,
        exactLogPredictiveDensity: null,
      };
    }
    const componentLogDensities = means.map((componentMean, index) =>
      gaussianLogLikelihood(observation.value, componentMean, sigmas[index]));
    return {
      observationId: observation.observationId,
      censoring: "none",
      mean,
      lower,
      median,
      upper,
      exactLogPredictiveDensity: logMeanExp(componentLogDensities),
      intervalCovered: observation.value >= lower && observation.value <= upper,
      censorProbability: null,
      censoredLogScore: null,
    };
  });
  const exact = predictions.filter((row) => row.censoring === "none");
  const censored = predictions.filter((row) => row.censoring === "left");
  const coverageCount = exact.filter((row) => row.intervalCovered).length;
  return {
    status: "available",
    method: "finite_gaussian_mixture_from_joint_parameter_bootstrap",
    intervalLevel,
    sampleCount: samples.length,
    predictions,
    summary: {
      exactObservationCount: exact.length,
      leftCensoredObservationCount: censored.length,
      exactIntervalCoveredCount: coverageCount,
      exactIntervalCoverage: exact.length ? coverageCount / exact.length : null,
      meanExactLogPredictiveDensity: exact.length
        ? exact.reduce((sum, row) => sum + row.exactLogPredictiveDensity, 0) / exact.length
        : null,
      meanLeftCensoredLogScore: censored.length
        ? censored.reduce((sum, row) => sum + row.censoredLogScore, 0) / censored.length
        : null,
    },
  };
}

/**
 * Summarize split-conformal calibration scores, with one maximum absolute
 * residual per independent trajectory. A requested level is unavailable when
 * its finite-sample order statistic lies beyond the observed calibration set.
 */
export function summarizeConformalTrajectoryScores({ scores, intervalLevels = [0.8, 0.9, 0.95] } = {}) {
  if (!Array.isArray(scores) || scores.length === 0) {
    fail("EMPTY_TRAJECTORY_CALIBRATION", "scores must contain at least one independent trajectory.");
  }
  if (!Array.isArray(intervalLevels) || intervalLevels.length === 0) {
    fail("INVALID_PREDICTIVE_INTERVAL_LEVEL", "intervalLevels must be a non-empty array.");
  }
  const seen = new Set();
  const normalizedScores = scores.map((score, index) => {
    if (!score || typeof score !== "object" || Array.isArray(score)
      || typeof score.independentUnitId !== "string" || !score.independentUnitId.trim()) {
      fail("INVALID_CALIBRATION_UNIT", `scores[${index}] requires an independentUnitId.`);
    }
    if (seen.has(score.independentUnitId)) {
      fail("DUPLICATE_CALIBRATION_UNIT", `independentUnitId ${score.independentUnitId} occurs more than once.`);
    }
    seen.add(score.independentUnitId);
    const maximumAbsoluteResidual = finite(score.maximumAbsoluteResidual, `scores[${index}].maximumAbsoluteResidual`);
    if (maximumAbsoluteResidual < 0) {
      fail("INVALID_TRAJECTORY_SCORE", `scores[${index}].maximumAbsoluteResidual must be nonnegative.`);
    }
    return { independentUnitId: score.independentUnitId, maximumAbsoluteResidual };
  });
  const levels = {};
  const seenLevels = new Set();
  for (const intervalLevel of intervalLevels) {
    if (typeof intervalLevel !== "number" || !Number.isFinite(intervalLevel) || intervalLevel <= 0 || intervalLevel >= 1) {
      fail("INVALID_PREDICTIVE_INTERVAL_LEVEL", "Each interval level must be strictly between zero and one.");
    }
    const key = String(intervalLevel);
    if (seenLevels.has(key)) fail("DUPLICATE_PREDICTIVE_INTERVAL_LEVEL", `interval level ${key} occurs more than once.`);
    seenLevels.add(key);
    const oneBasedOrderStatistic = Math.ceil((normalizedScores.length + 1) * intervalLevel);
    const available = oneBasedOrderStatistic <= normalizedScores.length;
    const ordered = [...normalizedScores].sort((a, b) => a.maximumAbsoluteResidual - b.maximumAbsoluteResidual
      || a.independentUnitId.localeCompare(b.independentUnitId));
    levels[key] = {
      status: available ? "available" : "insufficient_finite_sample_resolution",
      intervalLevel,
      calibrationUnitCount: normalizedScores.length,
      oneBasedOrderStatistic,
      radius: available ? ordered[oneBasedOrderStatistic - 1].maximumAbsoluteResidual : null,
    };
  }
  return {
    method: "split_conformal_max_absolute_trajectory_residual",
    scoreDefinition: "maximum absolute OD residual across all observed time points in one independent trajectory",
    calibrationUnitCount: normalizedScores.length,
    calibrationIndependentUnitIds: normalizedScores.map(({ independentUnitId }) => independentUnitId).sort(),
    scores: normalizedScores.sort((a, b) => a.independentUnitId.localeCompare(b.independentUnitId)),
    levels,
    assumptions: [
      "Calibration trajectories and a future trajectory are exchangeable independent units under the same measurement conditions.",
      "The reported radius is applied to the calibration-fit mean curve; it does not include measurement noise beyond the observed residuals.",
    ],
  };
}

function averageRanks(values) {
  const ordered = values.map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = Array(values.length);
  let start = 0;
  while (start < ordered.length) {
    let end = start;
    while (end + 1 < ordered.length && ordered[end + 1].value === ordered[start].value) end += 1;
    const averageRank = ((start + 1) + (end + 1)) / 2;
    for (let index = start; index <= end; index += 1) ranks[ordered[index].index] = averageRank;
    start = end + 1;
  }
  return ranks;
}

function spearmanCorrelation(xValues, yValues) {
  const x = averageRanks(xValues);
  const y = averageRanks(yValues);
  const meanX = x.reduce((sum, value) => sum + value, 0) / x.length;
  const meanY = y.reduce((sum, value) => sum + value, 0) / y.length;
  let covariance = 0;
  let sumSquaresX = 0;
  let sumSquaresY = 0;
  for (let index = 0; index < x.length; index += 1) {
    const dx = x[index] - meanX;
    const dy = y[index] - meanY;
    covariance += dx * dy;
    sumSquaresX += dx * dx;
    sumSquaresY += dy * dy;
  }
  const denominator = Math.sqrt(sumSquaresX * sumSquaresY);
  return denominator > 0 ? Math.max(-1, Math.min(1, covariance / denominator)) : null;
}

/**
 * Screen exact residuals for monotonic time structure within each independent
 * trajectory. Censored observations are counted but never treated as exact
 * residuals. The screen is descriptive and does not report inferential p-values.
 */
export function summarizeTemporalResidualTrends({
  observations,
  predictions,
  minimumExactPointCount = 5,
  strongCorrelationThreshold = 0.7,
} = {}) {
  if (!Array.isArray(observations) || !Array.isArray(predictions) || observations.length !== predictions.length) {
    fail("TEMPORAL_RESIDUAL_VECTOR_LENGTH_MISMATCH", "observations and predictions must be aligned arrays.");
  }
  if (!Number.isInteger(minimumExactPointCount) || minimumExactPointCount < 3) {
    fail("INVALID_TEMPORAL_RESIDUAL_MINIMUM", "minimumExactPointCount must be an integer of at least three.");
  }
  if (typeof strongCorrelationThreshold !== "number" || !Number.isFinite(strongCorrelationThreshold)
    || strongCorrelationThreshold <= 0 || strongCorrelationThreshold > 1) {
    fail("INVALID_TEMPORAL_RESIDUAL_THRESHOLD", "strongCorrelationThreshold must be greater than zero and at most one.");
  }

  const groups = new Map();
  observations.forEach((observation, index) => {
    if (!observation || typeof observation !== "object" || Array.isArray(observation)) {
      fail("INVALID_TEMPORAL_RESIDUAL_OBSERVATION", `observations[${index}] must be an object.`);
    }
    const independentUnitId = observation.independentUnitId;
    if (typeof independentUnitId !== "string" || independentUnitId.trim() === "") {
      fail("INVALID_TEMPORAL_RESIDUAL_UNIT", `observations[${index}].independentUnitId must be a non-empty string.`);
    }
    const timeHours = finite(observation.timeHours, `observations[${index}].timeHours`);
    const value = finite(observation.value, `observations[${index}].value`);
    const prediction = finite(predictions[index], `predictions[${index}]`);
    const censoring = observation.censoring ?? "none";
    if (censoring !== "none" && censoring !== "left") {
      fail("UNSUPPORTED_TEMPORAL_RESIDUAL_CENSORING", `observations[${index}] supports only exact or left censoring.`);
    }
    if (!groups.has(independentUnitId)) {
      groups.set(independentUnitId, { independentUnitId, exact: [], leftCensoredObservationCount: 0 });
    }
    const group = groups.get(independentUnitId);
    if (censoring === "left") group.leftCensoredObservationCount += 1;
    else group.exact.push({ timeHours, residual: value - prediction });
  });

  const trajectories = [...groups.values()].sort((left, right) => (
    left.independentUnitId < right.independentUnitId ? -1 : left.independentUnitId > right.independentUnitId ? 1 : 0
  )).map((group) => {
    const exactObservationCount = group.exact.length;
    let status = "evaluated";
    let spearmanRho = null;
    if (exactObservationCount < minimumExactPointCount) {
      status = "insufficient_exact_points";
    } else {
      spearmanRho = spearmanCorrelation(
        group.exact.map(({ timeHours }) => timeHours),
        group.exact.map(({ residual }) => residual),
      );
      if (spearmanRho === null) status = "undefined_correlation";
    }
    return {
      independentUnitId: group.independentUnitId,
      exactObservationCount,
      leftCensoredObservationCount: group.leftCensoredObservationCount,
      status,
      spearmanRho,
      highMagnitudeTrend: spearmanRho !== null && Math.abs(spearmanRho) >= strongCorrelationThreshold,
    };
  });
  const evaluatedTrajectoryCount = trajectories.filter(({ status }) => status === "evaluated").length;
  const insufficientExactPointTrajectoryCount = trajectories.filter(({ status }) => status === "insufficient_exact_points").length;
  const undefinedCorrelationTrajectoryCount = trajectories.filter(({ status }) => status === "undefined_correlation").length;
  const highMagnitudeTrendTrajectoryCount = trajectories.filter(({ highMagnitudeTrend }) => highMagnitudeTrend).length;
  return {
    method: "descriptive_spearman_time_residual_by_independent_unit",
    residualDefinition: "observed_minus_predicted_log10_cfu_per_ml",
    minimumExactPointCount,
    strongCorrelationThreshold,
    trajectoryCount: trajectories.length,
    evaluatedTrajectoryCount,
    insufficientExactPointTrajectoryCount,
    undefinedCorrelationTrajectoryCount,
    highMagnitudeTrendTrajectoryCount,
    interpretation: "Residuals are observed minus predicted log10 CFU/mL. Left-censored observations are counted and excluded from correlations. Absolute Spearman rho at or above the threshold is a descriptive review signal; no p-values are reported because time points within a trajectory are dependent.",
    trajectories,
  };
}
