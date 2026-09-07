function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function finite(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_NUMBER", `${name} must be a finite number.`);
  }
  return value;
}

function normalizeInputs(options) {
  if (!options || typeof options !== "object") {
    fail("INVALID_OPTIONS", "analyzeIdentifiability requires an options object.");
  }
  const parameters = options.parameters ?? options.bestParameters ?? options.fittedParameters;
  if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) {
    fail("PARAMETERS_REQUIRED", "parameters must be an object.");
  }
  const names = options.parameterWhitelist ?? Object.keys(parameters);
  if (!Array.isArray(names) || names.length === 0) {
    fail("PARAMETERS_REQUIRED", "At least one parameter is required.");
  }
  const bounds = options.bounds;
  if (!bounds || typeof bounds !== "object") {
    fail("BOUNDS_REQUIRED", "Explicit bounds are required for normalized diagnostics.");
  }
  const normalizedBounds = {};
  const normalizedParameters = { ...parameters };
  for (const name of names) {
    finite(parameters[name], `parameters.${name}`);
    const bound = bounds[name];
    const lower = Array.isArray(bound) ? bound[0] : bound?.lower ?? bound?.min;
    const upper = Array.isArray(bound) ? bound[1] : bound?.upper ?? bound?.max;
    if (
      typeof lower !== "number" ||
      !Number.isFinite(lower) ||
      typeof upper !== "number" ||
      !Number.isFinite(upper) ||
      lower >= upper
    ) {
      fail("INVALID_BOUNDS", `bounds.${name} must specify finite lower < upper.`);
    }
    if (parameters[name] < lower || parameters[name] > upper) {
      fail("PARAMETER_OUT_OF_BOUNDS", `parameters.${name} is outside its bounds.`);
    }
    normalizedBounds[name] = [lower, upper];
    normalizedParameters[name] = parameters[name];
  }
  return { names: [...names], bounds: normalizedBounds, parameters: normalizedParameters };
}

function vectorEvaluator(options) {
  if (typeof options.evaluator === "function") {
    return (parameters) => options.evaluator(parameters, options.observations);
  }
  if (typeof options.predictor === "function" && Array.isArray(options.observations)) {
    return (parameters) =>
      options.observations.map((observation, index) =>
        options.predictor(parameters, observation, index),
      );
  }
  if (typeof options.residualEvaluator === "function") {
    return (parameters) => options.residualEvaluator(parameters);
  }
  fail("EVALUATOR_REQUIRED", "An evaluator, predictor plus observations, or residualEvaluator is required.");
}

function numericVector(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("INVALID_EVALUATOR_RESULT", `${path} must be a non-empty numeric array.`);
  }
  return value.map((item, index) => {
    if (typeof item === "number") return finite(item, `${path}[${index}]`);
    if (item && typeof item === "object") {
      return finite(
        item.residual ??
          item.predicted ??
          item.value ??
          item.mean ??
          item.predictedValue,
        `${path}[${index}]`,
      );
    }
    fail("INVALID_EVALUATOR_RESULT", `${path}[${index}] must be numeric.`);
  });
}

function cloneParameters(parameters) {
  return { ...parameters };
}

