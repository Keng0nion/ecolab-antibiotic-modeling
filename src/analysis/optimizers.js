import { createRandom, deriveSeed, normalizeSeed, RNG_ALGORITHM } from "./random.js";

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}



function positiveInteger(value, fallback, name) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    fail("INVALID_OPTION", `${name} must be a positive integer.`);
  }
  return result;
}

function positiveNumber(value, fallback, name, { allowZero = false } = {}) {
  const result = value ?? fallback;
  if (
    typeof result !== "number" ||
    !Number.isFinite(result) ||
    (allowZero ? result < 0 : result <= 0)
  ) {
    fail("INVALID_OPTION", `${name} must be ${allowZero ? "non-negative" : "positive"}.`);
  }
  return result;
}

function normalizeBounds(bounds) {
  if (Array.isArray(bounds)) {
    if (bounds.length === 0) fail("INVALID_BOUNDS", "bounds cannot be empty.");
    return {
      names: null,
      pairs: bounds.map((bound, index) => normalizeBound(bound, `bounds[${index}]`)),
    };
  }
  if (!bounds || typeof bounds !== "object") {
    fail("INVALID_BOUNDS", "bounds must be an array or parameter-keyed object.");
  }
  const names = Object.keys(bounds);
  if (names.length === 0) fail("INVALID_BOUNDS", "bounds cannot be empty.");
  return {
    names,
    pairs: names.map((name) => normalizeBound(bounds[name], `bounds.${name}`)),
  };
}

function normalizeBound(bound, path) {
  const lower = Array.isArray(bound) ? bound[0] : bound?.lower ?? bound?.min;
  const upper = Array.isArray(bound) ? bound[1] : bound?.upper ?? bound?.max;
  if (
    typeof lower !== "number" ||
    !Number.isFinite(lower) ||
    typeof upper !== "number" ||
    !Number.isFinite(upper) ||
    lower >= upper
  ) {
    fail("INVALID_BOUNDS", `${path} must contain finite lower < upper bounds.`);
  }
  return [lower, upper];
}

function vectorFromCandidate(candidate, names, dimension, path = "candidate") {
  const vector = names ? names.map((name) => candidate?.[name]) : candidate;
  if (!Array.isArray(vector) || vector.length !== dimension) {
    fail("INVALID_CANDIDATE", `${path} must specify ${dimension} parameter values.`);
  }
  vector.forEach((value, index) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fail("INVALID_CANDIDATE", `${path}[${index}] must be finite.`);
    }
  });
  return [...vector];
}

function candidateFromVector(vector, names) {
  if (!names) return [...vector];
  return Object.fromEntries(names.map((name, index) => [name, vector[index]]));
}

function clampVector(vector, bounds) {
  return vector.map((value, index) =>
    Math.max(bounds[index][0], Math.min(bounds[index][1], value)),
  );
}

function randomVector(bounds, random) {
  return bounds.map(([lower, upper]) => lower + random.next() * (upper - lower));
}

function copyBounds(bounds, names) {
  if (!names) return bounds.map((pair) => [...pair]);
  return Object.fromEntries(names.map((name, index) => [name, [...bounds[index]]]));
}

function makeEvaluator(objective, names, budget, failedCandidates, context) {
  let evaluations = 0;
  let exhausted = false;
  return {
    evaluate(vector) {
      if (evaluations >= budget) {
        exhausted = true;
        return Infinity;
      }
      evaluations += 1;
      try {
        const value = objective(candidateFromVector(vector, names));
        if (typeof value !== "number" || !Number.isFinite(value)) {
          failedCandidates.push({
            ...context,
            vector: [...vector],
            reason: "non_finite_objective",
            value: typeof value === "number" ? String(value) : typeof value,
          });
          return Infinity;
        }
        return value;
      } catch (error) {
        failedCandidates.push({
          ...context,
          vector: [...vector],
          reason: "objective_error",
          message: error instanceof Error ? error.message : String(error),
        });
        return Infinity;
      }
    },
    get evaluations() {
      return evaluations;
    },
    get exhausted() {
      return exhausted || evaluations >= budget;
    },
    get remaining() {
      return Math.max(0, budget - evaluations);
    },
  };
}

function objectiveSpread(values) {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return minimum === Infinity ? Infinity : maximum - minimum;
}

