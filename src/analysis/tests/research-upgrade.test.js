import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries, ENGINE_VERSION } from "../../model.js";
import { canonicalJson, sha256HexFallback } from "../fingerprint.js";
import { ANALYSIS_ENGINE_VERSION, ANALYSIS_IMPLEMENTATION_ID } from "../version.js";
import { runEcolabStage4ResearchWorkflow } from "../research-workflow.js";
import { assertSchemaValid } from "./schema-test-helper.js";

const upgrade = await import("../research-upgrade.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("research-upgrade.js")) return {};
  throw error;
});
const root = new URL("../../../", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));
let fixturePromise;
async function fixture() {
  fixturePromise ??= (async () => {
    const [datasetInput, modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
      readFile(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", root), "utf8"),
      json("data/registry/model-definitions.json"), json("data/registry/parameter-sets.json"), json("data/registry/sources.json"),
    ]);
    const resolvedModel = resolveModelFromRegistries({
      modelRegistry, parameterRegistry, sourceRegistry,
      modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
      parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
    });
    return { datasetInput, resolvedModel };
  })();
  return fixturePromise;
}
async function options(overrides = {}) {
  return {
    ...await fixture(), runId: "development-contract-test", createdAt: "2026-09-07T12:00:00.000Z", datasetVersion: "1.0.0",
    seed: 9127,
    optimizer: { restarts: 1, populationSize: 4, differentialEvolutionMaxEvaluations: 8, nelderMeadMaxEvaluations: 8 },
    scanPointsPerAxis: 3, monteCarloSamples: 4, morrisTrajectories: 1, sobolSamples: 4,
    sobolBootstrapReplicates: 4, sobolBootstrapSeed: 73, sobolConfidenceLevel: 0.8, sobolPrecisionTolerance: 0.15,
    identifiabilityProfilePoints: 3,
    growthComparison: { optimizer: { restarts: 1, populationSize: 4, differentialEvolutionMaxEvaluations: 4, nelderMeadMaxEvaluations: 4 }, bootstrap: { samples: 2, intervalLevel: 0.8 } },
    runtime: { yieldControl: async () => {} },
    ...overrides,
  };
}
function artifact(result, id) { return result.researchPackage.contents.artifacts[id]; }

function noUntouchedClaims(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "untouched") assert.equal(child, false);
    if (key === "role") assert.notEqual(child, "locked_holdout_evaluation");
    if (key === "evidenceStatus") assert.notEqual(child, "procedural_locked_holdout_evaluation");
    if (key === "eligibleAsValidationEvidence" || key === "eligibleForL4") assert.equal(child, false);
    noUntouchedClaims(child);
  }
}

test("v2 public API and implementation identity exist", () => {
  assert.equal(typeof upgrade.runEcolabResearchWorkflow, "function");
  assert.equal(typeof upgrade.scientificResearchProjection, "function");
  assert.equal(upgrade.RESEARCH_WORKFLOW_IMPLEMENTATION_ID, "ecolab-research-development-v2");
});

