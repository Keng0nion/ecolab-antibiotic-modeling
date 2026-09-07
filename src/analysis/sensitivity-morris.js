import {
  applyParameterOverrides,
  fromTransformedValue,
  transformedBounds,
  validateParameterSpace,
} from "./parameter-space.js";
import { createSubstream, normalizeSeed, RNG_ALGORITHM } from "./random.js";

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
    fail("INVALID_MORRIS_OPTIONS", `${path} must be a plain object.`, path);
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
    if (outputNames.length !== values.length) fail("INVALID_OUTPUT_NAMES", "outputNames length mismatch.");
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

function shuffle(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random.next() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function evaluate(evaluator, transformed, definitions, options, space, context, outputNames) {
  const parameters = {};
  definitions.forEach((definition, index) => {
    parameters[definition.name] = fromTransformedValue(transformed[index], definition);
  });
  const frozenParameters = freeze(parameters);
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
    fail("ASYNC_EVALUATOR_NOT_SUPPORTED", "Morris sensitivity requires a synchronous evaluator.");
  }
  return outputVector(raw, outputNames);
}

function summarize(values) {
  const count = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / count;
  const meanAbsolute = values.reduce((sum, value) => sum + Math.abs(value), 0) / count;
  let squared = 0;
  for (const value of values) squared += (value - mean) ** 2;
  return {
    count,
    mu: mean,
    muStar: meanAbsolute,
    "μ": mean,
    "μ*": meanAbsolute,
    sigma: count > 1 ? Math.sqrt(squared / (count - 1)) : null,
    "σ": count > 1 ? Math.sqrt(squared / (count - 1)) : null,
    sigmaEstimable: count > 1,
  };
}

/** Morris effects per unit-cube coordinate, after the declared parameter transform. */
export function morrisSensitivity(options) {
  plainObject(options, "options");
  const evaluator = options.evaluator ?? options.evaluate;
  if (typeof evaluator !== "function") fail("EVALUATOR_REQUIRED", "A pure evaluator callback is required.");
  const space = validateParameterSpace(
    options.parameterSpace ?? {
      parameters: options.parameters,
      initialStateSeriesIds: options.initialStateSeriesIds ?? options.declaredInitialStates,
      drugIds: options.drugIds,
    },
  );
  const definitions = space.parameters;
  const dimension = definitions.length;
  const trajectories = options.trajectories ?? options.trajectoryCount ?? options.r ?? 20;
  if (!Number.isSafeInteger(trajectories) || trajectories <= 0) {
    fail("INVALID_TRAJECTORY_COUNT", "trajectories must be a positive safe integer.");
  }
  const levels = options.levels ?? options.gridLevels ?? 4;
  if (!Number.isSafeInteger(levels) || levels < 2) fail("INVALID_GRID_LEVELS", "levels must be an integer >= 2.");
  const deltaFraction = options.delta ?? (levels % 2 === 0 ? levels / (2 * (levels - 1)) : 1 / (levels - 1));
  if (typeof deltaFraction !== "number" || !Number.isFinite(deltaFraction) || deltaFraction <= 0 || deltaFraction > 1) {
    fail("INVALID_MORRIS_DELTA", "delta must be within (0, 1].");
  }
  const gridSteps = Math.round(deltaFraction * (levels - 1));
  const gridTolerance = 8 * Number.EPSILON * Math.max(1, gridSteps);
  if (gridSteps < 1 || Math.abs(deltaFraction * (levels - 1) - gridSteps) > gridTolerance) {
    fail("INVALID_MORRIS_DELTA", "delta * (levels - 1) must be an integer for a grid-compatible trajectory.");
  }
  const seed = normalizeSeed(options.seed ?? 0);
  const transformed = definitions.map(transformedBounds);
  const effects = Object.fromEntries(
    definitions.map((definition) => [definition.name, {}]),
  );
  let outputNames = options.outputNames ? [...options.outputNames] : null;
  let evaluationCount = 0;

  for (let trajectory = 0; trajectory < trajectories; trajectory += 1) {
    const random = createSubstream(seed, "morris", trajectory);
    const order = shuffle([...Array(dimension).keys()], random);
    const current = transformed.map(([lower, upper]) => {
      const span = upper - lower;
      const gridMaximumIndex = levels - 1 - gridSteps;
      const gridIndex = Math.floor(random.next() * (gridMaximumIndex + 1));
      return lower + (gridIndex / (levels - 1)) * span;
    });
    const directions = transformed.map(() => (random.next() < 0.5 ? -1 : 1));
    for (let index = 0; index < dimension; index += 1) {
      const [lower, upper] = transformed[index];
      const step = deltaFraction * (upper - lower);
      if (directions[index] < 0) current[index] = upper - (current[index] - lower);
      if (current[index] + directions[index] * step < lower - 1e-12 || current[index] + directions[index] * step > upper + 1e-12) {
        directions[index] *= -1;
      }
    }

    let previous = evaluate(
      evaluator,
      current,
      definitions,
      options,
      space,
      { trajectory, step: 0 },
      outputNames,
    );
    evaluationCount += 1;
    if (outputNames === null) outputNames = [...previous.names];

    for (let stepIndex = 0; stepIndex < order.length; stepIndex += 1) {
      const parameterIndex = order[stepIndex];
      const definition = definitions[parameterIndex];
      const [lower, upper] = transformed[parameterIndex];
      const signedNormalizedStep = directions[parameterIndex] * deltaFraction;
      const signedStep = signedNormalizedStep * (upper - lower);
      const nextPoint = [...current];
      nextPoint[parameterIndex] += signedStep;
      const next = evaluate(
        evaluator,
        nextPoint,
        definitions,
        options,
        space,
        { trajectory, step: stepIndex + 1, parameter: definition.name },
        outputNames,
      );
      evaluationCount += 1;
      outputNames.forEach((outputName, outputIndex) => {
        if (!effects[definition.name][outputName]) effects[definition.name][outputName] = [];
        effects[definition.name][outputName].push(
          (next.values[outputIndex] - previous.values[outputIndex]) / signedNormalizedStep,
        );
      });
      current[parameterIndex] = nextPoint[parameterIndex];
      previous = next;
    }
  }

  const byParameter = {};
  for (const definition of definitions) {
    const outputs = {};
    for (const outputName of outputNames) {
      outputs[outputName] = freeze(summarize(effects[definition.name][outputName]));
    }
    byParameter[definition.name] = freeze({
      parameter: definition.name,
      transform: definition.transform,
      outputs: freeze(outputs),
      ...(outputNames.length === 1 ? outputs[outputNames[0]] : {}),
    });
  }

  return freeze({
    kind: "morris_elementary_effects",
    seed,
    randomAlgorithm: RNG_ALGORITHM,
    trajectories,
    levels,
    delta: deltaFraction,
    coordinate: "normalized_unit_cube",
    effectScale: "output_per_unit_normalized_coordinate",
    normalization: "Each declared transformed parameter bound span maps to [0, 1]; outputs are not standardized.",
    parameterSpace: space,
    outputNames,
    evaluationCount,
    byParameter,
    sensitivities: definitions.map((definition) => byParameter[definition.name]),
  });
}

export const runMorrisSensitivity = morrisSensitivity;
export const analyzeMorrisSensitivity = morrisSensitivity;
