import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries } from "../../model.js";
import { buildResearchPackage } from "../analysis-manifest.js";
import { canonicalJson, sha256HexFallback } from "../fingerprint.js";
import { runEcolabStage4ResearchWorkflow } from "../research-workflow.js";
import { runEcolabResearchWorkflow, scientificResearchProjection } from "../research-upgrade.js";
import { fingerprintAnalysisPlan } from "../analysis-plan.js";

const replayModule = await import("../research-replay.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("research-replay.js")) return null;
  throw error;
});
const inspect = (input) => {
  assert.equal(typeof replayModule?.inspectResearchPackage, "function", "inspectResearchPackage must be implemented");
  return replayModule.inspectResearchPackage(input);
};
const replay = (input, options) => {
  assert.equal(typeof replayModule?.replayResearchPackage, "function", "replayResearchPackage must be implemented");
  return replayModule.replayResearchPackage(input, options);
};
const clone = (value) => structuredClone(value);
const fastRuntime = { yieldControl: async () => {} };
const root = new URL("../../../", import.meta.url);
let fixturePromise;
function fixture() {
  fixturePromise ??= (async () => {
    const text = (path) => readFile(new URL(path, root), "utf8");
    const json = async (path) => JSON.parse(await text(path));
    const [datasetInput, modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
      text("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json"),
      json("data/registry/model-definitions.json"), json("data/registry/parameter-sets.json"), json("data/registry/sources.json"),
    ]);
    const resolvedModel = resolveModelFromRegistries({
      modelRegistry, parameterRegistry, sourceRegistry,
      modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
      parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
    });
    const options = {
      datasetInput, resolvedModel, seed: 123456789,
      optimizer: { restarts: 1, populationSize: 8, differentialEvolutionMaxEvaluations: 40, nelderMeadMaxEvaluations: 30 },
      scanPointsPerAxis: 3, monteCarloSamples: 4, morrisTrajectories: 1, morrisLevels: 4,
      sobolSamples: 4, identifiabilityProfilePoints: 3, returnedMonteCarloSamples: 2,
      applicationVersion: "5.0.0", runId: "replay-legacy-test", createdAt: "2026-09-07T12:00:00.000Z",
      datasetVersion: "1.0.0", contentHash: sha256HexFallback(datasetInput),
    };
    const legacy = await runEcolabStage4ResearchWorkflow(options);
    return { options, legacy, researchPackage: legacy.researchPackage };
  })();
  return fixturePromise;
}

function contentFor(pkg, id) {
  return id === "analysis-manifest" ? pkg.contents.analysisManifest
    : id === "methods-summary" ? pkg.contents.methodsSummaryMarkdown : pkg.contents.artifacts[id];
}
function rehash(pkg, id) {
  const content = contentFor(pkg, id);
  const text = typeof content === "string" ? content : canonicalJson(content);
  const entry = pkg.artifactInventory.find((item) => item.artifactId === id);
  entry.sha256 = sha256HexFallback(text);
  entry.byteLength = new TextEncoder().encode(text).length;
}
function rejects(input, code) {
  assert.throws(() => inspect(input), (error) => error.name === "ResearchReplayError" && error.code === code && typeof error.path === "string");
}

test("inspector synchronously verifies a genuine legacy inventory but never claims replayability", async () => {
  const { researchPackage } = await fixture();
  const inspected = inspect(researchPackage);
  assert.equal(inspected instanceof Promise, false);
  assert.equal(inspected.replayable, false);
  assert.equal(inspected.status, "inspect_only");
  assert.ok(inspected.reasons.some((reason) => reason.code === "MISSING_REPLAY_INPUT"));
  assert.deepEqual(inspected.researchPackage, researchPackage);
  assert.notStrictEqual(inspected.researchPackage, researchPackage);
  assert.ok(Object.isFrozen(inspected.researchPackage.contents.artifacts));
  assert.deepEqual(inspect(JSON.stringify(researchPackage)), inspected);
});