export function numericalJacobian(options) {
  const { names, bounds, parameters } = normalizeInputs(options);
  const evaluate = vectorEvaluator(options);
  const baseline = numericVector(evaluate(cloneParameters(parameters)), "baseline evaluation");
  const relativeStep = options.relativeStep ?? options.finiteDifferenceRelativeStep ?? 1e-4;
  if (typeof relativeStep !== "number" || !Number.isFinite(relativeStep) || relativeStep <= 0 || relativeStep >= 0.5) {
    fail("INVALID_STEP", "finite-difference relativeStep must be in (0, 0.5)." );
  }
  let outputScales;
  if (options.outputScales !== undefined) {
    if (!Array.isArray(options.outputScales) || options.outputScales.length !== baseline.length) {
      fail("INVALID_OUTPUT_SCALES", "outputScales must match evaluator output length.");
    }
    outputScales = options.outputScales.map((value, index) => {
      finite(value, `outputScales[${index}]`);
      if (value <= 0) fail("INVALID_OUTPUT_SCALES", "output scales must be positive.");
      return value;
    });
  } else {
    outputScales = baseline.map((value) => Math.max(1, Math.abs(value)));
  }

  const raw = Array.from({ length: baseline.length }, () => Array(names.length).fill(0));
  const normalized = Array.from({ length: baseline.length }, () => Array(names.length).fill(0));
  const schemes = [];
  let evaluationCount = 1;

  names.forEach((name, column) => {
    const [lower, upper] = bounds[name];
    const span = upper - lower;
    const step = relativeStep * span;
    const current = parameters[name];
    const canGoLower = current - step >= lower;
    const canGoUpper = current + step <= upper;
    let lowerValue = current;
    let upperValue = current;
    let lowerOutput = baseline;
    let upperOutput = baseline;
    let scheme;

    if (canGoLower && canGoUpper) {
      lowerValue = current - step;
      upperValue = current + step;
      const lowerParameters = cloneParameters(parameters);
      const upperParameters = cloneParameters(parameters);
      lowerParameters[name] = lowerValue;
      upperParameters[name] = upperValue;
      lowerOutput = numericVector(evaluate(lowerParameters), `${name} lower evaluation`);
      upperOutput = numericVector(evaluate(upperParameters), `${name} upper evaluation`);
      evaluationCount += 2;
      scheme = "central";
    } else if (canGoUpper || current === lower) {
      upperValue = Math.min(upper, current + step);
      const upperParameters = cloneParameters(parameters);
      upperParameters[name] = upperValue;
      upperOutput = numericVector(evaluate(upperParameters), `${name} upper evaluation`);
      evaluationCount += 1;
      scheme = "forward";
    } else {
      lowerValue = Math.max(lower, current - step);
      const lowerParameters = cloneParameters(parameters);
      lowerParameters[name] = lowerValue;
      lowerOutput = numericVector(evaluate(lowerParameters), `${name} lower evaluation`);
      evaluationCount += 1;
      scheme = "backward";
    }
    if (lowerOutput.length !== baseline.length || upperOutput.length !== baseline.length) {
      fail("EVALUATOR_LENGTH_CHANGED", "Evaluator output length changed during finite differences.");
    }
    const denominator = upperValue - lowerValue;
    for (let row = 0; row < baseline.length; row += 1) {
      const derivative = (upperOutput[row] - lowerOutput[row]) / denominator;
      raw[row][column] = derivative;
      normalized[row][column] = (derivative * span) / outputScales[row];
    }
    schemes.push({ parameter: name, scheme, step: denominator, normalizedStep: denominator / span });
  });

  return {
    parameterNames: names,
    baseline,
    outputScales,
    raw,
    normalized,
    schemes,
    evaluationCount,
    normalization:
      "Columns use full parameter-bound spans; rows use supplied outputScales or max(1, abs(baseline output)).",
  };
}

export function transposeMultiply(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0 || !Array.isArray(matrix[0])) {
    fail("INVALID_MATRIX", "matrix must be a non-empty rectangular array.");
  }
  const columns = matrix[0].length;
  if (columns === 0 || matrix.some((row) => !Array.isArray(row) || row.length !== columns)) {
    fail("INVALID_MATRIX", "matrix must be rectangular with at least one column.");
  }
  const result = Array.from({ length: columns }, () => Array(columns).fill(0));
  for (let row = 0; row < matrix.length; row += 1) {
    for (let left = 0; left < columns; left += 1) {
      for (let right = left; right < columns; right += 1) {
        result[left][right] += matrix[row][left] * matrix[row][right];
      }
    }
  }
  for (let left = 0; left < columns; left += 1) {
    for (let right = 0; right < left; right += 1) result[left][right] = result[right][left];
  }
  return result;
}

