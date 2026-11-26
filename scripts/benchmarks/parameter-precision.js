import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelFromRegistries } from "../../src/model.js";
import { runEcolabStage4ResearchWorkflow } from "../../src/analysis/research-workflow.js";
import { sha256HexFallback } from "../../src/analysis/fingerprint.js";
import { assertKnownOptions, resolveFileOption, slashPath } from "../lib/release-utils.js";

const rootPath = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assertKnownOptions(args, ["--json-out"]);
const jsonPath = resolveFileOption(args, "--json-out", "data/derived/parameter-precision.json", rootPath);
const datasetPath = "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json";
const createdAt = "2026-11-26T00:00:00.000Z";
const seed = 1582041777;

const [datasetText, modelRegistry, parameterRegistry, sourceRegistry, packageJson] = await Promise.all([
  readFile(resolve(rootPath, datasetPath), "utf8"),
  readFile(resolve(rootPath, "data/registry/model-definitions.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "data/registry/parameter-sets.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "data/registry/sources.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "package.json"), "utf8").then(JSON.parse),
]);
const resolvedModel = resolveModelFromRegistries({
  modelRegistry, parameterRegistry, sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const contentHash = sha256HexFallback(datasetText);

const base = {
  datasetInput: datasetText,
  resolvedModel,
  applicationVersion: packageJson.version,
  runId: "parameter-precision-probe",
  createdAt,
  datasetVersion: "1.0.0",
  contentHash,
  seed,
  scanPointsPerAxis: 3,
  monteCarloSamples: 4,
  morrisTrajectories: 1,
  sobolSamples: 4,
  sobolBootstrapReplicates: 2,
  sobolBootstrapSeed: 7,
  sobolConfidenceLevel: 0.8,
  sobolPrecisionTolerance: 0.5,
  identifiabilityProfilePoints: 3,
  returnedMonteCarloSamples: 4,
};
const budgets = [
  ["small", { restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 80, nelderMeadMaxEvaluations: 80 }],
  ["standard", { restarts: 1, populationSize: 12, differentialEvolutionMaxEvaluations: 300, nelderMeadMaxEvaluations: 200 }],
  ["large", { restarts: 3, populationSize: 20, differentialEvolutionMaxEvaluations: 2000, nelderMeadMaxEvaluations: 2000 }],
];
const standardOptimizer = {
  restarts: 1, populationSize: 12, differentialEvolutionMaxEvaluations: 300, nelderMeadMaxEvaluations: 200,
};
const resolutionRuns = [
  ["grid-5", { optimizer: standardOptimizer, profileLikelihoodPoints: 5 }],
  ["grid-9", { optimizer: standardOptimizer, profileLikelihoodPoints: 9 }],
  ["grid-11", { optimizer: standardOptimizer, profileLikelihoodPoints: 11 }],
  ["grid-11-refined", { optimizer: standardOptimizer, profileLikelihoodPoints: 11, profileRootRefinement: true }],
  ["grid-11-refined-ar1", {
    optimizer: standardOptimizer,
    profileLikelihoodPoints: 11,
    profileRootRefinement: true,
    profileErrorModel: "both",
  }],
];

function intervalSummary(parameters, estimateOf) {
  return Object.fromEntries(Object.entries(parameters ?? {}).map(([parameter, entry]) => {
    const range = entry.profileCompatibleRange95 ?? {};
    const estimate = estimateOf(parameter);
    return [parameter, {
      status: entry.identifiability?.status ?? entry.status ?? null,
      lower: range.lower ?? null,
      upper: range.upper ?? null,
      relativeHalfWidth: range.lower != null && range.upper != null && Number.isFinite(estimate)
        ? (range.upper - range.lower) / (2 * Math.abs(estimate))
        : null,
    }];
  }));
}

function summarise(name, result) {
  const training = result.training;
  const diagnostics = training.fitDiagnostics;
  const identifiability = result.identifiability ?? diagnostics.identifiability;
  const profile = diagnostics.profileLikelihood;
  const estimateOf = (parameter) => training.fittedBiologicalParameters?.[parameter];
  return {
    name,
    status: training.status,
    converged: training.converged,
    evaluationCount: training.optimization?.evaluationCount ?? null,
    terminationReason: training.optimization?.terminationReason ?? null,
    estimates: {
      psiMaxLog10PerHour: training.fittedBiologicalParameters?.psiMaxLog10PerHour ?? null,
      initialLog10PopulationDensity: training.fittedBiologicalParameters?.["initialStates.pooled.log10PopulationDensity"] ?? null,
    },
    localGeometry: {
      rank: identifiability.rank,
      parameterCount: identifiability.parameterNames?.length ?? null,
      conditionNumber: identifiability.conditionNumber,
      correlation: identifiability.correlations?.[0]?.correlation ?? null,
    },
    profileStatus: profile.status,
    profileReason: profile.reason,
    profilePointCount: profile.pointCount,
    profileRefitEvaluationCount: profile.profileRefitEvaluationCount ?? null,
    rootRefinement: profile.rootRefinement ?? { enabled: false },
    profileIntervals95: intervalSummary(profile.parameters, estimateOf),
    ar1ProfileStatus: profile.ar1RandomIntercept?.status ?? null,
    ar1Intervals95: profile.ar1RandomIntercept
      ? intervalSummary(profile.ar1RandomIntercept.parameters, estimateOf)
      : null,
    residualDependence: profile.residualDependence ?? null,
  };
}

const runs = [];
for (const [name, optimizer] of budgets) {
  const result = await runEcolabStage4ResearchWorkflow({ ...base, optimizer });
  runs.push(summarise(name, result));
}

const resolution = [];
for (const [name, options] of resolutionRuns) {
  const result = await runEcolabStage4ResearchWorkflow({ ...base, ...options });
  resolution.push(summarise(name, result));
}

// Descriptive residual structure around the per-time training mean. This is the
// quantity used in the earlier report; the fitted-model dependence is read from
// the refined AR(1) run above.
const dataset = JSON.parse(datasetText);
const training = dataset.observations.filter(({ role }) => role === "training");
const byUnit = new Map();
for (const observation of training) {
  if (!byUnit.has(observation.independentUnitId)) byUnit.set(observation.independentUnitId, []);
  byUnit.get(observation.independentUnitId).push(observation);
}
const units = [...byUnit.keys()].sort();
const times = [...new Set(training.map(({ timeHours }) => timeHours))].sort((a, b) => a - b);
const meanAt = new Map(times.map((time) => [time, 0]));
for (const observation of training) meanAt.set(observation.timeHours, meanAt.get(observation.timeHours) + observation.value / units.length);
const residuals = new Map(units.map((unit) => [unit, []]));
for (const unit of units) {
  for (const observation of byUnit.get(unit).sort((a, b) => a.timeHours - b.timeHours)) {
    residuals.get(unit).push(observation.value - meanAt.get(observation.timeHours));
  }
}
let lagProduct = 0;
let sumSquares = 0;
for (const unit of units) {
  const series = residuals.get(unit);
  for (let index = 1; index < series.length; index += 1) lagProduct += series[index] * series[index - 1];
  for (const value of series) sumSquares += value * value;
}
const lagOne = lagProduct / sumSquares;
const curveMeans = units.map((unit) => residuals.get(unit).reduce((sum, value) => sum + value, 0) / residuals.get(unit).length);
const grandMean = curveMeans.reduce((sum, value) => sum + value, 0) / units.length;
const betweenVariance = curveMeans.reduce((sum, value) => sum + (value - grandMean) ** 2, 0) / (units.length - 1);
let withinVariance = 0;
let withinCount = 0;
for (const [index, unit] of units.entries()) {
  for (const value of residuals.get(unit)) { withinVariance += (value - curveMeans[index]) ** 2; withinCount += 1; }
}
withinVariance /= withinCount;
const designEffect = 1 + (times.length - 1) * lagOne;

const refinedAr1 = resolution.find(({ name }) => name === "grid-11-refined-ar1");
const report = {
  schemaVersion: "1.0.0",
  kind: "ecolab.parameter-precision",
  generatedFrom: { applicationVersion: packageJson.version, seed, createdAt },
  dataset: { path: datasetPath, normalizedJsonArtifactSha256: contentHash, trainingCurves: units.length, timePoints: times.length, trainingObservations: training.length },
  budgets: runs,
  profileResolution: resolution,
  residualStructure: {
    lagOneAutocorrelation: lagOne,
    betweenCurveSd: Math.sqrt(betweenVariance),
    withinCurveSd: Math.sqrt(withinVariance),
    betweenCurveIcc: betweenVariance / (betweenVariance + withinVariance),
    designEffect,
    effectiveSampleSize: training.length / designEffect,
  },
  fittedResidualDependence: refinedAr1?.residualDependence ?? null,
  interpretation: [
    "The small preset stops at its evaluation cap; the same fit converges at the standard and large budgets with identical estimates, so the status difference is a budget artefact, not a data limit.",
    "The five-point grid reports a narrower interval than the eleven-point grid, and both are narrower than the refined crossing: linear interpolation between distant grid points understates the profile width. Only the root-refined interval is reported as the IID profile interval.",
    "The IID profile still assumes independent homoscedastic Gaussian residuals. The random-intercept AR(1) block is a sensitivity interval anchored at the IID estimate with nuisance parameters reoptimized under least squares; it is not a joint AR(1) refit.",
    "Absolute CFU scale is not identified: K is fixed and only the product s/K enters the OD observation layer.",
  ],
};
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output: slashPath(relative(rootPath, jsonPath)),
  budgets: runs.map(({ name, status, converged, evaluationCount, profileStatus, profileIntervals95 }) => ({ name, status, converged, evaluationCount, profileStatus, profileIntervals95 })),
  profileResolution: resolution.map(({ name, profileStatus, profileIntervals95, ar1Intervals95, rootRefinement }) => ({ name, profileStatus, profileIntervals95, ar1Intervals95, rootRefinement })),
  residualStructure: report.residualStructure,
  fittedResidualDependence: report.fittedResidualDependence,
}, null, 2));
