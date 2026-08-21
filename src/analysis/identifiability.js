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
  const normalizedParameters = {};
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

function profileScans(options, names, bounds, parameters) {
  if (!options.profiles) return [];
  if (typeof options.objective !== "function") {
    fail("PROFILE_OBJECTIVE_REQUIRED", "Profile scans require an objective callback.");
  }
  const config = Array.isArray(options.profiles)
    ? { parameters: options.profiles }
    : options.profiles === true
      ? {}
      : options.profiles;
  const maximum = Math.min(5, config.maxParameters ?? options.maxProfileParameters ?? 3);
  const selected = (config.parameters ?? names).filter((name) => names.includes(name)).slice(0, maximum);
  const points = Math.min(21, Math.max(3, config.points ?? options.profilePoints ?? 9));
  const flatRelativeTolerance = config.flatRelativeTolerance ?? 1e-4;
  return selected.map((name) => {
    const [lower, upper] = bounds[name];
    const values = [];
    for (let index = 0; index < points; index += 1) {
      const parameterValue = lower + (index / (points - 1)) * (upper - lower);
      const candidate = cloneParameters(parameters);
      candidate[name] = parameterValue;
      let objectiveValue;
      try {
        objectiveValue = options.objective(candidate);
      } catch {
        objectiveValue = Infinity;
      }
      values.push({ parameterValue, objectiveValue });
    }
    const finiteValues = values.filter((item) => Number.isFinite(item.objectiveValue));
    if (finiteValues.length === 0) {
      return { parameter: name, values, flat: false, open: true, minimumIndex: null };
    }
    let minimumIndex = 0;
    for (let index = 1; index < values.length; index += 1) {
      if (values[index].objectiveValue < values[minimumIndex].objectiveValue) minimumIndex = index;
    }
    const minimum = values[minimumIndex].objectiveValue;
    const maximumValue = Math.max(...finiteValues.map((item) => item.objectiveValue));
    const flat = maximumValue - minimum <= flatRelativeTolerance * Math.max(1, Math.abs(minimum));
    const open = minimumIndex === 0 || minimumIndex === values.length - 1;
    return { parameter: name, values, flat, open, minimumIndex };
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
  const covariance = pseudoInverseFromEigen(eigen, threshold * threshold);
  const correlations = correlationsFromCovariance(covariance, names);
  const boundaryTolerance = options.boundaryTolerance ?? 0.01;
  const hits = boundaryHits(parameters, bounds, names, boundaryTolerance);
  const nearOptima = analyzeNearOptima(options, names, bounds);
  const profiles = profileScans(options, names, bounds, parameters);
  const warnings = [];
  const conditionWarning = options.conditionWarning ?? 1e6;
  const correlationWarning = options.correlationWarning ?? 0.95;

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
  for (const pair of correlations.pairs) {
    if (Math.abs(pair.correlation) >= correlationWarning) {
      warnings.push({
        code: "STRONG_PARAMETER_CORRELATION",
        message: `${pair.parameters.join(" and ")} have correlation ${pair.correlation}.`,
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
  for (const profile of profiles) {
    if (profile.flat) {
      warnings.push({
        code: "FLAT_PROFILE",
        message: `${profile.parameter} has a flat limited profile.`,
        parameter: profile.parameter,
      });
    }
    if (profile.open) {
      warnings.push({
        code: "OPEN_PROFILE",
        message: `${profile.parameter} profile minimum is open at a scanned bound.`,
        parameter: profile.parameter,
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
    covarianceApproximation: covariance,
    correlationMatrix: correlations.matrix,
    correlations: correlations.pairs,
    boundaryHits: hits,
    nearOptima,
    profiles,
    warnings,
    evaluationCount:
      jacobian.evaluationCount + profiles.reduce((sum, profile) => sum + profile.values.length, 0),
  };
}

export const assessIdentifiability = analyzeIdentifiability;
export const computeNumericalJacobian = numericalJacobian;
