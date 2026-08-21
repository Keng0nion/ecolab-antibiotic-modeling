import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelFromRegistries } from "../src/model.js";
import { runEcolabStage4ResearchWorkflow } from "../src/analysis.js";
import { researchPreset } from "../src/app/research/state.js";
import { assertKnownOptions, resolveFileOption, slashPath } from "./lib/release-utils.js";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const args = process.argv.slice(2);
assertKnownOptions(args, ["--json-out", "--markdown-out"]);
const jsonPath = resolveFileOption(
  args,
  "--json-out",
  "data/examples/ecolab-stage5-small-research-5.0.0.json",
  rootPath,
);
const markdownPath = resolveFileOption(
  args,
  "--markdown-out",
  "data/examples/ecolab-stage5-small-research-5.0.0.md",
  rootPath,
);

async function readJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, rootUrl), "utf8"));
}

const [packageJson, datasetText, modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
  readJson("package.json"),
  readFile(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", rootUrl), "utf8"),
  readJson("data/registry/model-definitions.json"),
  readJson("data/registry/parameter-sets.json"),
  readJson("data/registry/sources.json"),
]);
const resolvedModel = resolveModelFromRegistries({
  modelRegistry,
  parameterRegistry,
  sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const result = await runEcolabStage4ResearchWorkflow({
  datasetInput: datasetText,
  resolvedModel,
  applicationVersion: packageJson.version,
  runId: "ecolab-stage5-small-research-5.0.0",
  createdAt: "2026-08-21T12:00:00.000Z",
  datasetVersion: "1.0.0",
  contentHash: "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817",
  seed: 123456789,
  ...researchPreset("small"),
});

const metrics = result.validation.metrics;
const baseline = metrics.baselineComparison;
const modelWorseThanBaseline = baseline.delta.macroRmse > 0 && baseline.delta.pooledRmse > 0;
if (result.capability.level !== "L3") throw new Error(`Expected L3, received ${result.capability.level}.`);
if (result.capability.heldOutValidationEligibleForL4 !== false) {
  throw new Error("The example must remain explicitly ineligible for L4 evidence.");
}
if (!modelWorseThanBaseline) {
  throw new Error("The bundled example no longer demonstrates validation worse than the predeclared baseline.");
}

const artifact = {
  schemaVersion: "1.0.0",
  kind: "ecolab-stage5-portfolio-research-example",
  artifactVersion: packageJson.version,
  generatedFrom: {
    applicationVersion: result.reproducibility.applicationVersion,
    scientificCoreVersion: result.manifest.versions.core,
    analysisEngineVersion: result.manifest.versions.analysis,
    model: {
      id: result.model.id,
      version: result.model.version,
      implementationId: result.model.implementationId,
    },
    dataset: {
      id: result.dataset.id,
      version: result.reproducibility.datasetVersion,
      normalizedJsonArtifactSha256: result.dataset.sourceContentHash,
      normalizedCanonicalFingerprint: result.dataset.normalizedDatasetFingerprint,
      observationCount: result.dataset.observationCount,
      trainingObservationCount: result.dataset.trainingObservationCount,
      validationObservationCount: result.dataset.validationObservationCount,
    },
    preset: "small",
    seed: result.seeds.analysis,
    runId: result.reproducibility.runId,
    createdAt: result.reproducibility.createdAt,
  },
  scientificScope: {
    measurement: result.dataset.sourceSemantics,
    latentModel: result.model.scientificCore,
    observationLayer: result.training.profiledObservationLayer.equation,
    treatmentOrAntibioticInference: result.model.treatmentOrAntibioticInference,
  },
  fittedParameters: {
    biological: result.training.fittedBiologicalParameters,
    observationLayer: {
      baselineOd: result.training.profiledObservationLayer.baselineOd,
      scaleOd: result.training.profiledObservationLayer.scaleOd,
    },
  },
  validation: {
    locked: result.lockedPlan.lockedValidation,
    untouched: result.validation.untouched,
    leakageFree: result.validation.leakageFree,
    optimizerUsed: result.validation.optimizerUsed,
    nuisanceParametersReprofiled: result.validation.nuisanceParametersReprofiled,
    validationEvaluatorCalls: result.validation.validationEvaluatorCalls,
    metrics: {
      macroRmse: metrics.macroRmse,
      pooledRmse: metrics.pooledRmse,
      mae: metrics.mae,
      meanResidual: metrics.meanResidual,
      medianAbsoluteError: metrics.medianAbsoluteError,
    },
    predeclaredBaseline: {
      id: baseline.baselineId,
      predeclared: baseline.predeclared,
      metrics: {
        macroRmse: baseline.baselineMetrics.macroRmse,
        pooledRmse: baseline.baselineMetrics.pooledRmse,
        mae: baseline.baselineMetrics.mae,
        medianAbsoluteError: baseline.baselineMetrics.medianAbsoluteError,
      },
    },
    modelWorseThanBaseline,
    deltaModelMinusBaseline: baseline.delta,
  },
  capability: {
    level: result.capability.level,
    independentUnitsDocumented: result.capability.independentUnitsDocumented,
    heldOutValidationPerformed: result.capability.heldOutValidationPerformed,
    heldOutValidationEligibleForL4: result.capability.heldOutValidationEligibleForL4,
    l4GatePassed: result.capability.gates.find(({ level }) => level === "L4")?.passed ?? false,
  },
  compute: {
    preset: "small",
    optimizer: {
      restarts: 1,
      populationSize: 8,
      differentialEvolutionMaxEvaluations: 80,
      nelderMeadMaxEvaluations: 80,
    },
    parameterScanCandidateCount: result.analyses.parameterScan.candidateCount,
    monteCarloSampleCount: result.analyses.monteCarlo.sampleCount,
    morrisTrajectoryCount: 2,
    sobolSampleCount: 8,
    identifiabilityProfilePoints: 3,
  },
  warnings: result.warnings,
  reproduction: {
    command: "npm run example:research",
    directCommand: "node scripts/generate-example-research.js",
  },
};

const jsonText = `${JSON.stringify(artifact, null, 2)}\n`;
const warningLines = artifact.warnings.map(({ code, message }) => `- \`${code}\`: ${message}`);
const markdown = `# Ecolab 5.0.0 small-preset research example\n\nThis versioned portfolio artifact was generated by running the bundled Figshare BW25113 raw OD600 dataset through the existing deterministic Research Workspace small preset. It is a calibration case study, not an antibiotic or clinical prediction claim.\n\n## Reproduce\n\n\`\`\`bash\n${artifact.reproduction.command}\n\`\`\`\n\n- Application: \`${artifact.generatedFrom.applicationVersion}\`\n- Scientific core engine: \`${artifact.generatedFrom.scientificCoreVersion}\` (unchanged in Stage 5)\n- Analysis engine: \`${artifact.generatedFrom.analysisEngineVersion}\` (unchanged in Stage 5)\n- Dataset: \`${artifact.generatedFrom.dataset.id}@${artifact.generatedFrom.dataset.version}\`\n- Preset: \`${artifact.generatedFrom.preset}\`; seed: \`${artifact.generatedFrom.seed}\`\n- Bundled normalized JSON artifact byte SHA-256: \`${artifact.generatedFrom.dataset.normalizedJsonArtifactSha256}\`
- Normalized canonical dataset fingerprint: \`${artifact.generatedFrom.dataset.normalizedCanonicalFingerprint}\`
- Original workbook SHA-256 values are separate provenance records in the dataset card and checksums file.\n\n## Scope and fitted values\n\n- Source semantics: ${artifact.scientificScope.measurement}.\n- Latent model: ${artifact.scientificScope.latentModel}.\n- Observation layer: \`${artifact.scientificScope.observationLayer}\`.\n- Treatment or antibiotic inference: **no**.\n- \`psiMaxLog10PerHour\`: \`${artifact.fittedParameters.biological.psiMaxLog10PerHour}\`.\n- \`initialStates.pooled.log10PopulationDensity\`: \`${artifact.fittedParameters.biological["initialStates.pooled.log10PopulationDensity"]}\`.\n- Profiled \`baselineOd\`: \`${artifact.fittedParameters.observationLayer.baselineOd}\`.\n- Profiled \`scaleOd\`: \`${artifact.fittedParameters.observationLayer.scaleOd}\`.\n\n## Locked validation result\n\n| Metric | Model | Predeclared training-mean baseline | Model minus baseline |\n| --- | ---: | ---: | ---: |\n| Macro RMSE | ${artifact.validation.metrics.macroRmse} | ${artifact.validation.predeclaredBaseline.metrics.macroRmse} | ${artifact.validation.deltaModelMinusBaseline.macroRmse} |\n| Pooled RMSE | ${artifact.validation.metrics.pooledRmse} | ${artifact.validation.predeclaredBaseline.metrics.pooledRmse} | ${artifact.validation.deltaModelMinusBaseline.pooledRmse} |\n| MAE | ${artifact.validation.metrics.mae} | ${artifact.validation.predeclaredBaseline.metrics.mae} | ${artifact.validation.deltaModelMinusBaseline.mae} |\n\nThe model is **worse than the predeclared baseline** on both macro and pooled RMSE. This negative validation result is retained rather than reframed as predictive success.\n\n## Capability boundary\n\n- Demonstrated capability: **${artifact.capability.level} — data calibration**.\n- Locked held-out procedure performed: **yes**.\n- L4 validation evidence eligible: **no**.\n- Reason: source plate/well independence is incompletely documented, so \`independentUnitsDocumented=false\` and the L4 gate fails.\n\n## Compute settings\n\n- Optimizer: ${artifact.compute.optimizer.restarts} restart, population ${artifact.compute.optimizer.populationSize}, ${artifact.compute.optimizer.differentialEvolutionMaxEvaluations} differential-evolution evaluations, ${artifact.compute.optimizer.nelderMeadMaxEvaluations} Nelder–Mead evaluations.\n- Parameter scan candidates: ${artifact.compute.parameterScanCandidateCount}.\n- Monte Carlo samples: ${artifact.compute.monteCarloSampleCount}.\n- Morris trajectories: ${artifact.compute.morrisTrajectoryCount}.\n- Sobol samples: ${artifact.compute.sobolSampleCount}.\n- Identifiability profile points: ${artifact.compute.identifiabilityProfilePoints}.\n\n## Warnings\n\n${warningLines.join("\n")}\n\nThe full machine-readable values are in [the companion JSON](./${jsonPath.split(/[\\/]/u).at(-1)}).\n`;

await Promise.all([
  mkdir(dirname(jsonPath), { recursive: true }),
  mkdir(dirname(markdownPath), { recursive: true }),
]);
await Promise.all([
  writeFile(jsonPath, jsonText),
  writeFile(markdownPath, markdown),
]);
console.log(`Generated ${slashPath(relative(rootPath, jsonPath))} and ${slashPath(relative(rootPath, markdownPath))}.`);