test("all inventory bytes use UTF-8 for strings and canonical JSON for object artifacts", async () => {
  const { researchPackage } = await fixture();
  const pkg = buildResearchPackage({
    manifest: researchPackage.contents.analysisManifest,
    methodsSummaryMarkdown: "# 方法 🧪\n",
    artifacts: [{ artifactId: "unicode", role: "note", path: "notes/unicode.txt", mediaType: "text/plain", content: "实验 🧪\ud800" }],
  });
  assert.equal(inspect(pkg).status, "inspect_only");
  const corrupted = clone(pkg);
  corrupted.artifactInventory.find((entry) => entry.artifactId === "unicode").byteLength = corrupted.contents.artifacts.unicode.length;
  rejects(corrupted, "RESEARCH_PACKAGE_INTEGRITY");
});

test("strict package and manifest required/extra fields are rejected, even after manifest rehash", async () => {
  const { researchPackage } = await fixture();
  for (const change of [
    (pkg) => { pkg.extra = true; },
    (pkg) => { delete pkg.packageId; },
    (pkg) => { pkg.contents.extra = true; },
    (pkg) => { pkg.replay.extra = true; },
    (pkg) => { pkg.replay.selfContained = true; },
    (pkg) => { pkg.createdAt = "yesterday"; },
    (pkg) => { pkg.artifactInventory[0].extra = true; },
    (pkg) => { pkg.artifactInventory[0].byteLength = 1.5; },
  ]) {
    const pkg = clone(researchPackage); change(pkg); rejects(pkg, "RESEARCH_PACKAGE_SCHEMA");
  }
  for (const change of [
    (manifest) => { manifest.extra = true; },
    (manifest) => { delete manifest.dataset.normalizedDatasetFingerprint; },
    (manifest) => { manifest.versions.extra = "x"; },
    (manifest) => { manifest.random.seed = -1; },
    (manifest) => { manifest.model.extra = "x"; },
    (manifest) => { delete manifest.diagnostics.metrics; },
    (manifest) => { manifest.convergence.converged = "yes"; },
    (manifest) => { manifest.warnings.push({ code: "X", message: "missing severity" }); },
  ]) {
    const pkg = clone(researchPackage); change(pkg.contents.analysisManifest); rehash(pkg, "analysis-manifest");
    rejects(pkg, "RESEARCH_PACKAGE_SCHEMA");
  }
});

test("inventory requires a one-to-one content mapping including both reserved artifacts", async () => {
  const { researchPackage } = await fixture();
  for (const change of [
    (pkg) => { pkg.artifactInventory.push(clone(pkg.artifactInventory[0])); },
    (pkg) => { pkg.artifactInventory[1].path = pkg.artifactInventory[0].path; },
    (pkg) => { pkg.contents.artifacts.extra = {}; },
    (pkg) => { pkg.contents.artifacts["analysis-manifest"] = {}; },
    (pkg) => { delete pkg.contents.artifacts["dataset-split"]; },
    (pkg) => { pkg.artifactInventory.shift(); },
    (pkg) => { pkg.artifactInventory[0].role = "methods_summary"; },
    (pkg) => { pkg.replay.artifactIds.push("nonexistent"); },
    (pkg) => { pkg.replay.artifactIds.push(pkg.replay.artifactIds[0]); },
  ]) {
    const pkg = clone(researchPackage); change(pkg); rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
  }
});

test("every artifact is hashed, including methods text and unrelated additional content", async () => {
  const { researchPackage } = await fixture();
  for (const id of researchPackage.artifactInventory.map((entry) => entry.artifactId)) {
    const pkg = clone(researchPackage);
    pkg.artifactInventory.find((entry) => entry.artifactId === id).sha256 = "0".repeat(64);
    rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
  }
});

test("rehashing dataset/split/plan/model/manifest does not bypass cross-association checks", async () => {
  const { researchPackage } = await fixture();
  for (const [id, change] of [
    ["normalized-observation-dataset", (value) => { value.observations[0].value += 0.01; }],
    ["dataset-split", (value) => { value.sourceDatasetId = "other"; }],
    ["dataset-split", (value) => { value.roles.training.observationCount += 1; }],
    ["locked-analysis-plan", (value) => { value.seeds.analysis += 1; }],
    ["resolved-model-snapshot", (value) => { value.parameters.psiMaxLog10PerHour += 0.01; }],
    ["analysis-manifest", (value) => { value.runId = "another-run"; }],
    ["analysis-manifest", (value) => { value.dataset.hash = "0".repeat(64); }],
    ["analysis-manifest", (value) => { value.random.seed += 1; }],
  ]) {
    const pkg = clone(researchPackage); change(contentFor(pkg, id)); rehash(pkg, id);
    rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
  }
  const pkg = clone(researchPackage);
  const split = pkg.contents.artifacts["dataset-split"];
  split.roles.training.observationIds.reverse();
  const { splitFingerprint: old, ...body } = split;
  split.splitFingerprint = sha256HexFallback(canonicalJson(body));
  rehash(pkg, "dataset-split");
  rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
});

