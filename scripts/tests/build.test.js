import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const rootPath = fileURLToPath(new URL("../../", import.meta.url));
const researchModules = ["growth-comparison", "research-upgrade", "research-replay"];
function build(script, outPath, cwd = rootPath) {
  return execute(process.execPath, [`scripts/${script}.js`, "--out-dir", outPath], {
    cwd, timeout: 60_000, maxBuffer: 1024 * 1024,
  });
}

test("core package keeps release/core/model identities separate and includes importable v2 research modules", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "ecolab-core-build-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const corePath = resolve(temporaryRoot, "core");
  await build("build-core", corePath);
  const core = pathToFileURL(`${corePath}/`);
  const pkg = JSON.parse(await readFile(new URL("package.json", core), "utf8"));
  assert.equal(pkg.name, "@ecolab/scientific-core");
  assert.equal(pkg.version, "6.0.0");
  assert.deepEqual(Object.keys(pkg.exports).sort(), [".", "./analysis", "./model"]);
  const [model, analysis] = await Promise.all([
    import(new URL("model/version.js", core)), import(new URL("analysis/version.js", core)),
  ]);
  assert.equal(model.ENGINE_VERSION, "2.0.0");
  assert.equal(analysis.ANALYSIS_ENGINE_VERSION, "2.0.0");
  assert.equal(analysis.ANALYSIS_ENGINE_ID, "ecolab.stage4.analysis");
  assert.equal(analysis.ANALYSIS_IMPLEMENTATION_ID, "ecolab-research-analysis-v2");
  const registry = JSON.parse(await readFile(new URL("data/registry/model-definitions.json", core), "utf8"));
  assert.equal(registry.records.find(({ id }) => id === model.MODEL_ID).version, "1.0.0");
  for (const [index, symbol] of ["runGrowthModelComparison", "runEcolabResearchWorkflow", "inspectResearchPackage"].entries()) {
    const module = await import(new URL(`analysis/${researchModules[index]}.js`, core));
    assert.equal(typeof module[symbol], "function", symbol);
  }
  await assert.rejects(access(new URL(".verify-package-entries.mjs", core)), { code: "ENOENT" });
  const paths = await readdir(corePath, { recursive: true });
  assert.equal(paths.some((path) => /(?:^|[\\/])(?:raw|tests)(?:[\\/]|$)|\.xlsx$/iu.test(path)), false);
});

test("build scripts reject missing or non-importable v2 research modules rather than report release success", async (t) => {
  const fixturePath = await mkdtemp(resolve(tmpdir(), "ecolab-incomplete-build-test-"));
  t.after(() => rm(fixturePath, { recursive: true, force: true }));
  await Promise.all(["package.json", "index.html", "scripts", "src", "data/registry", "data/datasets", "schemas"].map(async (path) => {
    const destination = resolve(fixturePath, path);
    await mkdir(dirname(destination), { recursive: true });
    await cp(resolve(rootPath, path), destination, {
      recursive: true, filter: (source) => !source.split(/[\\/]/u).includes("tests"),
    });
  }));
  // Remove the full v2 layer so existing public/Worker imports also detect it after integration.
  await Promise.all(researchModules.map((name) => rm(resolve(fixturePath, `src/analysis/${name}.js`), { force: true })));
  for (const script of ["build-core", "build-web"]) {
    await t.test(script, async () => {
      await assert.rejects(build(script, resolve(fixturePath, `output-${script}`), fixturePath), /growth-comparison|research-upgrade|research-replay/);
    });
  }
});
