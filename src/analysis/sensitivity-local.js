import {
  applyParameterOverrides,
  fromTransformedValue,
  getParameterValue,
  toTransformedValue,
  transformedBounds,
  validateParameterSpace,
} from "./parameter-space.js";

function fail(code, message, path = null) {
  const error = new TypeError(message);
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
    fail("INVALID_LOCAL_SENSITIVITY_OPTIONS", `${path} must be a plain object.`, path);
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

function normalizeSpace(options) {
  if (options.parameterSpace) return validateParameterSpace(options.parameterSpace);
  return validateParameterSpace({
    parameters: options.parameters,
    initialStateSeriesIds: options.initialStateSeriesIds ?? options.declaredInitialStates,
    drugIds: options.drugIds,
  });
}

function baselineValues(options, space) {
  const supplied = options.baseline ?? options.baseParameters ?? options.parameterValues;
  const result = {};
  for (const definition of space.parameters) {
    const value =
      supplied?.[definition.name] ??
      (options.resolvedModel
        ? getParameterValue(options.resolvedModel, definition.name, {
            initialStateSeriesIds: space.initialStateSeriesIds,
          })
        : undefined);
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("INVALID_BASELINE", `baseline.${definition.name} must be finite.`, definition.name);
    }
    if (value < definition.lower || value > definition.upper) {
      fail("BASELINE_OUT_OF_BOUNDS", `baseline.${definition.name} is outside its bounds.`, definition.name);
    }
    result[definition.name] = value;
  }
  return freeze(result);
}

function outputVector(value, names) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return { names: names ?? ["value"], values: [value] };
  }
  if (Array.isArray(value) && value.length > 0) {
    const values = value.map((child, index) => {
      if (typeof child !== "number" || !Number.isFinite(child)) {
        fail("INVALID_EVALUATOR_RESULT", `Evaluator output[${index}] must be finite.`);
      }
      return child;
    });
    const outputNames = names ?? values.map((_, index) => String(index));
    if (outputNames.length !== values.length) {
      fail("INVALID_OUTPUT_NAMES", "outputNames length must match evaluator output length.");
    }
    return { names: outputNames, values };
  }
  if (value && typeof value === "object") {
    const outputNames = names ?? Object.keys(value).sort();
    if (outputNames.length === 0) fail("INVALID_EVALUATOR_RESULT", "Evaluator output cannot be empty.");
    return {
      names: outputNames,
      values: outputNames.map((name) => {
        const child = value[name];
        if (typeof child !== "number" || !Number.isFinite(child)) {
          fail("INVALID_EVALUATOR_RESULT", `Evaluator output.${name} must be finite.`);
        }
        return child;
      }),
    };
  }
  fail("INVALID_EVALUATOR_RESULT", "Evaluator output must contain finite numeric values.");
}

function evaluate(evaluator, parameters, options, space, context, outputNames) {
  const frozenParameters = freeze({ ...parameters });
  const snapshot = options.resolvedModel
    ? applyParameterOverrides(options.resolvedModel, frozenParameters, {
        initialStateSeriesIds: space.initialStateSeriesIds,
      })
    : undefined;
  const raw = evaluator(
    frozenParameters,
    freeze({ ...context, ...(snapshot ? { resolvedModel: snapshot, snapshot } : {}) }),
  );
  if (raw && typeof raw.then === "function") {
    fail("ASYNC_EVALUATOR_NOT_SUPPORTED", "Local sensitivity requires a synchronous evaluator.");
  }
  return outputVector(raw, outputNames);
}