test("unsafe artifact IDs and paths are rejected rather than decoded or accessed", async () => {
  const { researchPackage } = await fixture();
  for (const path of ["../x", "/tmp/x", "C:\\x", "a\\b", "a/../b", "a/./b", "a//b", "https://example.com/a", "%2e%2e/x", "x\u0000", "x/", "a/.. "]) {
    const pkg = clone(researchPackage); pkg.artifactInventory[0].path = path;
    rejects(pkg, "RESEARCH_PACKAGE_UNSAFE");
  }
  const pkg = clone(researchPackage); pkg.artifactInventory[0].artifactId = "../analysis-manifest";
  rejects(pkg, "RESEARCH_PACKAGE_UNSAFE");
});

test("untrusted JSON rejects duplicate keys, unsafe keys, nonfinite numbers, and trailing content", () => {
  for (const input of ['{"x":1,"x":2}', '{"x":1,}', '{"x":1}{}', '{"x":1e999}']) rejects(input, "RESEARCH_PACKAGE_JSON");
  for (const input of ['{"__proto__":{}}', '{"x":{"constructor":{}}}', '{"prototype":1}']) rejects(input, "RESEARCH_PACKAGE_UNSAFE");
});

test("object input never invokes accessors/toJSON and rejects non-JSON structures", () => {
  let calls = 0;
  const accessor = Object.defineProperty({}, "contents", { enumerable: true, get() { calls += 1; return {}; } });
  rejects(accessor, "RESEARCH_PACKAGE_UNSAFE");
  rejects({ toJSON() { calls += 1; return {}; } }, "RESEARCH_PACKAGE_UNSAFE");
  assert.equal(calls, 0);
  const cyclic = {}; cyclic.cycle = cyclic;
  for (const input of [cyclic, { value: Infinity }, { value: undefined }, { value: 1n }, { value: new Date() }, { values: new Array(2) }]) {
    rejects(input, "RESEARCH_PACKAGE_UNSAFE");
  }
});

test("package size, artifact count, nesting depth and node limits are enforced", async () => {
  rejects(" ".repeat(32 * 1024 * 1024 + 1), "RESEARCH_PACKAGE_LIMIT");
  rejects({ text: "字".repeat(12 * 1024 * 1024) }, "RESEARCH_PACKAGE_LIMIT");
  let deep = null; for (let index = 0; index < 66; index += 1) deep = { deep };
  rejects(deep, "RESEARCH_PACKAGE_LIMIT");
  rejects({ nodes: Array(1_000_001).fill(null) }, "RESEARCH_PACKAGE_LIMIT");
  const pkg = clone((await fixture()).researchPackage);
  pkg.artifactInventory = Array.from({ length: 65 }, () => clone(pkg.artifactInventory[0]));
  rejects(pkg, "RESEARCH_PACKAGE_LIMIT");
});

