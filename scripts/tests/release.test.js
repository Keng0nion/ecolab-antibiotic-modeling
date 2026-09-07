import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { canonicalJson } from "../../src/analysis/fingerprint.js";

const execute = promisify(execFile);
const rootPath = fileURLToPath(new URL("../../", import.meta.url));

async function runNode(args, timeout = 60_000) {
  return execute(process.execPath, args, {
    cwd: rootPath,
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function missing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

function srgbChannel(value) {
  const normalized = value / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex) {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
  if (!match) throw new Error(`Unsupported color: ${hex}`);
  const [red, green, blue] = match.slice(1).map((component) => srgbChannel(Number.parseInt(component, 16)));
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first, second) {
  const [lighter, darker] = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (lighter + 0.05) / (darker + 0.05);
}

test("application version is consistent with the root package source of truth", async () => {
  const { stdout } = await runNode(["scripts/check-version.js"]);
  assert.match(stdout, /6\.0\.0/);
  assert.match(stdout, /analysis 2\.0\.0/i);
  assert.match(stdout, /ecolab-research-analysis-v2/);
  assert.match(stdout, /core 2\.0\.0.*model 1\.0\.0/);
});

test("Stage 6 advances application and analysis versions without renaming the stable engine or teaching core", async () => {
  const [application, analysis, model, packageText] = await Promise.all([
    import("../../src/app/version.js"),
    import("../../src/analysis/version.js"),
    import("../../src/model/version.js"),
    readFile(resolve(rootPath, "package.json"), "utf8"),
  ]);
  assert.equal(JSON.parse(packageText).version, "6.0.0");
  assert.equal(application.APPLICATION_VERSION, "6.0.0");
  assert.equal(analysis.ANALYSIS_ENGINE_VERSION, "2.0.0");
  assert.equal(analysis.ANALYSIS_ENGINE_ID, "ecolab.stage4.analysis");
  assert.equal(analysis.ANALYSIS_ENGINE_STABLE_ID, analysis.ANALYSIS_ENGINE_ID);
  assert.equal(analysis.ANALYSIS_STABLE_ID, analysis.ANALYSIS_ENGINE_ID);
  assert.equal(analysis.ANALYSIS_IMPLEMENTATION_ID, "ecolab-research-analysis-v2");
  assert.equal(analysis.ANALYSIS_ENGINE_IMPLEMENTATION_ID, analysis.ANALYSIS_IMPLEMENTATION_ID);
  assert.equal(model.ENGINE_VERSION, "2.0.0");
  assert.equal(model.IMPLEMENTATION_ID, "regoes-logistic-piecewise-analytic-v1");
  assert.equal(model.MODEL_ID, "ecolab.single-population.regoes-logistic");
});

test("dark semantic colors meet WCAG AA contrast for release-critical text", () => {
  const pairs = [
    ["primary button", "#10211c", "#8adacb"],
    ["skip link", "#10211c", "#8adacb"],
    ["warning", "#ffe3a8", "#392e18"],
    ["danger", "#ffc0ba", "#3b211f"],
    ["success", "#8fe0c4", "#174234"],
  ];
  for (const [label, foreground, background] of pairs) {
    assert.ok(contrastRatio(foreground, background) >= 4.5, `${label} contrast is below 4.5:1.`);
  }
});

test("release audit checks temporary products and writes a sorted SHA-256 manifest", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "ecolab-release-audit-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const core = resolve(temporaryRoot, "core");
  const web = resolve(temporaryRoot, "web");
  const manifest = resolve(temporaryRoot, "release-manifest.sha256");
  await runNode(["scripts/build-core.js", "--out-dir", core]);
  await runNode(["scripts/build-web.js", "--out-dir", web]);
  const { stdout } = await runNode([
    "scripts/audit-release.js",
    "--core-dir", core,
    "--web-dir", web,
    "--manifest-out", manifest,
  ]);
  assert.match(stdout, /Release audit passed/);
  const lines = (await readFile(manifest, "utf8")).trim().split("\n");
  const paths = lines.map((line) => line.slice(66));
  assert.deepEqual(paths, [...paths].sort((left, right) => left.localeCompare(right, "en")));
  assert.ok(lines.every((line) => /^[0-9a-f]{64}  (?:core|web)\//u.test(line)));
  assert.equal(paths.some((path) => /(?:^|\/)raw(?:\/|$)|(?:^|\/)tests?(?:\/|$)|\.xlsx$/iu.test(path)), false);
  assert.ok(paths.includes("web/_headers"));
});

test("Stage 6 release audit verifies actual replay science and rejects rehashed claims without requiring a winner", { timeout: 120_000 }, async (t) => {
  const fixture = await mkdtemp(resolve(tmpdir(), "ecolab-example-audit-test-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await Promise.all(["package.json", "index.html", "scripts", "src", "schemas", "data/registry", "data/datasets", "data/examples"].map(async (path) => {
    await mkdir(dirname(resolve(fixture, path)), { recursive: true });
    await cp(resolve(rootPath, path), resolve(fixture, path), {
      recursive: true, filter: (source) => !source.split(/[\\/]/u).includes("tests"),
    });
  }));
  await Promise.all([mkdir(resolve(fixture, "docs")), mkdir(resolve(fixture, "blueprints")), writeFile(resolve(fixture, "README.md"), "# Isolated release audit fixture\n")]);
  const run = (args) => execute(process.execPath, args, { cwd: fixture, timeout: 120_000, maxBuffer: 1024 * 1024 });
  await run(["scripts/generate-example-research.js"]);
  await run(["scripts/build-core.js", "--out-dir", "products/core"]);
  await run(["scripts/build-web.js", "--out-dir", "products/web"]);
  const examplePath = resolve(fixture, "data/examples/ecolab-stage6-research-6.0.0.json");
  const originalText = await readFile(examplePath, "utf8");
  const original = JSON.parse(originalText);
  const manifestPath = resolve(fixture, "products/release-manifest.sha256");
  const audit = () => run(["scripts/audit-release.js", "--core-dir", "products/core", "--web-dir", "products/web", "--manifest-out", manifestPath]);
  const scientific = (artifact) => artifact.researchPackage.contents.artifacts["scientific-result"];
  function rehash(artifact, id) {
    const pkg = artifact.researchPackage;
    const content = id === "analysis-manifest" ? pkg.contents.analysisManifest : pkg.contents.artifacts[id];
    const text = canonicalJson(content);
    const entry = pkg.artifactInventory.find(({ artifactId }) => artifactId === id);
    entry.sha256 = createHash("sha256").update(text).digest("hex");
    entry.byteLength = Buffer.byteLength(text);
    if (id === "scientific-result") artifact.scientificResultRef.sha256 = entry.sha256;
  }
  await t.test("accepts the actual new example and reports successful scientific replay", async () => {
    const { stdout } = await audit();
    assert.match(stdout, /Release audit passed for application 6\.0\.0/);
    assert.match(stdout, /strict package.*scientific replay matched/i);
    assert.ok(stdout.includes(`preset=${original.generatedFrom.preset}`));
    await access(manifestPath);
  });
  for (const [name, mutate, errorPattern] of [
    ["strict package schema", (a) => { a.researchPackage.extra = true; }, /RESEARCH_PACKAGE_SCHEMA/],
    ["inventory tampering", (a) => { a.researchPackage.artifactInventory[0].sha256 = "0".repeat(64); }, /RESEARCH_PACKAGE_INTEGRITY/],
    ["inspect-only dependencies", (a) => { a.researchPackage.replay.dependencies[0].version = "1.0.0"; }, /not replayable.*UNSUPPORTED_DEPENDENCIES/i],
    ["stale application", (a) => { a.generatedFrom.applicationVersion = "5.0.0"; }, /Example provenance/],
    ["stale analysis", (a) => { a.generatedFrom.analysisEngineVersion = "1.0.0"; }, /Example provenance/],
    ["changed teaching core", (a) => { a.generatedFrom.scientificCoreVersion = "3.0.0"; }, /Example provenance/],
    ["wrong source hash", (a) => { a.generatedFrom.dataset.normalizedJsonArtifactSha256 = "0".repeat(64); }, /Example provenance/],
    ["wrong scientific reference", (a) => { a.scientificResultRef.sha256 = "0".repeat(64); }, /Example scientific-result reference/],
    ["wrong seed", (a) => { a.generatedFrom.seed += 1; }, /Example provenance/],
    ["stale preset", (a) => { a.generatedFrom.preset = "standard"; }, /Example preset.*regenerate/i],
    ["CV score", (a) => { scientific(a).growthComparison.crossValidation.candidates.logistic.score += 0.01; rehash(a, "scientific-result"); }, /Scientific replay mismatch.*crossValidation/],
    ["selected model", (a) => { scientific(a).growthComparison.selection.selectedModel = "fabricated-model"; rehash(a, "scientific-result"); }, /Scientific replay mismatch.*selection/],
    ["development metric and matching manifest", (a) => {
      scientific(a).growthComparison.development.selected.metrics.macroRmse += 0.01;
      a.researchPackage.contents.analysisManifest.diagnostics.metrics.growthDevelopment.macroRmse += 0.01;
      rehash(a, "scientific-result"); rehash(a, "analysis-manifest");
    }, /Scientific replay mismatch.*development/],
    ["bootstrap successes", (a) => { scientific(a).growthComparison.bootstrap.successfulSamples += 1; rehash(a, "scientific-result"); }, /Scientific replay mismatch.*bootstrap/],
    ["convergence and matching manifest", (a) => {
      const result = scientific(a); result.researchAssessment.converged = !result.researchAssessment.converged;
      const convergence = a.researchPackage.contents.analysisManifest.convergence;
      convergence.converged = result.researchAssessment.converged;
      convergence.researchAssessment.converged = result.researchAssessment.converged;
      rehash(a, "scientific-result"); rehash(a, "analysis-manifest");
    }, /Scientific replay mismatch.*researchAssessment/],
    ["missing Sobol interval", (a) => {
      const parameter = Object.values(scientific(a).analyses.sensitivity.sobolJansen.byParameter)[0];
      delete Object.values(parameter.outputs)[0].firstOrderInterval; rehash(a, "scientific-result");
    }, /Scientific replay mismatch.*firstOrderInterval/],
    ["manifest training metric", (a) => {
      a.researchPackage.contents.analysisManifest.diagnostics.metrics.training.macroRmse += 0.01;
      rehash(a, "analysis-manifest");
    }, /Example manifest.*training/],
    ["historical reference hash", (a) => { a.historicalArtifacts[0].sha256 = "0".repeat(64); }, /Example historical/],
  ]) {
    await t.test(`rejects ${name}`, async () => {
      const changed = structuredClone(original); mutate(changed);
      await rm(manifestPath, { force: true });
      await writeFile(examplePath, JSON.stringify(changed));
      try {
        await assert.rejects(audit(), errorPattern);
        await missing(manifestPath);
      } finally {
        await writeFile(examplePath, originalText);
      }
    });
  }
  await t.test("accepts another genuinely computed seed without a fixed winner or sign requirement", async () => {
    const generatorPath = resolve(fixture, "scripts/generate-example-research.js");
    const generator = await readFile(generatorPath, "utf8");
    assert.ok(generator.includes("seed: 123456789"));
    await writeFile(generatorPath, generator.replace("seed: 123456789", "seed: 9127"));
    await run(["scripts/generate-example-research.js"]);
    const { stdout } = await audit();
    assert.match(stdout, /scientific replay matched/i);
  });
});

test("two clean temporary builds are reproducible and leave formal dist content untouched", async () => {
  const formalVersionPath = resolve(rootPath, "dist/web/src/app/version.js");
  let before = null;
  try {
    before = await readFile(formalVersionPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const { stdout } = await runNode(["scripts/check-reproducible-build.js"], 120_000);
  assert.match(stdout, /byte-for-byte reproducible/);
  if (before === null) {
    await missing(formalVersionPath);
  } else {
    assert.equal(await readFile(formalVersionPath, "utf8"), before);
  }
});

test("frozen Stage 5 example retains its historical L3, failed L4 gate, and negative result byte-for-byte", async () => {
  const jsonText = await readFile(resolve(rootPath, "data/examples/ecolab-stage5-small-research-5.0.0.json"), "utf8");
  const markdown = await readFile(resolve(rootPath, "data/examples/ecolab-stage5-small-research-5.0.0.md"), "utf8");
  assert.equal(createHash("sha256").update(jsonText).digest("hex"), "f3365e5c616597c042aa87eb76040b620955f4ea9e8865c77b83e5245acc41b8");
  assert.equal(createHash("sha256").update(markdown).digest("hex"), "05ca4c25a2327f81119ee7af609d2536c1ec7072f35a4532f32319406f416bbd");
  const artifact = JSON.parse(jsonText);
  assert.equal(artifact.artifactVersion, "5.0.0");
  assert.equal(artifact.generatedFrom.scientificCoreVersion, "2.0.0");
  assert.equal(artifact.generatedFrom.analysisEngineVersion, "1.0.0");
  assert.equal(artifact.generatedFrom.dataset.normalizedJsonArtifactSha256, "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817");
  assert.match(artifact.generatedFrom.dataset.normalizedCanonicalFingerprint, /^[0-9a-f]{64}$/u);
  assert.equal(Object.hasOwn(artifact.generatedFrom.dataset, "sourceContentSha256"), false);
  assert.equal(artifact.capability.level, "L3");
  assert.equal(artifact.capability.heldOutValidationEligibleForL4, false);
  assert.equal(artifact.capability.l4GatePassed, false);
  assert.equal(artifact.validation.modelWorseThanBaseline, true);
  assert.ok(artifact.validation.deltaModelMinusBaseline.macroRmse > 0);
  assert.ok(artifact.validation.deltaModelMinusBaseline.pooledRmse > 0);
  assert.match(markdown, /worse than the predeclared baseline/i);
  assert.match(markdown, /Bundled normalized JSON artifact byte SHA-256/);
  assert.match(markdown, /Original workbook SHA-256 values are separate provenance records/);
  assert.match(markdown, /L4 validation evidence eligible: \*\*no\*\*/);
  assert.match(markdown, /npm run example:research/);
});
