import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { researchPreset } from "../../src/app/research/state.js";
import { canonicalJson } from "../../src/analysis/fingerprint.js";

const execute = promisify(execFile);
const rootPath = fileURLToPath(new URL("../../", import.meta.url));
const historicalPaths = [
  "data/examples/ecolab-stage5-small-research-5.0.0.json",
  "data/examples/ecolab-stage5-small-research-5.0.0.md",
];
const defaultPaths = [
  "data/examples/ecolab-stage6-research-6.0.0.json",
  "data/examples/ecolab-stage6-research-6.0.0.md",
];
const datasetPath = "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json";
const checksumsPath = "data/datasets/figshare-bw25113-growth-v1/checksums.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
let fixturePath;
let historicalBytes;
let generated;

before(async () => {
  fixturePath = await mkdtemp(resolve(tmpdir(), "ecolab-generator-test-"));
  const inputs = ["package.json", "scripts/generate-example-research.js", "scripts/lib", "src", "data/registry", "data/datasets", "data/examples"];
  await Promise.all(inputs.map(async (path) => {
    const destination = resolve(fixturePath, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(rootPath, path), destination, {
      recursive: true,
      filter: (source) => !source.split(/[\\/]/u).includes("tests"),
    });
  }));
  historicalBytes = await Promise.all(historicalPaths.map((path) => readFile(resolve(fixturePath, path))));
});
after(async () => { if (fixturePath) await rm(fixturePath, { recursive: true, force: true }); });

function run(args = []) {
  return execute(process.execPath, ["scripts/generate-example-research.js", ...args], {
    cwd: fixturePath, timeout: 120_000, maxBuffer: 1024 * 1024,
  });
}
async function assertHistoricalUnchanged() {
  for (const [index, path] of historicalPaths.entries()) {
    assert.deepEqual(await readFile(resolve(fixturePath, path)), historicalBytes[index], path);
  }
}
async function example() {
  generated ??= (async () => {
    const jsonPath = resolve(fixturePath, "custom output", "actual.json");
    const markdownPath = resolve(fixturePath, "custom output", "actual.md");
    await run(["--json-out", jsonPath, "--markdown-out", markdownPath]);
    return {
      artifact: JSON.parse(await readFile(jsonPath, "utf8")),
      markdown: await readFile(markdownPath, "utf8"),
    };
  })();
  return generated;
}

test("default generation creates only the new Stage 6 paths and preserves both historical files", async () => {
  const { stdout } = await run();
  for (const path of defaultPaths) assert.ok(stdout.includes(path), `Default output must be ${path}`);
  await Promise.all(defaultPaths.map((path) => access(resolve(fixturePath, path))));
  await assertHistoricalUnchanged();
});

test("both explicit output flags support absolute paths and produce a versioned exact-input package", async () => {
  const { artifact, markdown } = await example();
  assert.equal(artifact.kind, "ecolab-stage6-research-example");
  assert.equal(artifact.artifactVersion, "6.0.0");
  const origin = artifact.generatedFrom;
  assert.equal(origin.applicationVersion, "6.0.0");
  assert.equal(origin.scientificCoreVersion, "2.0.0");
  assert.equal(origin.analysisEngineVersion, "2.0.0");
  assert.equal(origin.analysisEngineId, "ecolab.stage4.analysis");
  assert.equal(origin.analysisImplementationId, "ecolab-research-analysis-v2");
  assert.equal(origin.workflowImplementationId, "ecolab-research-development-v2");
  assert.equal(origin.model.version, "1.0.0");
  assert.equal(origin.preset, "small");
  assert.equal(origin.seed, 123456789);
  const pkg = artifact.researchPackage;
  const replay = pkg.contents.artifacts["research-replay-input"];
  assert.equal(replay.implementationId, origin.workflowImplementationId);
  assert.equal(replay.options.runId, "ecolab-stage6-research-6.0.0");
  assert.equal(replay.options.createdAt, "2026-09-07T12:00:00.000Z");
  assert.equal(replay.options.applicationVersion, origin.applicationVersion);
  assert.deepEqual(replay.options.optimizer, researchPreset("small").optimizer);
  const preset = researchPreset("small");
  for (const [key, value] of Object.entries(preset)) {
    if (key !== "growthComparison") assert.deepEqual(replay.options[key], value, key);
  }
  for (const key of ["bounds", "optimizer", "bootstrap"]) assert.deepEqual(replay.options.growthComparison[key], preset.growthComparison[key], key);
  assert.equal(replay.options.growthComparison.crossValidation.tieTolerance, preset.growthComparison.crossValidation.tieTolerance);
  assert.deepEqual(replay.options.growthComparison.crossValidation.folds, artifact.researchPackage.contents.artifacts["scientific-result"].growthComparison.configuration.crossValidation.folds);
  assert.equal(pkg.replay.selfContained, false);
  assert.ok(pkg.replay.dependencies.length >= 2);
  assert.ok(pkg.replay.dependencies.every(({ requirement }) => requirement === "exact"));
  assert.ok(pkg.replay.dependencies.some(({ id, version }) => id === origin.analysisImplementationId && version === "2.0.0"));
  assert.match(markdown, /data-self-contained/i);
  assert.match(markdown, /exact built-in software/i);
  assert.match(markdown, /not a standalone executable/i);
  assert.match(markdown, /no imported code.*network fetch/i);
  await assertHistoricalUnchanged();
});