let currentFixturePromise;
async function currentFixture() {
  currentFixturePromise ??= (async () => {
    const { options } = await fixture();
    return runEcolabResearchWorkflow({
      ...options, applicationVersion: "6.0.0", runId: "replay-current-test",
      optimizer: { restarts: 1, populationSize: 4, differentialEvolutionMaxEvaluations: 8, nelderMeadMaxEvaluations: 8 },
      sobolBootstrapReplicates: 4, sobolBootstrapSeed: 73, sobolConfidenceLevel: 0.8, sobolPrecisionTolerance: 0.15,
      growthComparison: {
        optimizer: { restarts: 1, populationSize: 4, differentialEvolutionMaxEvaluations: 4, nelderMeadMaxEvaluations: 4 },
        bootstrap: { samples: 2, intervalLevel: 0.8 },
      },
      runtime: fastRuntime,
    });
  })();
  return currentFixturePromise;
}
function dropArtifact(pkg, id) {
  delete pkg.contents.artifacts[id];
  pkg.artifactInventory = pkg.artifactInventory.filter((entry) => entry.artifactId !== id);
  pkg.replay.artifactIds = pkg.replay.artifactIds.filter((value) => value !== id);
}
function assertDeepFrozen(value) {
  if (!value || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  Object.values(value).forEach(assertDeepFrozen);
}

test("genuine v2 workflow package replays from object and JSON with the full scientific projection", async (t) => {
  const original = await currentFixture();
  const pkg = clone(original.researchPackage);
  const inspected = inspect(pkg);
  assert.equal(inspected.status, "replayable");
  assert.equal(inspected.replayable, true);
  assert.deepEqual(inspected.reasons, []);
  assertDeepFrozen(inspected.researchPackage);
  pkg.contents.artifacts["research-replay-input"].options.seed = 7;
  assert.notEqual(inspected.researchPackage.contents.artifacts["research-replay-input"].options.seed, 7);
  t.mock.method(globalThis, "fetch", () => { assert.fail("replay must never fetch dependencies"); });
  for (const input of [inspected.researchPackage, JSON.stringify(inspected.researchPackage)]) {
    const events = [];
    let yields = 0;
    const replayed = await replay(input, {
      runtime: { yieldControl: async () => { yields += 1; } }, onProgress: (event) => events.push(event),
    });
    assert.equal(replayed.matched, true);
    assert.equal(replayed.comparison.mismatchCount, 0);
    assert.deepEqual(replayed.comparison.mismatchPaths, []);
    assert.equal(replayed.comparison.absoluteTolerance, 1e-10);
    assert.equal(replayed.comparison.relativeTolerance, 1e-8);
    assert.deepEqual(scientificResearchProjection(replayed.result), scientificResearchProjection(original));
    assert.ok(yields > 2);
    assert.ok(events.some(({ phase }) => phase === "replay_inspect"));
    assert.ok(events.some(({ phase }) => phase === "replay_compare"));
    assert.equal(events.at(-1).phase, "complete");
  }
});

test("rehashed manifest science cannot claim a match while disagreeing with recomputed output", async (t) => {
  const original = (await currentFixture()).researchPackage;
  const cases = [
    ["convergence", (m) => { m.convergence.converged = !m.convergence.converged; }, "$.analysisManifest.convergence.converged"],
    ["development metric", (m) => { m.diagnostics.metrics.development.macroRmse += 1; }, "$.analysisManifest.diagnostics.metrics.development.macroRmse"],
    ["training residual", (m) => { m.diagnostics.residuals.training.extraClaim = true; }, "$.analysisManifest.diagnostics.residuals.training.extraClaim"],
    ["identifiability", (m) => { m.diagnostics.identifiability.rank += 1; }, "$.analysisManifest.diagnostics.identifiability.rank"],
    ["capability", (m) => { m.capabilityAssessment.level = "invented"; }, "$.analysisManifest.capabilityAssessment.level"],
    ["warning", (m) => { m.warnings[0].message = "This unsupported claim was rehashed."; }, "$.analysisManifest.warnings[0].message"],
  ];
  for (const [label, mutate, path] of cases) await t.test(label, async () => {
    const pkg = clone(original);
    mutate(pkg.contents.analysisManifest);
    rehash(pkg, "analysis-manifest");
    assert.equal(inspect(pkg).replayable, true, "Integrity inspection is not scientific verification.");
    const result = await replay(pkg, { runtime: fastRuntime });
    assert.equal(result.matched, false);
    assert.ok(result.comparison.mismatchPaths.includes(path));
    assert.equal(result.comparison.mismatchCount, 1);
  });
});

test("legacy packages are refused without starting numerical computation", async () => {
  const pkg = (await fixture()).researchPackage;
  await assert.rejects(replay(pkg, {
    runtime: fastRuntime,
    onProgress: ({ phase }) => assert.ok(!["training_fit", "replay_execute"].includes(phase)),
  }), { name: "ResearchReplayError", code: "RESEARCH_PACKAGE_NOT_REPLAYABLE" });
});

test("unknown but internally consistent software is inspect-only; no imported code or dependency is resolved", async () => {
  const original = (await currentFixture()).researchPackage;
  for (const mutate of [
    (pkg) => {
      pkg.contents.artifacts["research-replay-input"].versions.analysis = "99.0.0";
      pkg.contents.analysisManifest.versions.analysis = "99.0.0";
      pkg.contents.analysisManifest.algorithm.version = "99.0.0";
      pkg.replay.dependencies[0].version = "99.0.0";
    },
    (pkg) => {
      pkg.contents.artifacts["research-replay-input"].versions.application = "99.0.0";
      pkg.contents.artifacts["research-replay-input"].options.applicationVersion = "99.0.0";
      pkg.contents.analysisManifest.versions.application = "99.0.0";
    },
    (pkg) => {
      pkg.contents.artifacts["research-replay-input"].implementationId = "https://example.com/execute.js";
      pkg.contents.analysisManifest.algorithm.name = "https://example.com/execute.js";
      pkg.contents.analysisManifest.algorithm.settings.implementationId = "https://example.com/execute.js";
    },
    (pkg) => { pkg.replay.dependencies[0].version = "2.0.1"; },
    (pkg) => { pkg.replay.dependencies[1].requirement = "compatible"; },
    (pkg) => { pkg.replay.dependencies.push({ id: "remote-script", kind: "software_implementation", version: "1.0.0", requirement: "exact" }); },
    (pkg) => { pkg.replay.dependencies.pop(); },
  ]) {
    const pkg = clone(original); mutate(pkg);
    rehash(pkg, "research-replay-input"); rehash(pkg, "analysis-manifest");
    const inspected = inspect(pkg);
    assert.equal(inspected.status, "inspect_only");
    assert.ok(inspected.reasons.some(({ code, message }) => code.startsWith("UNSUPPORTED_") && typeof message === "string"));
    await assert.rejects(replay(pkg, { runtime: fastRuntime }), { code: "RESEARCH_PACKAGE_NOT_REPLAYABLE" });
    pkg.contents.methodsSummaryMarkdown += "corrupt";
    rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
  }
});

test("v2 rehashed source, metadata, model, version, seeds and fixed settings cannot bypass association checks", async () => {
  const original = (await currentFixture()).researchPackage;
  for (const mutate of [
    (x) => { x.options.datasetInput += " "; },
    (x) => { x.options.contentHash = "0".repeat(64); },
    (x) => { x.options.runId = "different-run"; },
    (x) => { x.options.createdAt = "2026-09-08T12:00:00.000Z"; },
    (x) => { x.options.packageId = "different-package"; },
    (x) => { x.options.datasetVersion = "1.0.1"; },
    (x) => { x.options.planId = "different-plan"; },
    (x) => { x.options.resolvedModel.parameters.psiMaxLog10PerHour += 0.1; },
    (x) => { x.versions.core = "99.0.0"; },
    (x) => { x.options.seed += 1; },
    (x) => { x.options.seeds.optimizer += 1; },
    (x) => { x.options.computationSettings.monteCarlo.propagateObservationError = true; },
    (x) => { x.options.growthComparison.bootstrap.samples += 1; },
  ]) {
    const pkg = clone(original); mutate(pkg.contents.artifacts["research-replay-input"]); rehash(pkg, "research-replay-input");
    rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
  }
  const pkg = clone(original);
  const input = pkg.contents.artifacts["research-replay-input"];
  const data = JSON.parse(input.options.datasetInput); data.observations[0].value += 0.1;
  input.options.datasetInput = JSON.stringify(data);
  input.options.contentHash = sha256HexFallback(input.options.datasetInput);
  pkg.contents.analysisManifest.dataset.sourceArtifactSha256 = input.options.contentHash;
  rehash(pkg, "research-replay-input"); rehash(pkg, "analysis-manifest");
  rejects(pkg, "RESEARCH_PACKAGE_INTEGRITY");
});

test("new replay input is complete and strictly shaped; every required new artifact must be present and declared", async () => {
  const original = (await currentFixture()).researchPackage;
  for (const mutate of [
    (x) => { x.extra = true; }, (x) => { x.kind = "javascript"; },
    (x) => { x.versions.extra = "x"; }, (x) => { delete x.versions.core; },
    (x) => { x.options.runtime = {}; }, (x) => { x.options.onProgress = "execute"; },
    (x) => { delete x.options.optimizer; }, (x) => { delete x.options.morrisLevels; },
    (x) => { delete x.options.growthComparison.bootstrap.intervalLevel; },
    (x) => { x.options.optimizer.extra = 1; }, (x) => { x.options.includeMonteCarloSamples = 1; },
    (x) => { x.options.optimizer.restarts = null; },
  ]) {
    const pkg = clone(original); mutate(pkg.contents.artifacts["research-replay-input"]); rehash(pkg, "research-replay-input");
    rejects(pkg, "RESEARCH_PACKAGE_SCHEMA");
  }
  for (const id of original.replay.artifactIds) {
    const missing = clone(original); dropArtifact(missing, id);
    rejects(missing, "RESEARCH_PACKAGE_INTEGRITY");
    const undeclared = clone(original);
    undeclared.replay.artifactIds = undeclared.replay.artifactIds.filter((value) => value !== id);
    rejects(undeclared, "RESEARCH_PACKAGE_INTEGRITY");
  }
});

test("plan fingerprint uses the exported validator's normalization, not the raw artifact body", async () => {
  const pkg = clone((await fixture()).researchPackage);
  const plan = pkg.contents.artifacts["locked-analysis-plan"];
  delete plan.parameterSpace.parameters[0].transform;
  plan.planFingerprint = await fingerprintAnalysisPlan(plan);
  pkg.contents.analysisManifest.plan.fingerprint = plan.planFingerprint;
  rehash(pkg, "locked-analysis-plan"); rehash(pkg, "analysis-manifest");
  assert.equal(inspect(pkg).status, "inspect_only");
});

test("comparison applies abs plus relative tolerances to numeric leaves, with no metric whitelist", async () => {
  const pkg = clone((await currentFixture()).researchPackage);
  const reference = pkg.contents.artifacts["scientific-result"];
  reference.training.metrics.pooledRmse += 0.0003;
  rehash(pkg, "scientific-result");
  const rejected = await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 0, relativeTolerance: 0 });
  assert.equal(rejected.matched, false);
  assert.deepEqual(rejected.comparison.mismatchPaths, ["$.training.metrics.pooledRmse"]);
  assert.equal((await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 0.00031, relativeTolerance: 0 })).matched, true);
  const relative = 0.00031 / Math.abs(reference.training.metrics.pooledRmse);
  assert.equal((await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 0, relativeTolerance: relative })).matched, true);
  assert.equal((await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 0.00016, relativeTolerance: relative / 2 })).matched, true);
  reference.growthComparison.bootstrap.requestedSamples += 1;
  rehash(pkg, "scientific-result");
  assert.equal((await replay(pkg, { runtime: fastRuntime })).matched, false);
});

