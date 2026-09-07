import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalJson } from "../src/analysis/fingerprint.js";
import { RNG_ALGORITHM } from "../src/analysis/random.js";
import { inspectResearchPackage, replayResearchPackage } from "../src/analysis/research-replay.js";
import { RESEARCH_WORKFLOW_IMPLEMENTATION_ID } from "../src/analysis/research-upgrade.js";
import { ANALYSIS_ENGINE_ID, ANALYSIS_ENGINE_VERSION, ANALYSIS_IMPLEMENTATION_ID } from "../src/analysis/version.js";
import { researchPreset } from "../src/app/research/state.js";
import { ENGINE_VERSION } from "../src/model/version.js";
import {
  assertKnownOptions,
  fileInventory,
  formatBytes,
  listFiles,
  resolveDirectoryOption,
  resolveFileOption,
  sha256,
  slashPath,
} from "./lib/release-utils.js";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const args = process.argv.slice(2);
assertKnownOptions(args, ["--core-dir", "--web-dir", "--manifest-out"]);
const corePath = resolveDirectoryOption(args, "--core-dir", "dist/core", rootPath);
const webPath = resolveDirectoryOption(args, "--web-dir", "dist/web", rootPath);
const manifestPath = resolveFileOption(args, "--manifest-out", "dist/release-manifest.sha256", rootPath);
const budgets = Object.freeze({
  webTotalBytes: 10 * 1024 * 1024,
  webMaximumFileBytes: 5 * 1024 * 1024,
  coreTotalBytes: 10 * 1024 * 1024,
  coreMaximumFileBytes: 5 * 1024 * 1024,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function assertExists(path, label) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${path}`);
    throw error;
  }
}

async function auditMarkdownLinks() {
  const roots = ["README.md", "docs", "blueprints", "data/examples", "data/datasets"];
  const markdownFiles = [];
  for (const entry of roots) {
    const absolute = resolve(rootPath, entry);
    const metadata = await stat(absolute);
    if (metadata.isFile()) {
      markdownFiles.push(absolute);
    } else {
      const files = await listFiles(absolute);
      markdownFiles.push(...files.filter(({ relativePath }) => extname(relativePath).toLowerCase() === ".md")
        .map(({ absolutePath }) => absolutePath));
    }
  }
  const broken = [];
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/gu;
  for (const markdownPath of markdownFiles.sort()) {
    const text = await readFile(markdownPath, "utf8");
    for (const match of text.matchAll(pattern)) {
      let target = match[1].trim();
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      target = target.split(/\s+["']/u, 1)[0];
      if (/^(?:https?:|mailto:|tel:|data:)/iu.test(target) || target.startsWith("#")) continue;
      const pathPart = target.split("#", 1)[0].split("?", 1)[0];
      if (!pathPart) continue;
      const resolvedTarget = resolve(dirname(markdownPath), decodeURIComponent(pathPart));
      try {
        await access(resolvedTarget);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        broken.push(`${slashPath(relative(rootPath, markdownPath))} -> ${target}`);
      }
    }
  }
  assert(broken.length === 0, `Broken local Markdown links:\n${broken.join("\n")}`);
  return markdownFiles.length;
}

function assertSame(actual, expected, label) {
  assert(actual !== undefined && expected !== undefined && canonicalJson(actual) === canonicalJson(expected),
    `${label} differs from the recorded inputs or computed scientific result.`);
}

function assertPreset(actual, expected, path = "options") {
  // Presets may omit fields that the versioned workflow resolves to explicit defaults.
  if (expected !== null && typeof expected === "object" && !Array.isArray(expected)) {
    for (const [key, value] of Object.entries(expected)) assertPreset(actual?.[key], value, `${path}.${key}`);
  } else {
    assert(actual !== undefined && canonicalJson(actual) === canonicalJson(expected),
      `Example preset is stale at ${path}; regenerate with npm run example:research after the preset is stable.`);
  }
}

async function auditPortfolioExample(packageVersion) {
  const path = resolve(rootPath, `data/examples/ecolab-stage6-research-${packageVersion}.json`);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  assert(artifact.schemaVersion === "1.0.0" && artifact.kind === "ecolab-stage6-research-example",
    "Example must use the Stage 6 example wrapper schema.");
  assertSame(artifact.artifactVersion, packageVersion, "Example provenance artifactVersion");
  let inspected;
  try {
    inspected = inspectResearchPackage(artifact.researchPackage);
  } catch (error) {
    throw new Error(`Example strict package inspection failed: ${error.code} at ${error.path}: ${error.message}`, { cause: error });
  }
  assert(inspected.replayable, `Example is not replayable: ${inspected.reasons.map(({ code, message }) => `${code}: ${message}`).join("; ")}`);
  const pkg = inspected.researchPackage;
  const { analysisManifest: manifest, artifacts } = pkg.contents;
  const input = artifacts["research-replay-input"];
  const options = input.options;
  const result = artifacts["scientific-result"];
  const dataset = artifacts["normalized-observation-dataset"];
  const scientificReference = pkg.artifactInventory.find(({ artifactId }) => artifactId === "scientific-result");
  assertSame(artifact.scientificResultRef, { artifactId: scientificReference.artifactId, sha256: scientificReference.sha256 },
    "Example scientific-result reference");

  const datasetPath = "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json";
  const checksumsPath = "data/datasets/figshare-bw25113-growth-v1/checksums.json";
  const [datasetText, checksumsText] = await Promise.all([
    readFile(resolve(rootPath, datasetPath), "utf8"), readFile(resolve(rootPath, checksumsPath), "utf8"),
  ]);
  const checksums = JSON.parse(checksumsText);
  const contentHash = sha256(datasetText);
  assertSame(contentHash, checksums.normalizedDataSha256, "Example provenance source checksum");
  assertSame(options.datasetInput, datasetText, "Example provenance embedded source text");
  assertSame(options.contentHash, contentHash, "Example provenance embedded source hash");
  assertSame(options.datasetVersion, checksums.datasetVersion, "Example provenance dataset version");
  const provenance = {
    applicationVersion: packageVersion, scientificCoreVersion: ENGINE_VERSION, analysisEngineVersion: ANALYSIS_ENGINE_VERSION,
    analysisEngineId: ANALYSIS_ENGINE_ID, analysisImplementationId: ANALYSIS_IMPLEMENTATION_ID,
    workflowImplementationId: RESEARCH_WORKFLOW_IMPLEMENTATION_ID, model: manifest.model,
    seed: options.seed, seeds: { algorithm: RNG_ALGORITHM, ...options.seeds }, runId: options.runId, createdAt: options.createdAt,
    dataset: {
      id: manifest.dataset.id, version: options.datasetVersion, path: datasetPath,
      normalizedJsonArtifactSha256: contentHash, normalizedCanonicalFingerprint: sha256(canonicalJson(dataset)),
      observationCount: dataset.observations.length,
      trainingObservationCount: dataset.observations.filter(({ role }) => role === "training").length,
      developmentObservationCount: dataset.observations.filter(({ role }) => role === "validation").length,
      sourceEvaluationRole: "validation", evaluationRole: "development_comparison", previouslyViewed: true,
    },
  };
  for (const [key, expected] of Object.entries(provenance)) assertSame(artifact.generatedFrom?.[key], expected, `Example provenance ${key}`);
  assertSame(artifact.sourceProvenance?.checksumsPath, checksumsPath, "Example provenance checksums path");
  assertSame(artifact.sourceProvenance?.checksumsSha256, sha256(checksumsText), "Example provenance checksums hash");
  assertSame(artifact.sourceProvenance?.source, checksums.source, "Example provenance original source declarations");
  assert(/not recomputed/iu.test(artifact.sourceProvenance?.workbookHashStatus ?? ""), "Example provenance must distinguish declared workbook hashes from recomputed input hashes.");
  assert(artifact.reproduction?.command === "npm run example:research", "Example must include its reproduction command.");
  assert(pkg.replay.selfContained === false && /data-self-contained/iu.test(artifact.reproduction?.statement ?? "")
    && /not a standalone executable/iu.test(artifact.reproduction.statement) && /exact built-in software/iu.test(artifact.reproduction.statement),
  "Example must describe data-self-contained inputs with exact built-in software dependencies, not a standalone executable.");
  let preset;
  try {
    preset = researchPreset(artifact.generatedFrom.preset);
  } catch (error) {
    throw new Error("Example preset is unknown; regenerate with npm run example:research.", { cause: error });
  }
  assertPreset(options, preset);

  const historical = [
    ["data/examples/ecolab-stage5-small-research-5.0.0.json", "f3365e5c616597c042aa87eb76040b620955f4ea9e8865c77b83e5245acc41b8"],
    ["data/examples/ecolab-stage5-small-research-5.0.0.md", "05ca4c25a2327f81119ee7af609d2536c1ec7072f35a4532f32319406f416bbd"],
  ];
  assert(Array.isArray(artifact.historicalArtifacts) && artifact.historicalArtifacts.length === historical.length,
    "Example historical references must retain both frozen Stage 5 artifacts.");
  for (const [historicalPath, expectedHash] of historical) {
    const actualHash = sha256(await readFile(resolve(rootPath, historicalPath)));
    assertSame(actualHash, expectedHash, `Example historical bytes ${historicalPath}`);
    assertSame(artifact.historicalArtifacts.find((entry) => entry.path === historicalPath), {
      path: historicalPath, artifactVersion: "5.0.0", sha256: actualHash, status: "frozen_historical_record_not_regenerated",
    }, `Example historical reference ${historicalPath}`);
  }

  for (const [name, metrics] of Object.entries({
    training: result.training?.metrics, development: result.validation?.metrics,
    growthDevelopment: result.growthComparison?.development?.selected?.metrics,
  })) assertSame(manifest.diagnostics.metrics?.[name], metrics, `Example manifest metrics.${name}`);
  assertSame(manifest.convergence, { converged: result.researchAssessment?.converged, researchAssessment: result.researchAssessment }, "Example manifest convergence");
  assertSame(manifest.diagnostics.identifiability, result.identifiability, "Example manifest identifiability");
  assertSame(manifest.capabilityAssessment, result.capability, "Example manifest capability");
  assertSame(manifest.warnings, result.warnings, "Example manifest warnings");

  // Matching rehashed artifacts is not scientific validation: execute the embedded
  // settings and compare every scientific field, including failed/imprecise results.
  const replay = await replayResearchPackage(pkg, { absoluteTolerance: 1e-10, relativeTolerance: 1e-8 });
  assert(replay.matched, `Scientific replay mismatch (${replay.comparison.mismatchCount}): ${replay.comparison.mismatchPaths.join(", ")}`);
  return { preset: artifact.generatedFrom.preset, presetFingerprint: sha256(canonicalJson(preset)), scientificSha256: scientificReference.sha256 };
}

async function auditInlineHandlers() {
  const sourceFiles = [resolve(rootPath, "index.html")];
  const appFiles = await listFiles(resolve(rootPath, "src/app"));
  sourceFiles.push(...appFiles
    .filter(({ relativePath }) =>
      !/(?:^|\/)tests(?:\/|$)/u.test(relativePath)
      && [".html", ".js"].includes(extname(relativePath).toLowerCase()))
    .map(({ absolutePath }) => absolutePath));
  const webFiles = await listFiles(webPath);
  sourceFiles.push(...webFiles
    .filter(({ relativePath }) => [".html", ".js"].includes(extname(relativePath).toLowerCase()))
    .map(({ absolutePath }) => absolutePath));
  const violations = [];
  const pattern = /<[^>]*\s(on[a-z][a-z0-9_-]*)\s*=/giu;
  for (const path of sourceFiles) {
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(pattern)) {
      violations.push(`${slashPath(relative(rootPath, path))}: ${match[1]}`);
    }
  }
  assert(violations.length === 0, `Inline event handlers are forbidden:\n${violations.join("\n")}`);
}

function assertForbiddenPaths(inventory) {
  const forbidden = inventory.filter(({ path }) =>
    /(?:^|\/)raw(?:\/|$)/u.test(path)
    || /(?:^|\/)tests?(?:\/|$)/u.test(path)
    || /\.xlsx$/iu.test(path));
  assert(forbidden.length === 0, `Forbidden release paths:\n${forbidden.map(({ path }) => path).join("\n")}`);
}

function assertBudget(label, inventory, totalBudget, maximumFileBudget) {
  const total = inventory.reduce((sum, file) => sum + file.bytes, 0);
  const largest = [...inventory].sort((left, right) => right.bytes - left.bytes)[0];
  assert(total <= totalBudget, `${label} total ${formatBytes(total)} exceeds ${formatBytes(totalBudget)}.`);
  assert(largest.bytes <= maximumFileBudget,
    `${label} file ${largest.path} is ${formatBytes(largest.bytes)}, above ${formatBytes(maximumFileBudget)}.`);
  return { total, largest };
}

await Promise.all([
  assertExists(corePath, "Core release directory"),
  assertExists(webPath, "Web release directory"),
]);
await Promise.all([
  assertExists(resolve(corePath, "package.json"), "Core package metadata"),
  assertExists(resolve(corePath, "model.js"), "Core model entry"),
  assertExists(resolve(corePath, "analysis.js"), "Core analysis entry"),
  assertExists(resolve(webPath, "index.html"), "Web entry"),
  assertExists(resolve(webPath, "_headers"), "Static deployment headers"),
  assertExists(resolve(webPath, "src/app/version.js"), "Built application version module"),
  assertExists(resolve(webPath, "src/app/workers/analysis-worker.js"), "Built module Worker"),
]);

const [packageJson, corePackageJson, sourceVersion, builtVersion, headers, markdownCount] = await Promise.all([
  readFile(resolve(rootPath, "package.json"), "utf8").then(JSON.parse),
  readFile(resolve(corePath, "package.json"), "utf8").then(JSON.parse),
  import(`${pathToFileURL(resolve(rootPath, "src/app/version.js")).href}?audit=${Date.now()}`),
  import(`${pathToFileURL(resolve(webPath, "src/app/version.js")).href}?audit=${Date.now()}`),
  readFile(resolve(webPath, "_headers"), "utf8"),
  auditMarkdownLinks(),
  auditInlineHandlers(),
]);
assert(packageJson.version === "6.0.0", `Stage 6 release must be 6.0.0, found ${packageJson.version}.`);
assert(sourceVersion.APPLICATION_VERSION === packageJson.version, "Source application version differs from package.json.");
assert(builtVersion.APPLICATION_VERSION === packageJson.version, "Built application version differs from package.json.");
assert(corePackageJson.version === packageJson.version, "Built core package version differs from package.json.");
const example = await auditPortfolioExample(packageJson.version);
assert(!/unsafe-inline/iu.test(headers), "CSP must not use unsafe-inline.");
assert(/worker-src\s+'self'/iu.test(headers), "CSP must allow same-origin module Workers.");
assert(/navigate-to[^\n;]*\bblob:/iu.test(headers), "CSP must permit blob downloads.");
assert(/object-src\s+'none'/iu.test(headers), "CSP must block plugin objects.");

const [modelVersion, analysisVersion] = await Promise.all([
  import(`${pathToFileURL(resolve(webPath, "src/model/version.js")).href}?audit=${Date.now()}`),
  import(`${pathToFileURL(resolve(webPath, "src/analysis/version.js")).href}?audit=${Date.now()}`),
]);
assert(ENGINE_VERSION === "2.0.0" && modelVersion.ENGINE_VERSION === ENGINE_VERSION, "Scientific core engine must remain at 2.0.0 in Stage 6.");
assert(ANALYSIS_ENGINE_VERSION === "2.0.0" && analysisVersion.ANALYSIS_ENGINE_VERSION === ANALYSIS_ENGINE_VERSION, "Stage 6 analysis engine must be 2.0.0.");
assert(ANALYSIS_ENGINE_ID === "ecolab.stage4.analysis" && analysisVersion.ANALYSIS_ENGINE_ID === ANALYSIS_ENGINE_ID, "The stable analysis engine ID must remain ecolab.stage4.analysis.");
assert(ANALYSIS_IMPLEMENTATION_ID === "ecolab-research-analysis-v2" && analysisVersion.ANALYSIS_IMPLEMENTATION_ID === ANALYSIS_IMPLEMENTATION_ID, "Stage 6 must use the ecolab-research-analysis-v2 implementation.");

const [coreInventory, webInventory] = await Promise.all([
  fileInventory(corePath, "core"),
  fileInventory(webPath, "web"),
]);
const inventory = [...coreInventory, ...webInventory].sort((left, right) => left.path.localeCompare(right.path, "en"));
assertForbiddenPaths(inventory);
const coreBudget = assertBudget("dist/core", coreInventory, budgets.coreTotalBytes, budgets.coreMaximumFileBytes);
const webBudget = assertBudget("dist/web", webInventory, budgets.webTotalBytes, budgets.webMaximumFileBytes);
const manifest = `${inventory.map(({ sha256, path }) => `${sha256}  ${path}`).join("\n")}\n`;
await mkdir(dirname(manifestPath), { recursive: true });
await writeFile(manifestPath, manifest);

console.log(`Release audit passed for application ${packageJson.version}.`);
console.log(`Example: strict package inspection passed; scientific replay matched (abs=1e-10, rel=1e-8); preset=${example.preset}; preset SHA-256=${example.presetFingerprint}; scientific SHA-256=${example.scientificSha256}.`);
console.log(`Markdown files checked: ${markdownCount}.`);
console.log(`Core: ${formatBytes(coreBudget.total)} total; largest ${coreBudget.largest.path} at ${formatBytes(coreBudget.largest.bytes)}.`);
console.log(`Web: ${formatBytes(webBudget.total)} total; largest ${webBudget.largest.path} at ${formatBytes(webBudget.largest.bytes)}.`);
console.log(`Sorted SHA-256 manifest: ${slashPath(relative(rootPath, manifestPath))}.`);