test("development mode reaches legacy snapshots, capability and methods before package construction", async () => {
  const input = await options();
  const result = await runEcolabStage4ResearchWorkflow({
    ...input, growthComparison: undefined, developmentComparison: true,
    applicationVersion: "6.0.0", contentHash: sha256HexFallback(input.datasetInput),
  });
  assert.equal(result.validation.role, "development_comparison");
  assert.equal(result.validation.untouched, false);
  assert.equal(result.validation.previouslyViewed, true);
  assert.equal(result.validation.fittedOnThisData, false);
  assert.equal(result.capability.gates.find(({ level }) => level === "L4").evidence.untouched, false);
  assert.equal(result.lockedPlan.notes.evaluationRole, "development_comparison");
  noUntouchedClaims(result);
  assert.doesNotMatch(JSON.stringify(result.researchPackage), /Held-out validation was locked and leakage-free/);
  const sobol = result.analyses.sensitivity.sobolJansen;
  assert.equal(sobol.bootstrap.replicates, 4);
  assert.equal(sobol.bootstrap.seed, 73);
  assert.equal(sobol.bootstrap.confidenceLevel, 0.8);
  assert.equal(sobol.bootstrap.precisionTolerance, 0.15);
  for (const slice of result.identifiability.objectiveSlices) {
    assert.equal(slice.nuisanceParametersOptimized, true);
    assert.equal(slice.otherBiologicalParametersOptimized, false);
    assert.equal(slice.profileLikelihood, false);
    assert.match(slice.interpretation, /OD.*nuisance.*reoptimized/i);
  }
  assert.deepEqual(result.identifiability.profiles, result.identifiability.objectiveSlices);
  assert.equal(result.identifiability.warnings.some(({ code }) => code === "DEPRECATED_PROFILES_ALIAS"), false);
});

test("new wrapper builds strict replay artifacts and deterministic scientific projection roundtrip", async () => {
  const input = await options();
  const first = await upgrade.runEcolabResearchWorkflow(input);
  const replay = artifact(first, "research-replay-input");
  assert.deepEqual(Object.keys(replay).sort(), ["schemaVersion", "kind", "implementationId", "versions", "options"].sort());
  assert.equal(replay.kind, "ecolab-research-replay-input");
  assert.equal(replay.implementationId, upgrade.RESEARCH_WORKFLOW_IMPLEMENTATION_ID);
  assert.deepEqual(replay.versions, {
    application: "6.0.0", core: ENGINE_VERSION, analysis: ANALYSIS_ENGINE_VERSION, analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID,
  });
  assert.equal(replay.options.datasetInput, input.datasetInput);
  assert.deepEqual(replay.options.resolvedModel, input.resolvedModel);
  assert.equal(replay.options.contentHash, sha256HexFallback(input.datasetInput));
  assert.equal(replay.options.applicationVersion, "6.0.0");
  assert.equal(replay.options.developmentComparison, true);
  for (const key of ["datasetFormat", "packageId", "planId", "uncertaintyRangeFraction", "morrisLevels", "includeMonteCarloSamples", "returnedMonteCarloSamples", "scalarOutputTimeHours", "computationSettings", "seeds"]) {
    assert.ok(Object.hasOwn(replay.options, key), key);
  }
  assert.equal(Object.hasOwn(replay.options, "runtime"), false);
  assert.equal(Object.hasOwn(replay.options, "onProgress"), false);
  assert.deepEqual(replay.options.growthComparison.bounds, {
    baselineOd: [0, 0.3], amplitudeOd: [0.001, 1], ratePerHour: [0.001, 4], timingHours: [0, 30],
  });
  assert.ok(Array.isArray(replay.options.growthComparison.crossValidation.folds));
  assert.equal(replay.options.growthComparison.optimizer.tolerance, 1e-7);
  assert.equal(replay.options.sobolBootstrapSeed, 73);
  const settings = replay.options.computationSettings;
  assert.equal(settings.differentialEvolution.mutationFactor, 0.8);
  assert.equal(settings.differentialEvolution.objectiveTolerance, 1e-10);
  assert.equal(settings.nelderMead.tolerance, 1e-8);
  assert.equal(settings.observationLayer.minimumScaleOd, 1e-12);
  assert.deepEqual(settings.monteCarlo.quantileProbabilities, [0.025, 0.5, 0.975]);
  assert.equal(settings.morris.delta, first.analyses.sensitivity.morris.delta);
  for (const difference of first.identifiability.jacobian.schemes) {
    const expected = settings.identifiability.relativeStep * (difference.scheme === "central" ? 2 : 1);
    assert.ok(Math.abs(difference.normalizedStep - expected) < 1e-12);
  }
  assert.deepEqual(settings.training.bounds, first.training.bounds);
  if (first.identifiability.rank < first.identifiability.parameterNames.length) {
    assert.equal(first.identifiability.covarianceApproximation, null);
    assert.equal(artifact(first, "scientific-result").identifiability.covarianceApproximation, null);
  }
  assert.deepEqual(artifact(first, "scientific-result"), upgrade.scientificResearchProjection(first));
  for (const id of ["normalized-observation-dataset", "dataset-split", "locked-analysis-plan", "resolved-model-snapshot", "research-replay-input", "scientific-result"]) {
    assert.ok(first.researchPackage.replay.artifactIds.includes(id), id);
  }
  for (const { artifactId, path, sha256 } of first.researchPackage.artifactInventory) {
    if (Object.hasOwn(first.researchPackage.contents.artifacts, artifactId)) {
      assert.equal(sha256, sha256HexFallback(canonicalJson(artifact(first, artifactId))));
    }
    if (artifactId === "research-replay-input") assert.equal(path, "research-replay-input.json");
  }
  assert.deepEqual(artifact(first, "dataset-split"), first.split);
  assert.deepEqual(artifact(first, "locked-analysis-plan"), first.lockedPlan);
  assert.deepEqual(artifact(first, "resolved-model-snapshot"), input.resolvedModel);
  assert.equal(first.researchPackage.replay.dependencies.find(({ id }) => id === ANALYSIS_IMPLEMENTATION_ID).version, ANALYSIS_ENGINE_VERSION);
  assert.equal(first.researchAssessment.completed, true);
  for (const key of ["converged", "identified", "precisionAssessed"]) assert.equal(first.researchAssessment[key], false, key);
  noUntouchedClaims(first);
  assert.equal(first.training.observationRoleUsed, "training");
  const second = await upgrade.runEcolabResearchWorkflow({ ...JSON.parse(JSON.stringify(replay.options)), runtime: input.runtime });
  assert.deepEqual(second, first);
  const changedMetadata = await upgrade.runEcolabResearchWorkflow({ ...replay.options, createdAt: "2026-09-08T13:00:00.000Z", runtime: input.runtime });
  assert.deepEqual(upgrade.scientificResearchProjection(changedMetadata), upgrade.scientificResearchProjection(first));
  const [manifestSchema, packageSchema] = await Promise.all([json("schemas/analysis-run.schema.json"), json("schemas/research-package.schema.json")]);
  assertSchemaValid(first.manifest, manifestSchema);
  assertSchemaValid(first.researchPackage, packageSchema, { documents: { "analysis-run.schema.json": manifestSchema } });
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);
});