test("canonical numeric warning text tolerates runtime roundoff in science and complete manifests only", async () => {
  const pkg = clone((await currentFixture()).researchPackage);
  const science = pkg.contents.artifacts["scientific-result"];
  const manifest = pkg.contents.analysisManifest;
  const locations = [
    [science.identifiability.warnings, "$.identifiability.warnings"],
    [science.warnings, "$.warnings"],
    [manifest.diagnostics.identifiability.warnings, "$.analysisManifest.diagnostics.identifiability.warnings"],
    [manifest.warnings, "$.analysisManifest.warnings"],
  ];
  const numericPaths = [];
  for (const [warnings, path] of locations) {
    const index = warnings.findIndex(({ code }) => code === "STRONG_PARAMETER_CORRELATION");
    assert.ok(index >= 0, `Expected a correlation warning at ${path}.`);
    const warning = warnings[index];
    const previous = warning.correlation;
    warning.correlation += 1e-12;
    assert.notEqual(warning.correlation, previous);
    const previousMessage = warning.message;
    warning.message = warning.message.replace(String(previous), String(warning.correlation));
    assert.notEqual(warning.message, previousMessage);
    numericPaths.push(`${path}[${index}].correlation`);
  }
  rehash(pkg, "scientific-result"); rehash(pkg, "analysis-manifest");
  assert.equal(inspect(pkg).replayable, true);
  const equivalent = await replay(pkg, { runtime: fastRuntime });
  assert.equal(equivalent.matched, true);
  assert.equal(equivalent.comparison.mismatchCount, 0);
  const strict = await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 0, relativeTolerance: 0 });
  assert.equal(strict.matched, false);
  assert.deepEqual([...strict.comparison.mismatchPaths].sort(), numericPaths.sort());
});

