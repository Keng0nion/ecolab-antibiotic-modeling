import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertKnownOptions, resolveDirectoryOption } from "./lib/release-utils.js";

const rootUrl = new URL("../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);
const args = process.argv.slice(2);
assertKnownOptions(args, ["--out-dir"]);
const distPath = resolveDirectoryOption(args, "--out-dir", "dist/core", rootPath);
const dist = pathToFileURL(`${distPath}/`);
const packageName = "@ecolab/scientific-core";
const rootPackage = JSON.parse(await readFile(new URL("package.json", rootUrl), "utf8"));
const packageVersion = rootPackage.version;
if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageVersion)) {
  throw new Error("The root package.json version must be a valid semantic version.");
}

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
  throw new Error(`${label} must not be included in the scientific core package.`);
}

await rm(distPath, { recursive: true, force: true });
await mkdir(distPath, { recursive: true });

await Promise.all([
  cp(new URL("src/model/", rootUrl), new URL("model/", dist), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/registry/", rootUrl), new URL("registry/", dist), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/experiment/", rootUrl), new URL("experiment/", dist), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/analysis/", rootUrl), new URL("analysis/", dist), {
    recursive: true,
    filter: excludeTests,
  }),
  cp(new URL("src/model.js", rootUrl), new URL("model.js", dist)),
  cp(new URL("src/analysis.js", rootUrl), new URL("analysis.js", dist)),
  cp(new URL("data/registry/", rootUrl), new URL("data/registry/", dist), {
    recursive: true,
  }),
  cp(new URL("data/datasets/", rootUrl), new URL("data/datasets/", dist), {
    recursive: true,
  }),
  cp(new URL("schemas/", rootUrl), new URL("schemas/", dist), { recursive: true }),
]);

await writeFile(
  new URL("package.json", dist),
  `${JSON.stringify(
    {
      name: packageName,
      version: packageVersion,
      private: true,
      type: "module",
      exports: {
        ".": "./model.js",
        "./model": "./model.js",
        "./analysis": "./analysis.js",
      },
    },
    null,
    2,
  )}\n`,
);

await Promise.all([
  access(new URL("model.js", dist)),
  access(new URL("analysis.js", dist)),
  access(new URL("analysis/index.js", dist)),
  access(new URL("analysis/research-workflow.js", dist)),
  access(new URL("analysis/growth-comparison.js", dist)),
  access(new URL("analysis/research-upgrade.js", dist)),
  access(new URL("analysis/research-replay.js", dist)),
  access(new URL("data/registry/datasets.json", dist)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", dist)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/README.md", dist)),
  access(new URL("data/datasets/figshare-bw25113-growth-v1/checksums.json", dist)),
  access(new URL("schemas/research-package.schema.json", dist)),
]);
await assertMissing(new URL("data/raw/", dist), "Raw source data");

const verificationPath = resolve(distPath, ".verify-package-entries.mjs");
await mkdir(dirname(verificationPath), { recursive: true });
await writeFile(
  verificationPath,
  `const [rootEntry, modelEntry, analysisEntry] = await Promise.all([\n`
    + `  import(${JSON.stringify(packageName)}),\n`
    + `  import(${JSON.stringify(`${packageName}/model`)}),\n`
    + `  import(${JSON.stringify(`${packageName}/analysis`)}),\n`
    + `]);\n`
    + `if (typeof rootEntry.simulatePiecewise !== "function") throw new Error("The package root does not expose the model API.");\n`
    + `if (rootEntry.simulatePiecewise !== modelEntry.simulatePiecewise) throw new Error("The root and model subpath resolve to different model APIs.");\n`
    + `if (typeof analysisEntry.runEcolabStage4ResearchWorkflow !== "function") throw new Error("The analysis subpath does not expose the Stage 4 workflow.");\n`
    + `const [growth, research, replay] = await Promise.all([import("./analysis/growth-comparison.js"), import("./analysis/research-upgrade.js"), import("./analysis/research-replay.js")]);\n`
    + `if (typeof growth.runGrowthModelComparison !== "function") throw new Error("growth-comparison.js does not expose the direct-OD comparison.");\n`
    + `if (typeof research.runEcolabResearchWorkflow !== "function") throw new Error("research-upgrade.js does not expose the v2 workflow.");\n`
    + `if (typeof replay.inspectResearchPackage !== "function") throw new Error("research-replay.js does not expose the package inspector.");\n`,
);
try {
  await import(`${pathToFileURL(verificationPath).href}?verify=${Date.now()}`);
} finally {
  await rm(verificationPath, { force: true });
}

console.log(`Scientific core ${packageVersion} built successfully in ${distPath}.`);