function identity(size) {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

function symmetricEigen(matrix) {
  const size = matrix.length;
  const values = matrix.map((row) => [...row]);
  const vectors = identity(size);
  const maxIterations = Math.max(32, 100 * size * size);
  const tolerance = 1e-14;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    let p = 0;
    let q = size > 1 ? 1 : 0;
    let maximum = 0;
    for (let row = 0; row < size; row += 1) {
      for (let column = row + 1; column < size; column += 1) {
        const magnitude = Math.abs(values[row][column]);
        if (magnitude > maximum) {
          maximum = magnitude;
          p = row;
          q = column;
        }
      }
    }
    if (maximum <= tolerance || size === 1) break;
    const angle = 0.5 * Math.atan2(2 * values[p][q], values[q][q] - values[p][p]);
    const sine = Math.sin(angle);
    const cosine = Math.cos(angle);
    const app = values[p][p];
    const aqq = values[q][q];
    const apq = values[p][q];
    values[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    values[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    values[p][q] = 0;
    values[q][p] = 0;
    for (let index = 0; index < size; index += 1) {
      if (index !== p && index !== q) {
        const aip = values[index][p];
        const aiq = values[index][q];
        values[index][p] = cosine * aip - sine * aiq;
        values[p][index] = values[index][p];
        values[index][q] = sine * aip + cosine * aiq;
        values[q][index] = values[index][q];
      }
      const vip = vectors[index][p];
      const viq = vectors[index][q];
      vectors[index][p] = cosine * vip - sine * viq;
      vectors[index][q] = sine * vip + cosine * viq;
    }
  }
  const order = Array.from({ length: size }, (_, index) => index).sort(
    (a, b) => values[b][b] - values[a][a],
  );
  return {
    values: order.map((index) => Math.max(0, values[index][index])),
    vectors: vectors.map((row) => order.map((index) => row[index])),
  };
}

function pseudoInverseFromEigen(eigen, threshold) {
  const size = eigen.values.length;
  const inverse = Array.from({ length: size }, () => Array(size).fill(0));
  for (let component = 0; component < size; component += 1) {
    const value = eigen.values[component];
    if (value <= threshold) continue;
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        inverse[row][column] +=
          (eigen.vectors[row][component] * eigen.vectors[column][component]) / value;
      }
    }
  }
  return inverse;
}

function correlationsFromCovariance(covariance, names) {
  const matrix = covariance.map((row, left) =>
    row.map((value, right) => {
      const denominator = Math.sqrt(Math.max(0, covariance[left][left] * covariance[right][right]));
      if (left === right) return denominator > 0 ? 1 : 0;
      return denominator > 0 ? value / denominator : 0;
    }),
  );
  const pairs = [];
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      pairs.push({ parameters: [names[left], names[right]], correlation: matrix[left][right] });
    }
  }
  return { matrix, pairs };
}

function columnCollinearity(information, names) {
  const matrix = information.map((row, left) => row.map((value, right) => {
    const denominator = Math.sqrt(information[left][left] * information[right][right]);
    return denominator > 0 ? value / denominator : null;
  }));
  const pairs = [];
  for (let left = 0; left < names.length; left += 1) {
    for (let right = left + 1; right < names.length; right += 1) {
      pairs.push({ parameters: [names[left], names[right]], cosineSimilarity: matrix[left][right] });
    }
  }
  return { matrix, pairs, interpretation: "Cosines between normalized Jacobian columns, not parameter-estimate correlations." };
}

function boundaryHits(parameters, bounds, names, tolerance) {
  const hits = [];
  for (const name of names) {
    const [lower, upper] = bounds[name];
    const span = upper - lower;
    const lowerDistance = (parameters[name] - lower) / span;
    const upperDistance = (upper - parameters[name]) / span;
    if (lowerDistance <= tolerance) {
      hits.push({ parameter: name, side: "lower", value: parameters[name], bound: lower, normalizedDistance: lowerDistance });
    }
    if (upperDistance <= tolerance) {
      hits.push({ parameter: name, side: "upper", value: parameters[name], bound: upper, normalizedDistance: upperDistance });
    }
  }
  return hits;
}

function collectOptima(options) {
  const supplied = options.optima ?? options.nearOptima;
  if (Array.isArray(supplied)) return supplied;
  const optimization = options.optimization;
  if (!optimization || typeof optimization !== "object") return [];
  if (Array.isArray(optimization.restarts)) {
    return optimization.restarts.map((restart) => ({
      parameters: restart.bestParameters,
      objectiveValue: restart.bestValue,
      seed: restart.seed,
      restart: restart.restart,
    }));
  }
  if (optimization.bestParameters) {
    return [{ parameters: optimization.bestParameters, objectiveValue: optimization.bestValue }];
  }
  return [];
}