test("generated provenance contains actual byte hashes, canonical hashes, seeds, attribution and frozen history references", async () => {
  const { artifact, markdown } = await example();
  assert.ok(artifact.researchPackage, "The new example must retain the replay package");
  const sourceText = await readFile(resolve(fixturePath, datasetPath), "utf8");
  const checksumsText = await readFile(resolve(fixturePath, checksumsPath), "utf8");
  const checksums = JSON.parse(checksumsText);
  const { contents, artifactInventory } = artifact.researchPackage;
  const input = contents.artifacts["research-replay-input"].options;
  const result = contents.artifacts["scientific-result"];
  assert.equal(input.datasetInput, sourceText);
  assert.equal(input.contentHash, sha256(sourceText));
  assert.equal(artifact.generatedFrom.dataset.normalizedJsonArtifactSha256, sha256(sourceText));
  assert.equal(artifact.generatedFrom.dataset.normalizedCanonicalFingerprint, result.dataset.normalizedDatasetFingerprint);
  assert.equal(artifact.generatedFrom.dataset.normalizedCanonicalFingerprint, sha256(canonicalJson(contents.artifacts["normalized-observation-dataset"])));
  assert.deepEqual(artifact.generatedFrom.seeds, result.seeds);
  assert.equal(artifact.generatedFrom.seeds.sobolBootstrap, result.analyses.sensitivity.sobolJansen.bootstrap.seed);
  assert.equal(artifact.generatedFrom.seeds.growthComparison, result.growthComparison.configuration.seed);
  assert.equal(artifact.sourceProvenance.checksumsSha256, sha256(checksumsText));
  assert.deepEqual(artifact.sourceProvenance.source, checksums.source);
  assert.match(artifact.sourceProvenance.workbookHashStatus, /not recomputed/i);
  assert.ok(markdown.includes(checksums.source.attribution));
  for (const [index, path] of historicalPaths.entries()) {
    const history = artifact.historicalArtifacts.find((entry) => entry.path === path);
    assert.equal(history.artifactVersion, "5.0.0");
    assert.equal(history.sha256, sha256(historicalBytes[index]));
    assert.ok(markdown.includes(path));
  }
  for (const entry of artifactInventory) {
    const value = entry.artifactId === "analysis-manifest" ? contents.analysisManifest
      : entry.artifactId === "methods-summary" ? contents.methodsSummaryMarkdown : contents.artifacts[entry.artifactId];
    const text = typeof value === "string" ? value : canonicalJson(value);
    assert.equal(entry.sha256, sha256(text), entry.artifactId);
    assert.equal(entry.byteLength, Buffer.byteLength(text), entry.artifactId);
  }
  const reference = artifactInventory.find(({ artifactId }) => artifactId === "scientific-result");
  assert.deepEqual(artifact.scientificResultRef, { artifactId: reference.artifactId, sha256: reference.sha256 });
});

test("actual sensitivity, training-only CV, development, paired bootstrap and convergence diagnostics are retained without winner assertions", async () => {
  const { artifact, markdown } = await example();
  assert.ok(artifact.researchPackage, "The new workflow's scientific result must be retained");
  const result = artifact.researchPackage.contents.artifacts["scientific-result"];
  const growth = result.growthComparison;
  assert.equal(result.validation.role, "development_comparison");
  assert.equal(result.validation.untouched, false);
  assert.equal(result.validation.previouslyViewed, true);
  assert.equal(growth.development.observationRoleUsed, "validation");
  assert.equal(growth.development.eligibleAsValidationEvidence, false);
  assert.equal(growth.crossValidation.sourceRole, "training");
  assert.equal(growth.selection.frozenBeforeDevelopment, true);
  for (const candidate of Object.values(growth.crossValidation.candidates)) {
    assert.ok(candidate.folds.length > 1);
    assert.ok(candidate.folds.every(({ fit }) => typeof fit.converged === "boolean"));
    assert.ok(markdown.includes(String(candidate.score)));
  }
  for (const field of ["macroRmse", "pooledRmse", "mae"]) {
    assert.ok(Number.isFinite(growth.development.selected.metrics[field]));
    assert.ok(markdown.includes(String(growth.development.selected.metrics[field])));
    assert.ok(markdown.includes(String(growth.development.baseline.metrics[field])));
    assert.ok(markdown.includes(String(result.validation.metrics[field])));
  }
  assert.ok(markdown.includes(String(growth.development.deltaMacroRmseVsBaseline)));
  assert.equal(growth.bootstrap.paired, true);
  assert.equal(growth.bootstrap.sourceRole, "training");
  assert.equal(growth.bootstrap.jointSamplesRetained, true);
  assert.equal(growth.bootstrap.samples.length, growth.bootstrap.requestedSamples);
  assert.equal(growth.bootstrap.successfulSamples + growth.bootstrap.failures.length, growth.bootstrap.requestedSamples);
  assert.ok(growth.bootstrap.requestedSamples > 0);
  assert.ok(Object.hasOwn(growth.bootstrap.intervals, "precisionAssessed"));
  assert.ok(result.analyses.sensitivity.morris.byParameter);
  const sobol = result.analyses.sensitivity.sobolJansen;
  assert.ok(sobol.bootstrap.replicates > 0);
  for (const parameter of Object.values(sobol.byParameter)) for (const output of Object.values(parameter.outputs)) {
    for (const key of ["firstOrder", "totalOrder", "firstOrderInterval", "totalOrderInterval", "precision"]) assert.ok(Object.hasOwn(output, key), key);
    assert.ok(markdown.includes(String(output.firstOrder)));
    assert.ok(markdown.includes(String(output.totalOrder)));
  }
  for (const key of ["completed", "converged", "identified", "precisionAssessed"]) {
    assert.equal(typeof result.researchAssessment[key], "boolean");
    assert.ok(markdown.includes(`${key}=\`${result.researchAssessment[key]}\``));
  }
  assert.ok(result.training.optimization.restarts.length > 0);
  assert.ok(result.identifiability.objectiveSlices.length > 0);
  for (const { code, message } of result.warnings) {
    assert.ok(markdown.includes(code), code);
    assert.ok(markdown.includes(message), code);
  }
  assert.match(markdown, /source role.*`validation`.*development/i);
  assert.match(markdown, /not untouched or external validation/i);
  assert.doesNotMatch(markdown, /model is \*\*(?:worse|better) than|L4 validation evidence eligible: \*\*yes|untouched=true/i);
});