function chooseDifference(definition, baseline, options) {
  const rawMethod = options.scheme ?? options.method ?? "auto";
  const method = rawMethod === "one_sided" || rawMethod === "one-sided" ? "auto" : rawMethod;
  if (!["auto", "central", "forward", "backward"].includes(method)) {
    fail("INVALID_DIFFERENCE_SCHEME", "scheme must be auto, central, forward, or backward.");
  }
  const [lower, upper] = transformedBounds(definition);
  const center = toTransformedValue(baseline, definition);
  const span = upper - lower;
  const configured = options.steps?.[definition.name] ?? options.step;
  let step;
  if (configured === undefined) {
    step = Math.max(span * 1e-5, Math.sqrt(Number.EPSILON) * Math.max(1, Math.abs(center)));
  } else {
    if (typeof configured !== "number" || !Number.isFinite(configured) || configured <= 0) {
      fail("INVALID_DIFFERENCE_STEP", `Step for ${definition.name} must be positive and finite.`);
    }
    step = options.stepIsRelative === false ? configured : configured * span;
  }
  step = Math.min(step, span);
  const canBackward = center - step >= lower;
  const canForward = center + step <= upper;
  if (method === "central" && (!canBackward || !canForward)) {
    fail("CENTRAL_DIFFERENCE_OUT_OF_BOUNDS", `${definition.name} cannot use the requested central step.`);
  }
  if (method === "forward" && !canForward) {
    fail("FORWARD_DIFFERENCE_OUT_OF_BOUNDS", `${definition.name} cannot use the requested forward step.`);
  }
  if (method === "backward" && !canBackward) {
    fail("BACKWARD_DIFFERENCE_OUT_OF_BOUNDS", `${definition.name} cannot use the requested backward step.`);
  }
  let scheme = method;
  if (scheme === "auto") {
    if (canBackward && canForward) scheme = "central";
    else if (canForward) scheme = "forward";
    else if (canBackward) scheme = "backward";
    else fail("NO_FINITE_DIFFERENCE_STEP", `${definition.name} has no usable finite-difference step.`);
  }
  return { center, step, scheme };
}

/** Compute finite-difference derivatives with respect to transformed coordinates. */
export function localSensitivity(options) {
  plainObject(options, "options");
  const evaluator = options.evaluator ?? options.evaluate;
  if (typeof evaluator !== "function") fail("EVALUATOR_REQUIRED", "A pure evaluator callback is required.");
  const space = normalizeSpace(options);
  const baseline = baselineValues(options, space);
  const baselineOutput = evaluate(evaluator, baseline, options, space, { evaluation: "baseline" }, options.outputNames);
  const outputNames = [...baselineOutput.names];
  const entries = [];
  const byParameter = {};
  let evaluationCount = 1;

  for (const definition of space.parameters) {
    const difference = chooseDifference(definition, baseline[definition.name], options);
    let left;
    let right;
    let denominator;
    if (difference.scheme === "central" || difference.scheme === "backward") {
      const parameters = {
        ...baseline,
        [definition.name]: fromTransformedValue(difference.center - difference.step, definition),
      };
      left = evaluate(
        evaluator,
        parameters,
        options,
        space,
        { evaluation: "perturbation", parameter: definition.name, direction: "lower" },
        outputNames,
      );
      evaluationCount += 1;
    }
    if (difference.scheme === "central" || difference.scheme === "forward") {
      const parameters = {
        ...baseline,
        [definition.name]: fromTransformedValue(difference.center + difference.step, definition),
      };
      right = evaluate(
        evaluator,
        parameters,
        options,
        space,
        { evaluation: "perturbation", parameter: definition.name, direction: "upper" },
        outputNames,
      );
      evaluationCount += 1;
    }
    if (difference.scheme === "central") denominator = 2 * difference.step;
    else denominator = difference.step;

    const derivatives = {};
    outputNames.forEach((name, index) => {
      let numerator;
      if (difference.scheme === "central") numerator = right.values[index] - left.values[index];
      else if (difference.scheme === "forward") numerator = right.values[index] - baselineOutput.values[index];
      else numerator = baselineOutput.values[index] - left.values[index];
      derivatives[name] = numerator / denominator;
    });
    const entry = freeze({
      parameter: definition.name,
      transform: definition.transform,
      scheme: difference.scheme,
      transformedStep: difference.step,
      derivatives: freeze(derivatives),
      ...(outputNames.length === 1 ? { derivative: derivatives[outputNames[0]] } : {}),
    });
    entries.push(entry);
    byParameter[definition.name] = entry;
  }

  return freeze({
    kind: "local_sensitivity",
    coordinate: "declared_transformed_parameter_space",
    parameterSpace: space,
    baseline,
    outputNames,
    baselineOutput: freeze(Object.fromEntries(outputNames.map((name, index) => [name, baselineOutput.values[index]]))),
    evaluationCount,
    sensitivities: entries,
    byParameter,
  });
}

export const runLocalSensitivity = localSensitivity;
export const analyzeLocalSensitivity = localSensitivity;
