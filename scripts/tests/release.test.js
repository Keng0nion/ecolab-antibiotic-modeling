import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
  assert.match(stdout, /5\.0\.0/);
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

test("versioned example artifact records L3, failed L4 eligibility, and worse-than-baseline validation", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "ecolab-example-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const jsonPath = resolve(temporaryRoot, "example.json");
  const markdownPath = resolve(temporaryRoot, "example.md");
  await runNode([
    "scripts/generate-example-research.js",
    "--json-out", jsonPath,
    "--markdown-out", markdownPath,
  ], 120_000);
  const artifact = JSON.parse(await readFile(jsonPath, "utf8"));
  const markdown = await readFile(markdownPath, "utf8");
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
