import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveModelFromRegistries } from "../src/model.js";
import { runEcolabResearchWorkflow } from "../src/analysis/research-upgrade.js";
import { ANALYSIS_ENGINE_ID, ANALYSIS_IMPLEMENTATION_ID } from "../src/analysis/version.js";
import { researchPreset } from "../src/app/research/state.js";
import { assertKnownOptions, resolveFileOption, sha256, slashPath } from "./lib/release-utils.js";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const args = process.argv.slice(2);
assertKnownOptions(args, ["--json-out", "--markdown-out"]);
const seenOptions = new Set();
for (let index = 0; index < args.length; index += 1) {
  const argument = args[index];
  const name = argument.split("=", 1)[0];
  if (seenOptions.has(name)) throw new Error(`Duplicate option: ${name}`);
  seenOptions.add(name);
  const value = argument.includes("=") ? argument.slice(name.length + 1) : args[++index];
  if (!value?.trim() || value.startsWith("--")) throw new Error(`${name} requires a path.`);
}
const jsonPath = resolveFileOption(args, "--json-out", "data/examples/ecolab-stage6-research-6.0.0.json", rootPath);
const markdownPath = resolveFileOption(args, "--markdown-out", "data/examples/ecolab-stage6-research-6.0.0.md", rootPath);
const historicalPaths = [
  "data/examples/ecolab-stage5-small-research-5.0.0.json",
  "data/examples/ecolab-stage5-small-research-5.0.0.md",
];

async function canonicalPath(path) {
  try {
    return await realpath(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(await canonicalPath(parent), basename(path));
  }
}

async function destinationIdentity(path) {
  const canonical = await canonicalPath(path);
  let metadata = null;
  try {
    metadata = await stat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { canonical, metadata };
}

function sameDestination(left, right) {
  return left.canonical === right.canonical || Boolean(left.metadata && right.metadata
    && left.metadata.dev === right.metadata.dev && left.metadata.ino === right.metadata.ino);
}

async function assertSafeDestinations() {
  const historical = await Promise.all(historicalPaths.map((path) => destinationIdentity(resolve(rootPath, path))));
  const outputs = await Promise.all([jsonPath, markdownPath].map(destinationIdentity));
  for (const [index, output] of outputs.entries()) {
    if (historical.some((reserved) => sameDestination(output, reserved))) {
      throw new Error(`Refusing to overwrite a reserved historical artifact: ${[jsonPath, markdownPath][index]}`);
    }
    if (output.metadata && !output.metadata.isFile()) throw new Error("Output destinations must be files.");
  }
  if (sameDestination(...outputs)) throw new Error("--json-out and --markdown-out must be distinct files.");
}

// Resolve both destinations before computation or any write, including filesystem aliases.
await assertSafeDestinations();

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, rootUrl), "utf8"));
}

