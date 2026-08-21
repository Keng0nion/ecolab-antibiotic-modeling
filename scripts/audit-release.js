import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertKnownOptions,
  fileInventory,
  formatBytes,
  listFiles,
  resolveDirectoryOption,
  resolveFileOption,
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

async function auditPortfolioExample(packageVersion) {
  const path = resolve(rootPath, `data/examples/ecolab-stage5-small-research-${packageVersion}.json`);
  const artifact = JSON.parse(await readFile(path, "utf8"));
  assert(artifact.artifactVersion === packageVersion, "Portfolio example version differs from package.json.");
  assert(artifact.generatedFrom?.applicationVersion === packageVersion, "Portfolio example application version is stale.");
  assert(artifact.generatedFrom?.scientificCoreVersion === "2.0.0", "Portfolio example must retain scientific core 2.0.0.");
  assert(artifact.generatedFrom?.analysisEngineVersion === "1.0.0", "Portfolio example must retain analysis engine 1.0.0.");
  assert(artifact.generatedFrom?.dataset?.normalizedJsonArtifactSha256 === "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817", "Portfolio example must label the bundled normalized JSON artifact hash explicitly.");
  assert(/^[0-9a-f]{64}$/u.test(artifact.generatedFrom?.dataset?.normalizedCanonicalFingerprint ?? ""), "Portfolio example must include the normalized canonical dataset fingerprint.");
  assert(!Object.hasOwn(artifact.generatedFrom?.dataset ?? {}, "sourceContentSha256"), "Portfolio example must not ambiguously label the normalized JSON artifact hash as a source-file hash.");
  assert(artifact.capability?.level === "L3", "Portfolio example must report L3 capability.");
  assert(artifact.capability?.heldOutValidationEligibleForL4 === false, "Portfolio example must remain L4-ineligible.");
  assert(artifact.capability?.l4GatePassed === false, "Portfolio example must record the failed L4 gate.");
  assert(artifact.validation?.modelWorseThanBaseline === true, "Portfolio example must retain the worse-than-baseline result.");
  assert(artifact.validation?.deltaModelMinusBaseline?.macroRmse > 0, "Portfolio example macro RMSE must be worse than baseline.");
  assert(artifact.validation?.deltaModelMinusBaseline?.pooledRmse > 0, "Portfolio example pooled RMSE must be worse than baseline.");
  assert(artifact.reproduction?.command === "npm run example:research", "Portfolio example must include its reproduction command.");
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
assert(packageJson.version === "5.0.0", `Stage 5 release must be 5.0.0, found ${packageJson.version}.`);
assert(sourceVersion.APPLICATION_VERSION === packageJson.version, "Source application version differs from package.json.");
assert(builtVersion.APPLICATION_VERSION === packageJson.version, "Built application version differs from package.json.");
assert(corePackageJson.version === packageJson.version, "Built core package version differs from package.json.");
await auditPortfolioExample(packageJson.version);
assert(!/unsafe-inline/iu.test(headers), "CSP must not use unsafe-inline.");
assert(/worker-src\s+'self'/iu.test(headers), "CSP must allow same-origin module Workers.");
assert(/navigate-to[^\n;]*\bblob:/iu.test(headers), "CSP must permit blob downloads.");
assert(/object-src\s+'none'/iu.test(headers), "CSP must block plugin objects.");

const [modelVersion, analysisVersion] = await Promise.all([
  import(`${pathToFileURL(resolve(webPath, "src/model/version.js")).href}?audit=${Date.now()}`),
  import(`${pathToFileURL(resolve(webPath, "src/analysis/version.js")).href}?audit=${Date.now()}`),
]);
assert(modelVersion.ENGINE_VERSION === "2.0.0", "Scientific core engine must remain at 2.0.0 in Stage 5.");
assert(analysisVersion.ANALYSIS_ENGINE_VERSION === "1.0.0", "Analysis engine must remain at 1.0.0 in Stage 5.");

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
console.log(`Markdown files checked: ${markdownCount}.`);
console.log(`Core: ${formatBytes(coreBudget.total)} total; largest ${coreBudget.largest.path} at ${formatBytes(coreBudget.largest.bytes)}.`);
console.log(`Web: ${formatBytes(webBudget.total)} total; largest ${webBudget.largest.path} at ${formatBytes(webBudget.largest.bytes)}.`);
console.log(`Sorted SHA-256 manifest: ${slashPath(relative(rootPath, manifestPath))}.`);