function normalizedPopulationSpread(population, bounds) {
  let maximum = 0;
  for (let dimension = 0; dimension < bounds.length; dimension += 1) {
    let lower = Infinity;
    let upper = -Infinity;
    for (const vector of population) {
      lower = Math.min(lower, vector[dimension]);
      upper = Math.max(upper, vector[dimension]);
    }
    maximum = Math.max(maximum, (upper - lower) / (bounds[dimension][1] - bounds[dimension][0]));
  }
  return maximum;
}

function bestIndex(values) {
  let index = 0;
  for (let candidate = 1; candidate < values.length; candidate += 1) {
    if (values[candidate] < values[index]) index = candidate;
  }
  return index;
}

export function differentialEvolution(options) {
  if (!options || typeof options !== "object" || typeof options.objective !== "function") {
    fail("INVALID_OPTIONS", "differentialEvolution requires an objective callback.");
  }
  const normalizedBounds = normalizeBounds(options.bounds);
  const bounds = normalizedBounds.pairs;
  const names = normalizedBounds.names;
  const dimension = bounds.length;
  const populationSize = Math.max(4, positiveInteger(options.populationSize, Math.max(12, 8 * dimension), "populationSize"));
  const maxEvaluations = positiveInteger(options.maxEvaluations, 2000, "maxEvaluations");
  const mutationFactor = positiveNumber(options.mutationFactor, 0.8, "mutationFactor");
  const crossoverRate = positiveNumber(options.crossoverRate, 0.9, "crossoverRate", { allowZero: true });
  if (crossoverRate > 1) fail("INVALID_OPTION", "crossoverRate must be <= 1.");
  const tolerance = positiveNumber(options.tolerance, 1e-7, "tolerance");
  const objectiveTolerance = positiveNumber(options.objectiveTolerance, 1e-10, "objectiveTolerance", { allowZero: true });
  const seed = normalizeSeed(options.seed ?? 0);
  const random = createRandom(seed);
  const failedCandidates = [];
  const evaluator = makeEvaluator(options.objective, names, maxEvaluations, failedCandidates, {
    optimizer: "differential_evolution",
  });

  const population = [];
  if (options.start !== undefined) {
    population.push(clampVector(vectorFromCandidate(options.start, names, dimension, "start"), bounds));
  }
  if (options.initialPopulation !== undefined) {
    if (!Array.isArray(options.initialPopulation)) {
      fail("INVALID_CANDIDATE", "initialPopulation must be an array.");
    }
    for (const candidate of options.initialPopulation) {
      if (population.length >= populationSize) break;
      population.push(clampVector(vectorFromCandidate(candidate, names, dimension, "initialPopulation"), bounds));
    }
  }
  while (population.length < populationSize) population.push(randomVector(bounds, random));
  const starts = population.map((vector) => candidateFromVector(vector, names));
  const values = population.map((vector) => evaluator.evaluate(vector));

  let generation = 0;
  let converged = false;
  let terminationReason = "maximum_evaluations";
  while (!evaluator.exhausted) {
    const parameterSpread = normalizedPopulationSpread(population, bounds);
    const valueSpread = objectiveSpread(values);
    if (parameterSpread <= tolerance && valueSpread <= objectiveTolerance) {
      converged = true;
      terminationReason = "converged_spread";
      break;
    }

    let completedGeneration = true;
    for (let target = 0; target < populationSize; target += 1) {
      if (evaluator.remaining === 0) {
        completedGeneration = false;
        break;
      }
      const choices = [];
      while (choices.length < 3) {
        const index = Math.floor(random.next() * populationSize);
        if (index !== target && !choices.includes(index)) choices.push(index);
      }
      const forcedDimension = Math.floor(random.next() * dimension);
      const trial = population[target].map((current, coordinate) => {
        if (coordinate !== forcedDimension && random.next() > crossoverRate) return current;
        const proposed =
          population[choices[0]][coordinate] +
          mutationFactor *
            (population[choices[1]][coordinate] - population[choices[2]][coordinate]);
        return Math.max(bounds[coordinate][0], Math.min(bounds[coordinate][1], proposed));
      });
      const trialValue = evaluator.evaluate(trial);
      if (trialValue <= values[target]) {
        population[target] = trial;
        values[target] = trialValue;
      }
    }
    if (completedGeneration) generation += 1;
  }

  const winner = bestIndex(values);
  if (!Number.isFinite(values[winner])) {
    converged = false;
    terminationReason = evaluator.exhausted ? "maximum_evaluations" : "no_finite_candidate";
  } else if (!converged && evaluator.exhausted) {
    terminationReason = "maximum_evaluations";
  }

  return {
    optimizer: "differential_evolution",
    seed,
    bounds: copyBounds(bounds, names),
    starts,
    bestParameters: candidateFromVector(population[winner], names),
    bestValue: values[winner],
    evaluationCount: evaluator.evaluations,
    generations: generation,
    terminationReason,
    converged,
    failedCandidates,
  };
}