test("numeric warning exemptions cannot hide rehashed message, field or structural tampering", async (t) => {
  const original = (await currentFixture()).researchPackage;
  const index = original.contents.analysisManifest.diagnostics.identifiability.warnings.findIndex(({ code }) => code === "STRONG_PARAMETER_CORRELATION");
  assert.ok(index >= 0);
  const base = `$.analysisManifest.diagnostics.identifiability.warnings[${index}]`;
  const cases = [
    ["only message number", (w) => { w.message = w.message.replace(String(w.correlation), String(w.correlation + 1e-12)); }, "message"],
    ["missing qualifier", (w) => { w.message = w.message.replace("; this is not calibrated parameter uncertainty.", "."); }, "message"],
    ["extra text", (w) => { w.message += " Proven stable."; }, "message"],
    ["self-consistent false correlation", (w) => {
      const previous = w.correlation; w.correlation += 0.1;
      w.message = w.message.replace(String(previous), String(w.correlation));
    }, "correlation"],
    ["numeric string", (w) => { w.correlation = String(w.correlation); }, "correlation"],
    ["different known source", (w) => {
      w.source = "normalized_jacobian_columns";
      w.message = `${w.parameters.join(" and ")} have collinear normalized sensitivity columns (cosine ${w.correlation}), not an estimable parameter correlation.`;
    }, "source"],
    ["unknown source", (w) => { w.source = "unknown"; }, "source"],
    ["parameters", (w) => {
      const previous = w.parameters.join(" and "); w.parameters.reverse();
      w.message = w.message.replace(previous, w.parameters.join(" and "));
    }, "parameters[0]"],
    ["malformed parameters", (w) => { w.parameters = null; }, "parameters"],
    ["threshold", (w) => { w.threshold += 0.1; }, "threshold"],
    ["extra field", (w) => { w.unsupportedClaim = true; }, "unsupportedClaim"],
    ["missing field", (w) => { delete w.threshold; }, "threshold"],
    ["warning code", (w) => { w.code = "OTHER"; }, "code"],
    ["severity", (w) => { w.severity = "info"; }, "severity"],
    ["stage", (w) => { w.stage = "invented"; }, "stage"],
  ];
  for (const [name, mutate, suffix] of cases) await t.test(name, async () => {
    const pkg = clone(original);
    mutate(pkg.contents.analysisManifest.diagnostics.identifiability.warnings[index]);
    rehash(pkg, "analysis-manifest");
    assert.equal(inspect(pkg).replayable, true);
    const result = await replay(pkg, { runtime: fastRuntime });
    assert.equal(result.matched, false);
    assert.ok(result.comparison.mismatchPaths.includes(`${base}.${suffix}`));
  });
  await t.test("matching false science and manifest", async () => {
    const pkg = clone(original);
    const science = pkg.contents.artifacts["scientific-result"];
    const manifest = pkg.contents.analysisManifest;
    for (const warnings of [science.identifiability.warnings, science.warnings, manifest.diagnostics.identifiability.warnings, manifest.warnings]) {
      const warning = warnings.find(({ code }) => code === "STRONG_PARAMETER_CORRELATION");
      assert.ok(warning);
      const previous = warning.correlation; warning.correlation += 0.1;
      warning.message = warning.message.replace(String(previous), String(warning.correlation));
    }
    rehash(pkg, "scientific-result"); rehash(pkg, "analysis-manifest");
    assert.equal(inspect(pkg).replayable, true);
    const result = await replay(pkg, { runtime: fastRuntime });
    assert.equal(result.matched, false);
    assert.equal(result.comparison.mismatchCount, 4);
    assert.ok(result.comparison.mismatchPaths.every((path) => path.endsWith(".correlation")));
  });
});