test("relative equals-form paths resolve from the project and the companion link works across directories", async () => {
  const jsonPath = "relative outputs/数据/result (#1).json";
  const markdownPath = "relative reports/report.md";
  await run([`--json-out=${jsonPath}`, `--markdown-out=${markdownPath}`]);
  const markdown = await readFile(resolve(fixturePath, markdownPath), "utf8");
  const match = markdown.match(/\[the companion JSON\]\(([^)]+)\)/u);
  assert.ok(match, "Companion JSON must be linked from its actual Markdown directory");
  assert.equal(resolve(dirname(resolve(fixturePath, markdownPath)), decodeURIComponent(match[1])), resolve(fixturePath, jsonPath));
  assert.deepEqual(JSON.parse(await readFile(resolve(fixturePath, jsonPath), "utf8")), (await example()).artifact);
  await assertHistoricalUnchanged();
});

test("either output flag refuses either historical path, including normalized relative aliases, before writing its companion", async (t) => {
  for (const [flagIndex, flag] of ["--json-out", "--markdown-out"].entries()) {
    for (const [index, path] of historicalPaths.entries()) {
      await t.test(`${flag}: ${path}`, async () => {
        const companion = resolve(fixturePath, `rejected-${flagIndex}-${index}.out`);
        const otherFlag = flag === "--json-out" ? "--markdown-out" : "--json-out";
        const destination = flagIndex === 0 ? resolve(fixturePath, path) : path.replace("data/examples/", "data/examples/../examples/");
        await assert.rejects(run([flag, destination, otherFlag, companion]), /reserved historical artifact/i);
        await assert.rejects(access(companion), { code: "ENOENT" });
        await assertHistoricalUnchanged();
      });
    }
  }
});

test("historical output protection covers symlink files, symlink parents and hard links", async (t) => {
  const fileAlias = resolve(fixturePath, "historical-symlink.json");
  const directoryAlias = resolve(fixturePath, "historical-directory");
  const hardAlias = resolve(fixturePath, "historical-hardlink.md");
  await symlink(resolve(fixturePath, historicalPaths[0]), fileAlias);
  await symlink(resolve(fixturePath, "data/examples"), directoryAlias);
  await link(resolve(fixturePath, historicalPaths[1]), hardAlias);
  for (const [index, destination] of [fileAlias, resolve(directoryAlias, "ecolab-stage5-small-research-5.0.0.json"), hardAlias].entries()) {
    await t.test(`historical alias ${index}`, async () => {
      const companion = resolve(fixturePath, `rejected-alias-${index}.md`);
      await assert.rejects(run(["--json-out", destination, "--markdown-out", companion]), /reserved historical artifact/i);
      await assert.rejects(access(companion), { code: "ENOENT" });
      await assertHistoricalUnchanged();
    });
  }
});

test("colliding output destinations and malformed CLI flags are rejected before generation", async (t) => {
  const collision = resolve(fixturePath, "collision", "same.out");
  for (const args of [
    ["--json-out", collision, "--markdown-out", collision],
    ["--json-out"], ["--markdown-out="], ["--unknown", "output"],
    ["--json-out", collision, "--json-out", `${collision}.other`],
  ]) {
    await t.test(args.join(" "), async () => { await assert.rejects(run(args)); });
  }
  await assert.rejects(access(collision), { code: "ENOENT" });
});
