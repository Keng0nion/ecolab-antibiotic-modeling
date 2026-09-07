import { access, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertKnownOptions, resolveDirectoryOption } from "./lib/release-utils.js";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const args = process.argv.slice(2);
assertKnownOptions(args, ["--out-dir"]);
const webPath = resolveDirectoryOption(args, "--out-dir", "dist/web", rootPath);
const web = pathToFileURL(`${webPath}/`);

function excludeTests(source) {
  return !String(source).split(/[\\/]/u).includes("tests");
}

async function assertMissing(url, label) {
  try {
    await access(url);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`${label} must not be included in the static web build.`);
}

await rm(webPath, { recursive: true, force: true });
await Promise.all([
  mkdir(new URL("src/app/", web), { recursive: true }),
  mkdir(new URL("src/", web), { recursive: true }),
  mkdir(new URL("data/", web), { recursive: true }),
  mkdir(new URL("schemas/", web), { recursive: true }),
]);

const sourceIndex = await readFile(new URL("index.html", rootUrl), "utf8");
await writeFile(new URL("index.html", web), sourceIndex);
await Promise.all([
  cp(new URL("src/app/", rootUrl), new URL("src/app/", web), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/model/", rootUrl), new URL("src/model/", web), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/registry/", rootUrl), new URL("src/registry/", web), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/experiment/", rootUrl), new URL("src/experiment/", web), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/analysis/", rootUrl), new URL("src/analysis/", web), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/model.js", rootUrl), new URL("src/model.js", web)),
  cp(new URL("src/analysis.js", rootUrl), new URL("src/analysis.js", web)),
  cp(new URL("data/registry/", rootUrl), new URL("data/registry/", web), {
    recursive: true,
  }),
  cp(new URL("data/datasets/", rootUrl), new URL("data/datasets/", web), {
    recursive: true,
  }),
  cp(new URL("schemas/", rootUrl), new URL("schemas/", web), { recursive: true }),
  cp(new URL("scripts/static/", rootUrl), web, { recursive: true }),
]);

const index = await readFile(new URL("index.html", web), "utf8");
if (/\b(?:src|href)=["']\//u.test(index)) {
  throw new Error("Web build contains a root-absolute asset URL.");
}
if (!index.includes('./src/app/main.js') || !index.includes('./src/app/styles/app.css')) {
  throw new Error("Web entry does not reference the expected relative application assets.");
}

await Promise.all([
  access(new URL("_headers", web)),
  access(new URL("src/app/boot-watchdog.js", web)),
  access(new URL("src/app/main.js", web)),
  access(new URL("src/app/charts.js", web)),
  access(new URL("src/app/workers/analysis-worker.js", web)),
  access(new URL("src/app/workers/task-client.js", web)),
  access(new URL("src/app/workers/task-protocol.js", web)),
  access(new URL("src/model.js", web)),
  access(new URL("src/analysis.js", web)),
  access(new URL("src/analysis/index.js", web)),
  access(new URL("src/analysis/analysis-manifest.js", web)),
  access(new URL("src/analysis/analysis-plan.js", web)),
  access(new URL("src/analysis/research-workflow.js", web)),
  access(new URL("src/analysis/growth-comparison.js", web)),
  access(new URL("src/analysis/research-upgrade.js", web)),
  access(new URL("src/analysis/research-replay.js", web)),
  access(new URL("src/registry/resolve.js", web)),
  access(new URL("src/experiment/run-manifest.js", web)),
  access(new URL("data/registry/datasets.json", web)),
  access(new URL("data/registry/drugs.json", web)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", web)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/README.md", web)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/checksums.json", web)),
  access(new URL("schemas/analysis-plan.schema.json", web)),
  access(new URL("schemas/research-package.schema.json", web)),
]);
await assertMissing(new URL("data/raw/", web), "Raw source data");

const emittedPaths = await readdir(webPath, { recursive: true });
const forbiddenPath = emittedPaths.find((entry) =>
  /(?:^|[\\/])raw(?:[\\/]|$)/u.test(entry)
  || /(?:^|[\\/])tests(?:[\\/]|$)/u.test(entry)
  || /\.xlsx$/iu.test(entry));
if (forbiddenPath) throw new Error(`Web build includes a forbidden release path: ${forbiddenPath}`);

const dataset = JSON.parse(
  await readFile(
    new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", web),
    "utf8",
  ),
);
if (dataset.metadata?.datasetId !== "figshare-bw25113-growth-v1") {
  throw new Error("The normalized Stage 4 dataset is missing or has the wrong identity.");
}

const buildId = Date.now();
const [modelApi, analysisApi, researchApi, workerApi, taskClientApi, growthApi, upgradeApi, replayApi] = await Promise.all([
  import(`${new URL("src/model.js", web).href}?build=${buildId}`),
  import(`${new URL("src/analysis.js", web).href}?build=${buildId}`),
  import(`${new URL("src/analysis/research-workflow.js", web).href}?build=${buildId}`),
  import(`${new URL("src/app/workers/analysis-worker.js", web).href}?build=${buildId}`),
  import(`${new URL("src/app/workers/task-client.js", web).href}?build=${buildId}`),
  import(`${new URL("src/analysis/growth-comparison.js", web).href}?build=${buildId}`),
  import(`${new URL("src/analysis/research-upgrade.js", web).href}?build=${buildId}`),
  import(`${new URL("src/analysis/research-replay.js", web).href}?build=${buildId}`),
]);
if (typeof modelApi.simulatePiecewise !== "function") {
  throw new Error("The web model entry is not importable.");
}
if (typeof analysisApi.runEcolabStage4ResearchWorkflow !== "function") {
  throw new Error("The web analysis entry does not expose the Stage 4 workflow.");
}
if (typeof researchApi.runEcolabStage4ResearchWorkflow !== "function") {
  throw new Error("The Stage 4 research workflow module is not importable.");
}
if (typeof workerApi.dispatchTask !== "function" || typeof taskClientApi.TaskClient !== "function") {
  throw new Error("The Stage 4 Worker modules are not importable.");
}

if (typeof growthApi.runGrowthModelComparison !== "function") {
  throw new Error("growth-comparison.js does not expose the direct-OD comparison.");
}
if (typeof upgradeApi.runEcolabResearchWorkflow !== "function") {
  throw new Error("research-upgrade.js does not expose the v2 workflow.");
}
if (typeof replayApi.inspectResearchPackage !== "function") {
  throw new Error("research-replay.js does not expose the package inspector.");
}

console.log(`Browser application built successfully in ${webPath}.`);
