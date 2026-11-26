import { createRandom } from "../../../src/analysis/random.js";

/** Standard normal draw from the project RNG (Box–Muller, open interval). */
export function gaussian(rng) {
  const u1 = rng.nextOpen();
  const u2 = rng.nextOpen();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** Stationary AR(1) residuals with unit-free correlation phi and marginal sd sigma. */
export function ar1Residuals(rng, count, sigma, phi) {
  if (!(sigma > 0)) throw new RangeError("sigma must be positive.");
  if (!(phi >= 0 && phi < 1)) throw new RangeError("phi must be in [0, 1).");
  const residuals = new Array(count);
  let previous = gaussian(rng) * sigma;
  residuals[0] = previous;
  const innovation = sigma * Math.sqrt(1 - phi * phi);
  for (let index = 1; index < count; index += 1) {
    previous = phi * previous + innovation * gaussian(rng);
    residuals[index] = previous;
  }
  return residuals;
}

/** Wilson score interval for a binomial proportion. */
export function wilsonInterval(successes, total, z = 1.959963984540054) {
  if (!Number.isInteger(total) || total <= 0) throw new RangeError("total must be a positive integer.");
  if (!Number.isInteger(successes) || successes < 0 || successes > total) throw new RangeError("successes must be within [0, total].");
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (p + (z * z) / (2 * total)) / denominator;
  const halfWidth = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator;
  return { lower: Math.max(0, centre - halfWidth), upper: Math.min(1, centre + halfWidth) };
}

/**
 * Smallest number of exchangeable calibration units whose conformal order statistic
 * can reach the requested level: need ceil((n + 1) * level) <= n.
 */
export function requiredCalibrationUnits(level) {
  if (!(level > 0 && level < 1)) throw new RangeError("level must be in (0, 1).");
  for (let units = 1; units <= 10_000; units += 1) {
    if (Math.ceil((units + 1) * level) <= units) return units;
  }
  return null;
}

/**
 * Simulate independent future trajectories around a fixed mean curve and measure how
 * often the simultaneous maximum-absolute-residual band contains the whole trajectory.
 * `offsetSigma` adds a per-trajectory constant shift (between-curve variability);
 * `phi` adds within-trajectory AR(1) correlation. Both violate the exchangeability
 * assumptions the conformal band relies on, so they quantify sensitivity, not truth.
 */
export function simulateCoverage({
  count,
  sigma,
  radius,
  replicates,
  seed,
  phi = 0,
  offsetSigma = 0,
}) {
  if (!Number.isInteger(count) || count <= 0) throw new RangeError("count must be a positive integer.");
  if (!(sigma > 0)) throw new RangeError("sigma must be positive.");
  if (!(radius >= 0)) throw new RangeError("radius must be non-negative.");
  if (!Number.isInteger(replicates) || replicates <= 0) throw new RangeError("replicates must be a positive integer.");
  if (!(offsetSigma >= 0)) throw new RangeError("offsetSigma must be non-negative.");
  const rng = createRandom(seed);
  let covered = 0;
  let pointCovered = 0;
  let pointCount = 0;
  let sumMaximum = 0;
  for (let replicate = 0; replicate < replicates; replicate += 1) {
    const offset = offsetSigma > 0 ? gaussian(rng) * offsetSigma : 0;
    const residuals = phi > 0
      ? ar1Residuals(rng, count, sigma, phi)
      : Array.from({ length: count }, () => gaussian(rng) * sigma);
    let maximum = 0;
    for (const residual of residuals) {
      const magnitude = Math.abs(offset + residual);
      if (magnitude <= radius) pointCovered += 1;
      if (magnitude > maximum) maximum = magnitude;
    }
    pointCount += count;
    sumMaximum += maximum;
    if (maximum <= radius) covered += 1;
  }
  return {
    replicates,
    covered,
    coverage: covered / replicates,
    coverageInterval95: wilsonInterval(covered, replicates),
    meanMaximumAbsoluteResidual: sumMaximum / replicates,
    pointCoverage: pointCovered / pointCount,
  };
}

/** Sample standard deviation (n − 1); returns null for fewer than two finite values. */
export function sampleStandardDeviation(values) {
  const finite = values.filter(Number.isFinite);
  if (finite.length < 2) return null;
  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(variance);
}