test("comparison reports exact structural, array-order, type and missing/extra-key differences with bounded paths", async () => {
  const pkg = clone((await currentFixture()).researchPackage);
  const reference = pkg.contents.artifacts["scientific-result"];
  reference.warnings.reverse();
  reference.researchAssessment.completed = "true";
  delete reference.identifiability;
  reference.validation = [];
  reference.analyses = null;
  for (let i = 0; i < 150; i += 1) reference[`unexpected${i}`] = i;
  reference["x".repeat(2000)] = "no unbounded path reporting";
  rehash(pkg, "scientific-result");
  const replayed = await replay(pkg, { runtime: fastRuntime, absoluteTolerance: 1e10, relativeTolerance: 1e10 });
  assert.equal(replayed.matched, false);
  assert.ok(replayed.comparison.mismatchCount > 150);
  assert.ok(replayed.comparison.mismatchPaths.length <= 100);
  assert.ok(replayed.comparison.mismatchPaths.every((path) => path.length <= 512));
  assert.equal(replayed.comparison.truncated, true);
  assert.ok(replayed.comparison.mismatchPaths.includes("$.analyses"));
  assert.ok(replayed.comparison.mismatchPaths.includes("$.identifiability"));
});

test("invalid numeric tolerances are rejected before replay", async () => {
  const pkg = (await currentFixture()).researchPackage;
  for (const key of ["absoluteTolerance", "relativeTolerance"]) for (const value of [-1, NaN, Infinity, "1", null]) {
    await assert.rejects(replay(pkg, { [key]: value, runtime: fastRuntime }), { code: "RESEARCH_REPLAY_TOLERANCE" });
  }
});

