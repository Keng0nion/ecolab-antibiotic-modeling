import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelFromRegistries } from "../../src/model.js";
import { runEcolabResearchWorkflow } from "../../src/analysis/research-upgrade.js";
import { researchPreset } from "../../src/app/research/state.js";
import { assertKnownOptions, resolveFileOption, sha256, slashPath } from "../lib/release-utils.js";
import { requiredCalibrationUnits, sampleStandardDeviation, simulateCoverage } from "./lib/prediction-coverage.js";

const rootPath = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assertKnownOptions(args, ["--replicates", "--json-out"]);
const optionValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
};
const replicates = Number(optionValue("--replicates") ?? 20_000);
if (!Number.isInteger(replicates) || replicates <= 0) throw new Error("--replicates must be a positive integer.");
const jsonPath = resolveFileOption(args, "--json-out", "data/derived/prediction-band-coverage.json", rootPath);

const datasetPath = "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json";
const checksumsPath = "data/datasets/figshare-bw25113-growth-v1/checksums.json";
const [datasetText, checksumsText, modelRegistry, parameterRegistry, sourceRegistry, packageJson] = await Promise.all([
  readFile(resolve(rootPath, datasetPath), "utf8"),
  readFile(resolve(rootPath, checksumsPath), "utf8"),
  readFile(resolve(rootPath, "data/registry/model-definitions.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "data/registry/parameter-sets.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "data/registry/sources.json"), "utf8").then(JSON.parse),
  readFile(resolve(rootPath, "package.json"), "utf8").then(JSON.parse),
]);
const checksums = JSON.parse(checksumsText);
const contentHash = sha256(datasetText);
if (contentHash !== checksums.normalizedDataSha256) {
  throw new Error("Bundled dataset bytes differ from the recorded checksums; audit the input first.");
}
const resolvedModel = resolveModelFromRegistries({
  modelRegistry, parameterRegistry, sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const preset = "small";
const seed = 123456789;
const result = await runEcolabResearchWorkflow({
  datasetInput: datasetText,
  resolvedModel,
  applicationVersion: packageJson.version,
  runId: "ecolab-prediction-band-coverage",
  createdAt: "2026-11-26T00:00:00.000Z",
  datasetVersion: checksums.datasetVersion,
  contentHash,
  seed,
  ...researchPreset(preset),
});
const trajectory = result.growthComparison.trajectoryPrediction;
const band = trajectory?.bands?.["0.8"];
if (!band || band.status !== "available" || !Number.isFinite(band.radius)) {
  throw new Error(`The 80% trajectory band is unavailable: ${band?.status ?? "missing"}.`);
}
const radius = band.radius;
const count = band.predictions.length;
const trainingSigma = trajectory.fit.trainingMetrics.pooledRmse;
const calibrationSigma = trajectory.calibration.evaluationMetrics.pooledRmse;
const betweenCurveSigma = sampleStandardDeviation(trajectory.fit.trainingMetrics.perUnit.map(({ meanResidual }) => meanResidual));
if (![trainingSigma, calibrationSigma, betweenCurveSigma].every((value) => Number.isFinite(value) && value > 0)) {
  throw new Error("Residual scale estimates must be finite and positive.");
}

const scenario = (name, description, options, scenarioSeed) => ({
  name,
  description,
  ...simulateCoverage({ count, radius, replicates, seed: scenarioSeed, ...options }),
});
const scenarios = [
  scenario("iid_training_sigma", "IID Gaussian residuals at the fit-split pooled RMSE.", { sigma: trainingSigma }, 101),
  scenario("iid_calibration_sigma", "IID Gaussian residuals at the calibration-split pooled RMSE.", { sigma: calibrationSigma }, 202),
  scenario("ar1_phi_0_8_calibration_sigma", "AR(1) within-trajectory residuals, phi=0.8, calibration-split sigma.", { sigma: calibrationSigma, phi: 0.8 }, 303),
  scenario("curve_offset_1x_plus_iid", "Observed between-curve offset sd plus IID fit-split residuals.", { sigma: trainingSigma, offsetSigma: betweenCurveSigma }, 404),
  scenario("curve_offset_2x_plus_iid", "Twice the observed between-curve offset sd plus IID fit-split residuals.", { sigma: trainingSigma, offsetSigma: 2 * betweenCurveSigma }, 505),
  scenario("curve_offset_4x_plus_iid", "Four times the observed between-curve offset sd plus IID fit-split residuals.", { sigma: trainingSigma, offsetSigma: 4 * betweenCurveSigma }, 606),
];

const calibrationUnits = {
  available: trajectory.calibration.calibrationUnitCount,
  required: Object.fromEntries([0.8, 0.9, 0.95].map((level) => [String(level), requiredCalibrationUnits(level)])),
};
const report = {
  schemaVersion: "1.0.0",
  kind: "ecolab.prediction-band-coverage",
  generatedFrom: { runId: "ecolab-prediction-band-coverage", createdAt: "2026-11-26T00:00:00.000Z" },
  applicationVersion: packageJson.version,
  analysisImplementationId: result.implementationId,
  dataset: {
    id: result.dataset.id,
    version: checksums.datasetVersion,
    normalizedJsonArtifactSha256: contentHash,
    path: datasetPath,
  },
  preset,
  rootSeed: seed,
  band: {
    level: band.intervalLevel,
    radius,
    predictionTimeCount: count,
    method: trajectory.method,
    model: trajectory.fit.model,
    calibrationUnitCount: trajectory.calibration.calibrationUnitCount,
  },
  residualScales: {
    trainingPooledRmse: trainingSigma,
    calibrationPooledRmse: calibrationSigma,
    betweenCurveMeanResidualSd: betweenCurveSigma,
  },
  calibrationUnits,
  scenarios,
  interpretation: [
    "Coverage here is a parametric self-consistency check: future trajectories are simulated around the calibration-branch mean curve with the stated residual model, so it does not prove coverage for real future experiments.",
    "IID scenarios should approach the nominal 0.8 level; AR(1) and between-curve offsets violate the exchangeability assumptions and quantify how much coverage degrades.",
    "The band is simultaneous over the whole trajectory, so pointwise coverage is expected to be higher than trajectory coverage.",
  ],
};
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output: slashPath(relative(rootPath, jsonPath)),
  band: report.band,
  residualScales: report.residualScales,
  coverage: Object.fromEntries(scenarios.map(({ name, coverage, coverageInterval95 }) => [name, { coverage, interval95: coverageInterval95 }])),
}, null, 2));