test("development OD changes cannot alter any fitted training/growth/bootstrap or sensitivity computation", async () => {
  const input = await options();
  const first = await upgrade.runEcolabResearchWorkflow(input);
  const dataset = JSON.parse(input.datasetInput);
  for (const row of dataset.observations) if (row.role === "validation") row.value += 3;
  const second = await upgrade.runEcolabResearchWorkflow({ ...input, datasetInput: JSON.stringify(dataset) });
  for (const key of ["training", "identifiability", "analyses", "seeds"]) assert.deepEqual(second[key], first[key], key);
  for (const key of ["configuration", "trainingFits", "crossValidation", "selection", "bootstrap"]) assert.deepEqual(second.growthComparison[key], first.growthComparison[key], key);
  assert.notDeepEqual(second.validation.metrics, first.validation.metrics);
});

test("object input is canonical source text with a new verified hash, never an old unverified byte-hash claim", async () => {
  const input = await options();
  const dataset = JSON.parse(input.datasetInput);
  const result = await upgrade.runEcolabResearchWorkflow({ ...input, datasetInput: dataset });
  const replay = artifact(result, "research-replay-input");
  assert.equal(replay.options.datasetInput, canonicalJson(dataset));
  assert.equal(replay.options.contentHash, sha256HexFallback(replay.options.datasetInput));
  assert.equal(result.dataset.sourceArtifactSha256Verified, true);
  await assert.rejects(upgrade.runEcolabResearchWorkflow({ ...input, datasetInput: dataset, contentHash: sha256HexFallback(input.datasetInput) }), { code: "CONTENT_HASH_MISMATCH" });
});