const datasetPath = "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json";
const checksumsPath = "data/datasets/figshare-bw25113-growth-v1/checksums.json";
const [packageJson, datasetText, checksumsText, modelRegistry, parameterRegistry, sourceRegistry, historicalBytes] = await Promise.all([
  readJson("package.json"),
  readFile(new URL(datasetPath, rootUrl), "utf8"),
  readFile(new URL(checksumsPath, rootUrl), "utf8"),
  readJson("data/registry/model-definitions.json"),
  readJson("data/registry/parameter-sets.json"),
  readJson("data/registry/sources.json"),
  Promise.all(historicalPaths.map((path) => readFile(new URL(path, rootUrl)))),
]);
const checksums = JSON.parse(checksumsText);
const contentHash = sha256(datasetText);
if (contentHash !== checksums.normalizedDataSha256) {
  throw new Error("Bundled normalized dataset bytes differ from the recorded checksums; audit the input before generating an example.");
}
const resolvedModel = resolveModelFromRegistries({
  modelRegistry, parameterRegistry, sourceRegistry,
  modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
  parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
});
const preset = "small";
const result = await runEcolabResearchWorkflow({
  datasetInput: datasetText,
  resolvedModel,
  applicationVersion: packageJson.version,
  runId: "ecolab-stage6-research-6.0.0",
  createdAt: "2026-09-07T12:00:00.000Z",
  datasetVersion: checksums.datasetVersion,
  contentHash,
  seed: 123456789,
  ...researchPreset(preset),
});
const researchPackage = result.researchPackage;
const replayOptions = researchPackage.contents.artifacts["research-replay-input"].options;
const scientificReference = researchPackage.artifactInventory.find(({ artifactId }) => artifactId === "scientific-result");
const growth = result.growthComparison;
const artifact = {
  schemaVersion: "1.0.0",
  kind: "ecolab-stage6-research-example",
  artifactVersion: packageJson.version,
  generatedFrom: {
    applicationVersion: replayOptions.applicationVersion,
    scientificCoreVersion: result.manifest.versions.core,
    analysisEngineVersion: result.manifest.versions.analysis,
    analysisEngineId: ANALYSIS_ENGINE_ID,
    analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID,
    workflowImplementationId: result.implementationId,
    model: { id: result.model.id, version: result.model.version, implementationId: result.model.implementationId },
    dataset: {
      id: result.dataset.id,
      version: replayOptions.datasetVersion,
      path: datasetPath,
      normalizedJsonArtifactSha256: contentHash,
      normalizedCanonicalFingerprint: result.dataset.normalizedDatasetFingerprint,
      observationCount: result.dataset.observationCount,
      trainingObservationCount: result.dataset.trainingObservationCount,
      developmentObservationCount: result.dataset.validationObservationCount,
      sourceEvaluationRole: growth.development.observationRoleUsed,
      evaluationRole: growth.development.role,
      previouslyViewed: growth.development.previouslyViewed,
    },
    preset,
    seed: replayOptions.seed,
    seeds: result.seeds,
    runId: replayOptions.runId,
    createdAt: replayOptions.createdAt,
  },
  sourceProvenance: {
    checksumsPath,
    checksumsSha256: sha256(checksumsText),
    source: checksums.source,
    workbookHashStatus: "Original workbook hashes are provenance declarations copied from checksums.json, not recomputed by this generator. Original XLSX bytes are not embedded or needed for replay of the normalized input.",
  },
  historicalArtifacts: historicalPaths.map((path, index) => ({
    path, artifactVersion: "5.0.0", sha256: sha256(historicalBytes[index]),
    status: "frozen_historical_record_not_regenerated",
  })),
  scientificResultRef: { artifactId: scientificReference.artifactId, sha256: scientificReference.sha256 },
  researchPackage,
  reproduction: {
    command: "npm run example:research",
    directCommand: "node scripts/generate-example-research.js",
    outputOptions: ["--json-out", "--markdown-out"],
    replayInputArtifactId: "research-replay-input",
    statement: "The researchPackage is data-self-contained, not a standalone executable: it embeds exact source text, resolved inputs, settings and scientific output, but replay requires the declared exact built-in software. No imported code or network fetch is used. Extract researchPackage for package inspection/replay; the example wrapper is not itself a research-package schema document.",
  },
};

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function companionLink(path) {
  return slashPath(relative(dirname(markdownPath), path)).split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
}