function analyzeNearOptima(options, names, bounds) {
  const optima = collectOptima(options)
    .map((item) => ({
      parameters: item.parameters ?? item.bestParameters,
      objectiveValue: item.objectiveValue ?? item.bestValue,
      seed: item.seed,
      restart: item.restart,
    }))
    .filter(
      (item) =>
        item.parameters &&
        names.every((name) => typeof item.parameters[name] === "number") &&
        typeof item.objectiveValue === "number" &&
        Number.isFinite(item.objectiveValue),
    );
  if (optima.length === 0) return { bestValue: null, tolerance: null, optima: [], distinctCount: 0 };
  const bestValue = Math.min(...optima.map((item) => item.objectiveValue));
  const relativeTolerance = options.nearOptimumRelativeTolerance ?? 1e-4;
  const absoluteTolerance = options.nearOptimumAbsoluteTolerance ?? 1e-8;
  const tolerance = Math.max(absoluteTolerance, relativeTolerance * Math.max(1, Math.abs(bestValue)));
  const near = optima.filter((item) => item.objectiveValue <= bestValue + tolerance);
  const separation = options.nearOptimumParameterSeparation ?? 1e-3;
  const representatives = [];
  for (const item of near) {
    const distinct = representatives.every((other) => {
      let maximum = 0;
      for (const name of names) {
        const span = bounds[name][1] - bounds[name][0];
        maximum = Math.max(maximum, Math.abs(item.parameters[name] - other.parameters[name]) / span);
      }
      return maximum > separation;
    });
    if (distinct) representatives.push(item);
  }
  return { bestValue, tolerance, optima: near, distinctCount: representatives.length };
}