function simplexSpread(simplex, bounds) {
  return normalizedPopulationSpread(simplex, bounds);
}

export function nelderMead(options) {
  if (!options || typeof options !== "object" || typeof options.objective !== "function") {
    fail("INVALID_OPTIONS", "nelderMead requires an objective callback.");
  }
  const normalizedBounds = normalizeBounds(options.bounds);
  const bounds = normalizedBounds.pairs;
  const names = normalizedBounds.names;
  const dimension = bounds.length;
  const maxEvaluations = positiveInteger(options.maxEvaluations, 1000, "maxEvaluations");
  const tolerance = positiveNumber(options.tolerance, 1e-8, "tolerance");
  const objectiveTolerance = positiveNumber(options.objectiveTolerance, 1e-12, "objectiveTolerance", { allowZero: true });
  const seed = normalizeSeed(options.seed ?? 0);
  const random = createRandom(seed);
  const failedCandidates = [];
  const evaluator = makeEvaluator(options.objective, names, maxEvaluations, failedCandidates, {
    optimizer: "nelder_mead",
  });
  const start = options.start === undefined
    ? randomVector(bounds, random)
    : clampVector(vectorFromCandidate(options.start, names, dimension, "start"), bounds);
  const initialStep = positiveNumber(options.initialStep, 0.05, "initialStep");
  const simplex = [start];
  for (let coordinate = 0; coordinate < dimension; coordinate += 1) {
    const vertex = [...start];
    const width = bounds[coordinate][1] - bounds[coordinate][0];
    const upward = Math.min(bounds[coordinate][1], start[coordinate] + initialStep * width);
    vertex[coordinate] = upward !== start[coordinate]
      ? upward
      : Math.max(bounds[coordinate][0], start[coordinate] - initialStep * width);
    simplex.push(vertex);
  }
  const starts = simplex.map((vector) => candidateFromVector(vector, names));
  const values = simplex.map((vector) => evaluator.evaluate(vector));
  let iterations = 0;
  let converged = false;
  let terminationReason = "maximum_evaluations";

  const evaluate = (vector) => evaluator.evaluate(clampVector(vector, bounds));
  while (!evaluator.exhausted) {
    const order = simplex.map((_, index) => index).sort((a, b) => values[a] - values[b]);
    const orderedSimplex = order.map((index) => simplex[index]);
    const orderedValues = order.map((index) => values[index]);
    for (let index = 0; index < simplex.length; index += 1) {
      simplex[index] = orderedSimplex[index];
      values[index] = orderedValues[index];
    }
    if (
      simplexSpread(simplex, bounds) <= tolerance &&
      objectiveSpread(values) <= objectiveTolerance
    ) {
      converged = true;
      terminationReason = "converged_simplex";
      break;
    }

    const centroid = Array(dimension).fill(0);
    for (let vertex = 0; vertex < dimension; vertex += 1) {
      for (let coordinate = 0; coordinate < dimension; coordinate += 1) {
        centroid[coordinate] += simplex[vertex][coordinate] / dimension;
      }
    }
    const worst = simplex[dimension];
    const reflected = clampVector(
      centroid.map((value, coordinate) => value + (value - worst[coordinate])),
      bounds,
    );
    const reflectedValue = evaluate(reflected);
    if (evaluator.exhausted && !Number.isFinite(reflectedValue)) break;

    if (reflectedValue < values[0]) {
      if (evaluator.remaining === 0) break;
      const expanded = clampVector(
        centroid.map((value, coordinate) => value + 2 * (reflected[coordinate] - value)),
        bounds,
      );
      const expandedValue = evaluate(expanded);
      if (expandedValue < reflectedValue) {
        simplex[dimension] = expanded;
        values[dimension] = expandedValue;
      } else {
        simplex[dimension] = reflected;
        values[dimension] = reflectedValue;
      }
    } else if (reflectedValue < values[dimension - 1]) {
      simplex[dimension] = reflected;
      values[dimension] = reflectedValue;
    } else {
      if (evaluator.remaining === 0) break;
      const outside = reflectedValue < values[dimension];
      const contracted = clampVector(
        centroid.map((value, coordinate) =>
          outside
            ? value + 0.5 * (reflected[coordinate] - value)
            : value + 0.5 * (worst[coordinate] - value),
        ),
        bounds,
      );
      const contractedValue = evaluate(contracted);
      if (contractedValue < (outside ? reflectedValue : values[dimension])) {
        simplex[dimension] = contracted;
        values[dimension] = contractedValue;
      } else {
        for (let vertex = 1; vertex < simplex.length; vertex += 1) {
          if (evaluator.remaining === 0) break;
          simplex[vertex] = clampVector(
            simplex[0].map(
              (value, coordinate) =>
                value + 0.5 * (simplex[vertex][coordinate] - value),
            ),
            bounds,
          );
          values[vertex] = evaluate(simplex[vertex]);
        }
      }
    }
    iterations += 1;
  }

  const winner = bestIndex(values);
  if (!Number.isFinite(values[winner])) {
    converged = false;
    terminationReason = evaluator.exhausted ? "maximum_evaluations" : "no_finite_candidate";
  } else if (!converged && evaluator.exhausted) {
    terminationReason = "maximum_evaluations";
  }
  return {
    optimizer: "nelder_mead",
    seed,
    bounds: copyBounds(bounds, names),
    starts,
    bestParameters: candidateFromVector(simplex[winner], names),
    bestValue: values[winner],
    evaluationCount: evaluator.evaluations,
    iterations,
    terminationReason,
    converged,
    failedCandidates,
  };
}