function metricLines(label, metrics) {
  if (!metrics) return `- ${label}: metrics unavailable; see retained diagnostics.`;
  return `- ${label}: ${["macroRmse", "pooledRmse", "mae"].map((name) => `${name}=\`${metrics[name]}\``).join("; ")}.`;
}

const sobol = result.analyses.sensitivity.sobolJansen;
const morris = result.analyses.sensitivity.morris;
const markdown = [
  `# Ecolab ${artifact.artifactVersion} development research example`,
  "Actual deterministic computation on bundled raw, unblanked BW25113 OD600 data. No preferred winner or direction of change is required to generate this artifact. Completion is not convergence, identification, precision, or validation success.",
  "## Reproduce and inspect",
  `\`\`\`bash\n${artifact.reproduction.command}\n# Optional output destinations (space-separated or equals form):\nnode scripts/generate-example-research.js --json-out /tmp/ecolab-example.json --markdown-out /tmp/ecolab-example.md\n\`\`\``,
  artifact.reproduction.statement,
  `- Application: \`${artifact.generatedFrom.applicationVersion}\`; analysis: \`${artifact.generatedFrom.analysisEngineVersion}\`; scientific core engine: \`${artifact.generatedFrom.scientificCoreVersion}\`; teaching model: \`${result.model.version}\`.`,
  `- Stable analysis ID: \`${ANALYSIS_ENGINE_ID}\`; analysis implementation: \`${ANALYSIS_IMPLEMENTATION_ID}\`; workflow: \`${result.implementationId}\`.`,
  `- Current Research Workspace preset: \`${preset}\`; root seed: \`${replayOptions.seed}\`. The fixed createdAt=\`${replayOptions.createdAt}\` is reproducibility metadata, not the wall-clock execution time.`,
  `- Scientific result: \`${scientificReference.artifactId}\`; canonical SHA-256: \`${scientificReference.sha256}\`.`,
  ...researchPackage.replay.dependencies.map(({ id, version, requirement, description }) => `- Software dependency: \`${id}@${version}\` (${requirement}). ${description}`),
  "## Source, roles and integrity",
  checksums.source.attribution,
  `- Data license: \`${checksums.source.license.id}\`.`,
  `- Dataset: \`${result.dataset.id}@${replayOptions.datasetVersion}\`; ${result.dataset.observationCount} observations (${result.dataset.trainingObservationCount} training, ${result.dataset.validationObservationCount} previously viewed development).`,
  `- Original source role \`${growth.development.observationRoleUsed}\` is labeled \`${growth.development.role}\` in this revision: not untouched or external validation. The original data and source labels are not rewritten.`,
  `- Bundled normalized JSON artifact byte SHA-256: \`${contentHash}\`.`,
  `- Normalized canonical dataset fingerprint: \`${result.dataset.normalizedDatasetFingerprint}\`.`,
  `- Checksums document byte SHA-256: \`${artifact.sourceProvenance.checksumsSha256}\`.`,
  artifact.sourceProvenance.workbookHashStatus,
  ...checksums.source.files.map(({ path, sha256: hash }) => `- Original workbook provenance: \`${path}\`, SHA-256 \`${hash}\`.`),
  "## Training-only cross-validation and frozen selection",
  `CV source role=\`${growth.crossValidation.sourceRole}\`; unit=\`${growth.crossValidation.unit}\`; metric=\`${growth.crossValidation.metric}\`. ${growth.crossValidation.aggregation}`,
  ...Object.entries(growth.crossValidation.candidates).map(([name, candidate]) => `- ${name}: score=\`${candidate.score}\`; eligible=\`${candidate.eligible}\`; folds=\`${candidate.folds.length}\`; converged folds=\`${candidate.folds.filter(({ fit }) => fit.converged).length}\`.`),
  `Selected model=\`${growth.selection.selectedModel}\`; selected score=\`${growth.selection.selectedScore}\`; frozenBeforeDevelopment=\`${growth.selection.frozenBeforeDevelopment}\`. ${growth.selection.tiePolicy}`,
  "## Previously viewed development comparison",
  metricLines("Frozen selected OD candidate", growth.development.selected.metrics),
  metricLines("Exact-time training-mean baseline", growth.development.baseline.metrics),
  `- Selected minus baseline macro RMSE: \`${growth.development.deltaMacroRmseVsBaseline}\`.`,
  metricLines("Legacy latent-model OD calibration", result.validation.metrics),
  metricLines("Legacy predeclared baseline", result.validation.metrics.baselineComparison.baselineMetrics),
  `- Legacy model minus baseline: ${JSON.stringify(result.validation.metrics.baselineComparison.delta)}.`,
  "Deltas are reported with their actual signs, not interpreted as untouched validation or a required model victory. OD600 is not CFU/mL. No antibiotic, clinical, resistance-evolution or combination-therapy inference is supported.",
  "## Paired training-trajectory bootstrap",
  `- Requested=\`${growth.bootstrap.requestedSamples}\`; successful=\`${growth.bootstrap.successfulSamples}\`; failures=\`${growth.bootstrap.failures.length}\`; resampling unit=\`${growth.bootstrap.resamplingUnit}\`; paired=\`${growth.bootstrap.paired}\`.`,
  `- Independence assumption=\`${growth.bootstrap.independenceAssumption}\`; jointSamplesRetained=\`${growth.bootstrap.jointSamplesRetained}\`. Joint samples, refit parameters, optimizer diagnostics and failures are retained in the scientific result.`,
  "Intervals are conditional and exploratory, not established coverage or independent parameter marginals for sensitivity analysis.",
  jsonBlock(growth.bootstrap.intervals),
  "## Sensitivity and identifiability",
  "Morris and Sobol use declared independent engineering ranges, not independently mixed marginals of the joint growth bootstrap. Raw finite estimates, intervals and precision issues are retained without clipping or reordering.",
  "### Morris",
  jsonBlock({ effectScale: morris.effectScale, delta: morris.delta, byParameter: morris.byParameter }),
  "### Sobol–Jansen with paired-row bootstrap",
  jsonBlock({ bootstrap: sobol.bootstrap, byParameter: sobol.byParameter }),
  "Objective slices hold other biological parameters fixed and reoptimize OD nuisance parameters; they are not profile-likelihood confidence limits. Full slices and covariance/rank diagnostics are retained in the scientific result.",
  "## Completion, convergence, identification and precision",
  ...["completed", "converged", "identified", "precisionAssessed"].map((name) => `- ${name}=\`${result.researchAssessment[name]}\`.`),
  jsonBlock(result.researchAssessment),
  `- Legacy training converged=\`${result.training.converged}\`; all optimizer restart/stage termination diagnostics are retained.`,
  ...Object.entries(growth.trainingFits).map(([name, fit]) => `- ${name} training: finite=\`${fit.finite}\`; converged=\`${fit.converged}\`.`),
  `- Capability level=\`${result.capability.level}\`; heldOutValidationEligibleForL4=\`${result.capability.heldOutValidationEligibleForL4}\`. Previously viewed development data is not L4 validation evidence.`,
  "## Exact computation settings and RNG substreams",
  jsonBlock(Object.fromEntries(Object.entries(replayOptions).filter(([key]) => !["datasetInput", "resolvedModel"].includes(key)))),
  "The omitted source text and resolved model above are fully embedded in research-replay-input, not external dependencies. The teaching model and dataset versions are separate from the application and analysis versions.",
  "## Warnings",
  ...result.warnings.map(({ code, message }) => `- \`${code}\`: ${message}`),
  "## Frozen historical artifacts",
  "These Stage 5 files remain byte-for-byte historical records, not current-method outputs or new validation evidence. This command never regenerates them, even when passed their paths explicitly.",
  ...artifact.historicalArtifacts.map(({ path, sha256: hash }) => `- \`${path}\`; SHA-256 \`${hash}\`.`),
  `The unmodified research package, actual scientific fields and replay inputs are in [the companion JSON](${companionLink(jsonPath)}).`,
].join("\n\n") + "\n";

await Promise.all([mkdir(dirname(jsonPath), { recursive: true }), mkdir(dirname(markdownPath), { recursive: true })]);
await assertSafeDestinations();
await Promise.all([
  writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`),
  writeFile(markdownPath, markdown),
]);
console.log(`Generated ${slashPath(relative(rootPath, jsonPath))} and ${slashPath(relative(rootPath, markdownPath))}.`);