function objectiveSliceScans(options, names, bounds, parameters) {
  const supplied = options.objectiveSlices ?? options.profiles;
  if (supplied === undefined || supplied === null || supplied === false) return [];
  if (typeof options.objective !== "function") {
    fail("SLICE_OBJECTIVE_REQUIRED", "Objective slices require an objective callback.");
  }
  const config = Array.isArray(supplied)
    ? { parameters: supplied }
    : supplied === true ? {} : supplied;
  if (!config || typeof config !== "object" || Object.getPrototypeOf(config) !== Object.prototype) {
    fail("INVALID_OBJECTIVE_SLICES", "objectiveSlices must be false, true, a parameter-name array, or a configuration object.");
  }
  const maximumRequested = config.maxParameters ?? options.maxSliceParameters ?? options.maxProfileParameters ?? 3;
  const pointsRequested = config.points ?? options.slicePoints ?? options.profilePoints ?? 9;
  if (!Number.isSafeInteger(maximumRequested) || maximumRequested < 1 || !Number.isSafeInteger(pointsRequested) || pointsRequested < 3) {
    fail("INVALID_OBJECTIVE_SLICES", "maxParameters must be a positive integer and points must be an integer >= 3.");
  }
  const requested = config.parameters ?? names;
  if (!Array.isArray(requested) || requested.length === 0 || requested.some((name) => !names.includes(name)) || new Set(requested).size !== requested.length) {
    fail("INVALID_OBJECTIVE_SLICES", "Slice parameters must be a non-empty list of distinct analyzed parameter names.");
  }
  const maximum = Math.min(5, maximumRequested);
  const points = Math.min(21, pointsRequested);
  const selected = requested.slice(0, maximum);
  const flatRelativeTolerance = config.flatRelativeTolerance ?? 1e-4;
  if (typeof flatRelativeTolerance !== "number" || !Number.isFinite(flatRelativeTolerance) || flatRelativeTolerance < 0) {
    fail("INVALID_OBJECTIVE_SLICES", "flatRelativeTolerance must be finite and non-negative.");
  }
  return selected.map((name) => {
    const [lower, upper] = bounds[name];
    const values = [];
    for (let index = 0; index < points; index += 1) {
      const parameterValue = lower + (index / (points - 1)) * (upper - lower);
      const candidate = cloneParameters(parameters);
      candidate[name] = parameterValue;
      try {
        const objectiveValue = options.objective(candidate);
        if (typeof objectiveValue === "number" && Number.isFinite(objectiveValue)) {
          values.push({ parameterValue, objectiveValue, status: "completed" });
        } else {
          values.push({ parameterValue, objectiveValue: null, status: "failed", reason: "non_finite_objective" });
        }
      } catch (error) {
        values.push({
          parameterValue, objectiveValue: null, status: "failed", reason: "objective_error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const finiteValues = values.filter((item) => item.status === "completed");
    const failedEvaluationCount = values.length - finiteValues.length;
    let minimumIndex = null;
    for (let index = 0; index < values.length; index += 1) {
      if (values[index].status !== "completed") continue;
      if (minimumIndex === null || values[index].objectiveValue < values[minimumIndex].objectiveValue) minimumIndex = index;
    }
    const minimum = minimumIndex === null ? null : values[minimumIndex].objectiveValue;
    const maximumValue = Math.max(...finiteValues.map((item) => item.objectiveValue));
    const flat = failedEvaluationCount > 0 || minimum === null
      ? null
      : maximumValue - minimum <= flatRelativeTolerance * Math.max(1, Math.abs(minimum));
    const minimumAtBoundary = minimumIndex === null ? null : minimumIndex === 0 || minimumIndex === values.length - 1;
    return {
      kind: "objective_slice",
      parameter: name,
      fixedParameters: Object.fromEntries(Object.entries(parameters).filter(([key]) => key !== name)),
      nuisanceParametersOptimized: false,
      values,
      status: finiteValues.length === 0 ? "failed" : failedEvaluationCount > 0 ? "partial" : "completed",
      failedEvaluationCount,
      flat,
      minimumIndex,
      minimumAtBoundary,
      // Compatibility only: "open" describes the sampled minimum, never an interval.
      open: minimumAtBoundary,
      deprecatedAliases: { open: "minimumAtBoundary" },
      confidenceInterval: null,
      interpretation: "One parameter is scanned with all other supplied parameters fixed. This is not a profile likelihood or confidence interval; scan endpoints are not confidence limits.",
    };
  });
}

export function analyzeIdentifiability(options) {
  const normalizedInputs = normalizeInputs(options);
  const { names, bounds, parameters } = normalizedInputs;
  const jacobian = numericalJacobian(options);
  const jtj = transposeMultiply(jacobian.normalized);
  const eigen = symmetricEigen(jtj);
  const singularValues = eigen.values.map(Math.sqrt);
  const largest = singularValues[0] ?? 0;
  const rankTolerance = options.rankTolerance ?? 1e-8;
  const threshold = largest * rankTolerance;
  const rank = singularValues.filter((value) => value > threshold).length;
  const conditionNumber =
    rank < names.length || rank === 0
      ? Infinity
      : largest / singularValues[rank - 1];
  const informationPseudoInverse = pseudoInverseFromEigen(eigen, threshold * threshold);
  const fullRank = rank === names.length;
  const correlations = fullRank
    ? correlationsFromCovariance(informationPseudoInverse, names)
    : { matrix: null, pairs: [] };
  const sensitivityCollinearity = columnCollinearity(jtj, names);
  const covarianceDiagnostics = {
    status: fullRank ? "unscaled_local_geometry" : "unavailable_rank_deficient",
    parameterUncertaintyEstimated: false,
    coordinate: "normalized_parameter_bound_spans",
    interpretation: "The pseudoinverse of the normalized JtJ is local geometry only, without a calibrated observation-noise model. Null-space zero entries do not imply zero uncertainty.",
  };
  const boundaryTolerance = options.boundaryTolerance ?? 0.01;
  const hits = boundaryHits(parameters, bounds, names, boundaryTolerance);
  const nearOptima = analyzeNearOptima(options, names, bounds);
  const objectiveSlices = objectiveSliceScans(options, names, bounds, parameters);
  const warnings = [];
  const conditionWarning = options.conditionWarning ?? 1e6;
  const correlationWarning = options.correlationWarning ?? 0.95;

  warnings.push({
    code: fullRank ? "UNSCALED_INFORMATION_NOT_PARAMETER_UNCERTAINTY" : "PARAMETER_COVARIANCE_UNAVAILABLE",
    message: fullRank
      ? "Inverse normalized information is unscaled local geometry, not calibrated parameter uncertainty."
      : "Rank deficiency prevents full parameter covariance and parameter-estimate correlations; the information pseudoinverse is diagnostic only.",
  });
  if (options.profiles !== undefined) {
    warnings.push({
      code: "DEPRECATED_PROFILES_ALIAS",
      message: "profiles is deprecated; use objectiveSlices. Nuisance parameters are not reoptimized.",
    });
  }
  if (objectiveSlices.length > 0) {
    warnings.push({
      code: "OBJECTIVE_SLICES_NOT_PROFILE_LIKELIHOOD",
      message: "Objective slices hold other supplied parameters fixed. Neither their endpoints nor their minima define likelihood confidence limits.",
    });
  }
  if (rank < names.length) {
    warnings.push({
      code: "RANK_DEFICIENT_JACOBIAN",
      message: `Normalized Jacobian rank ${rank} is below ${names.length}.`,
      rank,
      parameterCount: names.length,
    });
  }
  if (!Number.isFinite(conditionNumber) || conditionNumber >= conditionWarning) {
    warnings.push({
      code: "HIGH_CONDITION_NUMBER",
      message: `Normalized Jacobian condition number is ${String(conditionNumber)}.`,
      conditionNumber,
      threshold: conditionWarning,
    });
  }
  const correlationDiagnostics = fullRank
    ? correlations.pairs.map((pair) => ({ ...pair, source: "unscaled_inverse_information" }))
    : sensitivityCollinearity.pairs.map((pair) => ({
        parameters: pair.parameters,
        correlation: pair.cosineSimilarity,
        source: "normalized_jacobian_columns",
      }));
  for (const pair of correlationDiagnostics) {
    if (pair.correlation !== null && Math.abs(pair.correlation) >= correlationWarning) {
      warnings.push({
        code: "STRONG_PARAMETER_CORRELATION",
        message: fullRank
          ? `${pair.parameters.join(" and ")} have strong inverse-information geometry correlation ${pair.correlation}; this is not calibrated parameter uncertainty.`
          : `${pair.parameters.join(" and ")} have collinear normalized sensitivity columns (cosine ${pair.correlation}), not an estimable parameter correlation.`,
        ...pair,
        threshold: correlationWarning,
      });
    }
  }
  for (const hit of hits) {
    warnings.push({
      code: "PARAMETER_AT_BOUND",
      message: `${hit.parameter} is at or near its ${hit.side} bound.`,
      ...hit,
    });
  }
  if (nearOptima.distinctCount > 1) {
    warnings.push({
      code: "MULTIPLE_NEAR_OPTIMA",
      message: `${nearOptima.distinctCount} distinct near-optimal parameter sets were found.`,
      count: nearOptima.distinctCount,
      tolerance: nearOptima.tolerance,
    });
  }
  for (const slice of objectiveSlices) {
    if (slice.failedEvaluationCount > 0) {
      warnings.push({
        code: "OBJECTIVE_SLICE_EVALUATION_FAILED",
        message: `${slice.parameter} objective slice has ${slice.failedEvaluationCount} failed evaluations.`,
        parameter: slice.parameter,
        failedEvaluationCount: slice.failedEvaluationCount,
      });
    }
    if (slice.flat) {
      warnings.push({
        code: "FLAT_OBJECTIVE_SLICE",
        message: `${slice.parameter} has a flat objective slice with other parameters fixed.`,
        parameter: slice.parameter,
      });
    }
    if (slice.minimumAtBoundary) {
      warnings.push({
        code: "SLICE_MINIMUM_AT_BOUND",
        message: `${slice.parameter} objective slice has its sampled minimum at a bound; this is not a confidence limit.`,
        parameter: slice.parameter,
      });
    }
  }

  return {
    parameterNames: names,
    normalizedJacobian: jacobian.normalized,
    rawJacobian: jacobian.raw,
    jacobian,
    JtJ: jtj,
    singularValues,
    rank,
    conditionNumber,
    informationPseudoInverse,
    covarianceApproximation: fullRank ? informationPseudoInverse : null,
    covarianceDiagnostics,
    correlationMatrix: correlations.matrix,
    correlations: correlations.pairs,
    sensitivityCollinearity,
    boundaryHits: hits,
    nearOptima,
    objectiveSlices,
    profiles: objectiveSlices,
    deprecatedAliases: {
      profiles: "objectiveSlices",
      covarianceApproximation: "informationPseudoInverse (full rank only)",
    },
    warnings,
    evaluationCount:
      jacobian.evaluationCount + objectiveSlices.reduce((sum, slice) => sum + slice.values.length, 0),
  };
}

export const assessIdentifiability = analyzeIdentifiability;
export const computeNumericalJacobian = numericalJacobian;