export function optimizeBounded(options) {
  if (!options || typeof options !== "object" || typeof options.objective !== "function") {
    fail("INVALID_OPTIONS", "optimizeBounded requires an objective callback.");
  }
  const restarts = positiveInteger(options.restarts, 3, "restarts");
  const seed = normalizeSeed(options.seed ?? 0);
  const runs = [];
  let best = null;
  let evaluationCount = 0;

  for (let restart = 0; restart < restarts; restart += 1) {
    const restartSeed = deriveSeed(seed, restart, "bounded-de-nm-restart");
    const de = differentialEvolution({
      ...(options.differentialEvolution ?? {}),
      objective: options.objective,
      bounds: options.bounds,
      seed: deriveSeed(restartSeed, 0, "differential-evolution"),
      start: restart === 0 ? options.start : undefined,
    });
    const nm = nelderMead({
      ...(options.nelderMead ?? {}),
      objective: options.objective,
      bounds: options.bounds,
      seed: deriveSeed(restartSeed, 1, "nelder-mead"),
      start: de.bestParameters,
    });
    const chosen = nm.bestValue <= de.bestValue ? nm : de;
    const run = {
      restart,
      seed: restartSeed,
      bounds: de.bounds,
      starts: {
        differentialEvolution: de.starts,
        nelderMead: nm.starts,
      },
      differentialEvolution: de,
      nelderMead: nm,
      bestParameters: chosen.bestParameters,
      bestValue: chosen.bestValue,
      evaluationCount: de.evaluationCount + nm.evaluationCount,
      terminationReason: nm.terminationReason,
      converged: nm.converged,
      failedCandidates: [...de.failedCandidates, ...nm.failedCandidates],
    };
    runs.push(run);
    evaluationCount += run.evaluationCount;
    if (best === null || run.bestValue < best.bestValue) best = run;
  }

  return {
    optimizer: "bounded_differential_evolution_then_nelder_mead",
    randomAlgorithm: RNG_ALGORITHM,
    seed,
    bounds: best.bounds,
    starts: runs.map((run) => ({
      restart: run.restart,
      seed: run.seed,
      differentialEvolution: run.starts.differentialEvolution,
      nelderMead: run.starts.nelderMead,
    })),
    restarts: runs,
    bestParameters: best.bestParameters,
    bestValue: best.bestValue,
    evaluationCount,
    terminationReason: best.terminationReason,
    converged: best.converged,
    failedCandidates: runs.flatMap((run) => run.failedCandidates),
  };
}

export const boundedDifferentialEvolution = differentialEvolution;
export const boundedNelderMead = nelderMead;
export const optimizeWithRestarts = optimizeBounded;
export const differentialEvolutionThenNelderMead = optimizeBounded;