test("metadata, ignored settings, incompatible versions and replay settings are rejected before work", async () => {
  const base = await options();
  for (const mutate of [
    (x) => { delete x.runId; }, (x) => { delete x.createdAt; }, (x) => { delete x.datasetVersion; },
    (x) => { x.createdAt = "not-a-date"; }, (x) => { x.applicationVersion = "5.0.0"; },
    (x) => { x.contentHash = "0".repeat(64); }, (x) => { x.ignored = true; },
    (x) => { x.optimizer.surprise = 1; }, (x) => { x.growthComparison.seed = 2; },
    (x) => { x.developmentComparison = false; }, (x) => { x.scalarOutputTimeHours = 9; },
    (x) => { x.sobolBootstrapReplicates = 1; }, (x) => { x.sobolConfidenceLevel = 1; },
    (x) => { x.sobolPrecisionTolerance = -1; }, (x) => { x.seeds = { optimizer: 1 }; },
    (x) => { x.computationSettings = {}; }, (x) => { x.dataset = x.datasetInput; },
    (x) => { x.includeMonteCarloSamples = "yes"; }, (x) => { x.runtime = { surprise: true }; },
    (x) => { x.growthComparison.bounds = { baselineOd: [0, 1] }; },
    (x) => { x.growthComparison.bootstrap.intervalLevel = 1; },
    (x) => { x.growthComparison.crossValidation = { folds: [["unknown"], ["other"]] }; },
    (x) => { x.populationSize = x.optimizer.populationSize + 1; },
    (x) => { x.uncertaintyRangeFraction = 0; },
    (x) => { x.monteCarloSamples = null; },
    (x) => { x.growthComparison.bootstrap = null; },
    (x) => { x.growthComparison.crossValidation = { folds: null }; },
    (x) => { x.resolvedModel.ref.version = "2.0.0"; },
  ]) {
    const input = { ...base, resolvedModel: structuredClone(base.resolvedModel), optimizer: { ...base.optimizer }, growthComparison: structuredClone(base.growthComparison) };
    mutate(input);
    let progress = 0;
    await assert.rejects(upgrade.runEcolabResearchWorkflow({ ...input, onProgress: () => { progress += 1; } }));
    assert.equal(progress, 0);
  }
});

test("cooperative cancellation stops at legacy bounded phases and within growth before building replay artifacts", async () => {
  const input = await options();
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(upgrade.runEcolabResearchWorkflow({ ...input, runtime: { signal: stopped.signal } }), { code: "ANALYSIS_CANCELLED" });
  for (const target of ["training_fit", "identifiability", "sobol_sensitivity", "parameter_scan", "monte_carlo", "growth:cross_validation", "growth:bootstrap", "research_package"]) {
    const controller = new AbortController();
    const phases = [];
    await assert.rejects(upgrade.runEcolabResearchWorkflow({
      ...input,
      runtime: { signal: controller.signal, yieldControl: async () => {} },
      onProgress: ({ phase }) => { phases.push(phase); if (phase === target) controller.abort(); },
    }), { code: "ANALYSIS_CANCELLED" });
    assert.equal(phases.at(-1), target);
    assert.equal(phases.includes("complete"), false);
  }
  const hostError = Object.assign(new Error("host stop"), { code: "HOST_CANCEL" });
  let yields = 0;
  await assert.rejects(upgrade.runEcolabResearchWorkflow({ ...input, runtime: {
    checkCancelled: () => { if (yields === 2) throw hostError; }, yieldControl: async () => { yields += 1; },
  } }), (error) => error === hostError);
});