test("replay cancellation is honored before inspection, across yields, after progress and at completion", async () => {
  const pkg = (await currentFixture()).researchPackage;
  const stopped = new AbortController(); stopped.abort();
  await assert.rejects(replay("not JSON", { runtime: { signal: stopped.signal } }), { code: "ANALYSIS_CANCELLED" });
  await assert.rejects(replay(pkg, { runtime: { checkCancelled: () => true } }), { code: "ANALYSIS_CANCELLED" });
  const yielding = new AbortController();
  await assert.rejects(replay(pkg, { runtime: { signal: yielding.signal, yieldControl: async () => yielding.abort() } }), { code: "ANALYSIS_CANCELLED" });
  for (const phase of ["replay_inspect", "training_fit", "growth:training_fit", "replay_compare", "complete"]) {
    const controller = new AbortController();
    let seen = false;
    const task = replay(pkg, {
      runtime: { ...fastRuntime, signal: controller.signal },
      onProgress(event) { if (event.phase === phase) { seen = true; controller.abort(); } },
    });
    await assert.rejects(task, { name: "ResearchReplayError", code: "ANALYSIS_CANCELLED" }, phase);
    assert.equal(seen, true, phase);
  }
  for (const phase of ["replay_inspect", "training_fit", "replay_compare"]) {
    const controller = new AbortController();
    await assert.rejects(replay(pkg, {
      runtime: { ...fastRuntime, signal: controller.signal },
      onProgress(event) { if (event.phase === phase && event.completed === event.total) controller.abort(); },
    }), { name: "ResearchReplayError", code: "ANALYSIS_CANCELLED" });
  }
});

test("hidden/symbol/accessor properties, exotic arrays and escaped duplicate keys cannot evade safe cloning", () => {
  let calls = 0;
  for (const input of [
    Object.defineProperty({}, "hidden", { get() { calls += 1; return true; } }),
    Object.defineProperty({}, "hidden", { value: 1 }),
    { [Symbol("hidden")]: 1 }, Object.assign([], { extra: 1 }),
    Object.setPrototypeOf({}, { inherited: true }),
    Object.defineProperty([1], "0", { get() { calls += 1; return 1; } }),
  ]) rejects(input, "RESEARCH_PACKAGE_UNSAFE");
  assert.equal(calls, 0);
  rejects('{"a":1,"\\u0061":2}', "RESEARCH_PACKAGE_JSON");
  rejects('{"x":{"\\u005f_proto__":1}}', "RESEARCH_PACKAGE_UNSAFE");
  rejects("[".repeat(66) + "0" + "]".repeat(66), "RESEARCH_PACKAGE_LIMIT");
  rejects("[" + "null,".repeat(1_000_000) + "null]", "RESEARCH_PACKAGE_LIMIT");
  rejects('["字"]' + " ".repeat(32 * 1024 * 1024 - 6), "RESEARCH_PACKAGE_LIMIT");
});