test("app defaults and fixed growth rules are explicit, detached and reject contradictory replay settings", async () => {
  const input = await options({
    seed: undefined, sobolBootstrapSeed: undefined, includeMonteCarloSamples: true, returnedMonteCarloSamples: 2,
    growthComparison: undefined,
  });
  const result = await upgrade.runEcolabResearchWorkflow(input);
  const normalized = artifact(result, "research-replay-input").options;
  assert.equal(normalized.seed, 0x5e4c0ab1);
  assert.equal(normalized.uncertaintyRangeFraction, 0.1);
  assert.equal(normalized.morrisLevels, 4);
  assert.equal(result.analyses.monteCarlo.samples.length, 2);
  assert.deepEqual(normalized.growthComparison.optimizer, {
    restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 120,
    nelderMeadMaxEvaluations: 80, tolerance: 1e-7, objectiveTolerance: 1e-12,
  });
  assert.deepEqual(normalized.growthComparison.bootstrap, { samples: 20, intervalLevel: 0.95 });
  assert.deepEqual(normalized.computationSettings.growthComparison.optimizerConstants, result.growthComparison.configuration.optimizerConstants);
  assert.equal(normalized.computationSettings.growthComparison.developmentRole, "validation");
  assert.equal(normalized.computationSettings.growthComparison.quantileMethod, "R7");
  assert.equal(result.seeds.sobolBootstrap, result.analyses.sensitivity.sobolJansen.bootstrap.seed);
  assert.equal(result.seeds.growthComparison, result.growthComparison.configuration.seed);
  assert.ok(Object.isFrozen(normalized.growthComparison.bounds.baselineOd));
  assert.ok(result.warnings.some(({ code }) => code === "LOW_BOOTSTRAP_SAMPLE_COUNT"));
  for (const mutate of [
    (x) => { x.seeds.growthComparison += 1; },
    (x) => { x.computationSettings.growthComparison.optimizerConstants.mutationFactor = 0.6; },
    (x) => { x.scalarOutputTimeHours = 12; },
  ]) {
    const replay = structuredClone(normalized); mutate(replay);
    let progress = 0;
    await assert.rejects(upgrade.runEcolabResearchWorkflow({ ...replay, onProgress: () => { progress += 1; } }));
    assert.equal(progress, 0);
  }
});

test("synthetic single-time training support preserves null rank-deficient covariance through artifacts", async () => {
  const input = await options();
  const dataset = JSON.parse(input.datasetInput);
  dataset.observations = dataset.observations.filter(({ timeHours }) => timeHours === 10);
  for (const row of dataset.observations) row.value = row.role === "training" ? 0.125 : 0.15;
  const result = await upgrade.runEcolabResearchWorkflow({ ...input, datasetInput: dataset });
  assert.ok(result.identifiability.rank < result.identifiability.parameterNames.length);
  assert.equal(result.identifiability.covarianceApproximation, null);
  assert.equal(result.manifest.diagnostics.identifiability.covarianceApproximation, null);
  assert.equal(artifact(result, "scientific-result").identifiability.covarianceApproximation, null);
  assert.equal(result.researchAssessment.identified, false);
  assert.ok(result.warnings.some(({ code }) => code === "PARAMETER_COVARIANCE_UNAVAILABLE"));
});

test("scientific projection includes only declared scientific fields and recursively omits timestamps", () => {
  const fields = ["dataset", "model", "split", "parameterSpace", "seeds", "training", "identifiability", "lockedPlan", "validation", "analyses", "growthComparison", "capability", "warnings", "researchAssessment"];
  const result = Object.fromEntries(fields.map((field) => [field, { value: field, createdAt: "time" }]));
  result.manifest = null; result.createdAt = "now"; result.researchPackage = {}; result.methodsSummaryMarkdown = "methods";
  const projection = upgrade.scientificResearchProjection(result);
  assert.deepEqual(Object.keys(projection).sort(), [...fields].sort());
  assert.ok(Object.values(projection).every((value) => !Object.hasOwn(value, "createdAt")));
});
