import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const rootUrl = new URL("../../../", import.meta.url);
const rootPath = fileURLToPath(rootUrl);

async function assertMissing(path) {
  await assert.rejects(access(path), (error) => error?.code === "ENOENT");
}

test("web build emits importable Stage 5 assets in a temporary directory with deployment headers and no release-forbidden files", async (t) => {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "ecolab-web-build-test-"));
  t.after(() => rm(temporaryRoot, { recursive: true, force: true }));
  const webPath = resolve(temporaryRoot, "web");
  const web = pathToFileURL(`${webPath}/`);
  await execute(process.execPath, ["scripts/build-web.js", "--out-dir", webPath], {
    cwd: rootPath,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });

  const index = await readFile(new URL("index.html", web), "utf8");
  assert.match(index, /href="\.\/src\/app\/styles\/app\.css"/);
  assert.match(index, /src="\.\/src\/app\/boot-watchdog\.js\?v=startup-fix-1"/);
  assert.match(index, /src="\.\/src\/app\/main\.js\?v=startup-fix-1"/);
  assert.doesNotMatch(index, /\b(?:src|href)="\//);

  await Promise.all([
    access(new URL("_headers", web)),
    access(new URL("src/app/boot-watchdog.js", web)),
    access(new URL("src/app/charts.js", web)),
    access(new URL("src/app/version.js", web)),
    access(new URL("src/app/workers/analysis-worker.js", web)),
    access(new URL("src/app/workers/task-client.js", web)),
    access(new URL("src/app/workers/task-protocol.js", web)),
    access(new URL("src/model.js", web)),
    access(new URL("src/analysis.js", web)),
    access(new URL("src/analysis/index.js", web)),
    access(new URL("src/analysis/analysis-manifest.js", web)),
    access(new URL("src/analysis/analysis-plan.js", web)),
    access(new URL("src/analysis/research-workflow.js", web)),
    access(new URL("src/registry/resolve.js", web)),
    access(new URL("src/experiment/run-manifest.js", web)),
    access(new URL("data/registry/datasets.json", web)),
    access(new URL("data/registry/drugs.json", web)),
    access(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", web)),
    access(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.csv", web)),
    access(new URL("data/datasets/figshare-bw25113-growth-v1/README.md", web)),
    access(new URL("data/datasets/figshare-bw25113-growth-v1/checksums.json", web)),
    access(new URL("schemas/analysis-plan.schema.json", web)),
    access(new URL("schemas/research-package.schema.json", web)),
  ]);

  await assertMissing(new URL("data/raw/", web));
  const emittedPaths = await readdir(webPath, { recursive: true });
  assert.equal(emittedPaths.some((entry) => /(?:^|[\\/])raw(?:[\\/]|$)/u.test(entry)), false);
  assert.equal(emittedPaths.some((entry) => /\.xlsx$/iu.test(entry)), false);
  assert.equal(emittedPaths.some((entry) => /(?:^|[\\/])tests(?:[\\/]|$)/u.test(entry)), false);

  const dataset = JSON.parse(
    await readFile(
      new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", web),
      "utf8",
    ),
  );
  assert.equal(dataset.metadata.datasetId, "figshare-bw25113-growth-v1");
  assert.equal(dataset.observations.length, 528);

  const headers = await readFile(new URL("_headers", web), "utf8");
  assert.match(headers, /Content-Security-Policy:/);
  assert.match(headers, /worker-src 'self'/);
  assert.match(headers, /navigate-to[^\n;]*\bblob:/);
  assert.doesNotMatch(headers, /unsafe-inline/);

  const buildId = Date.now();
  const [modelApi, analysisApi, researchApi, workerApi, taskClientApi, versionApi] = await Promise.all([
    import(`${new URL("src/model.js", web).href}?test=${buildId}`),
    import(`${new URL("src/analysis.js", web).href}?test=${buildId}`),
    import(`${new URL("src/analysis/research-workflow.js", web).href}?test=${buildId}`),
    import(`${new URL("src/app/workers/analysis-worker.js", web).href}?test=${buildId}`),
    import(`${new URL("src/app/workers/task-client.js", web).href}?test=${buildId}`),
    import(`${new URL("src/app/version.js", web).href}?test=${buildId}`),
  ]);
  assert.equal(typeof modelApi.simulatePiecewise, "function");
  assert.equal(typeof analysisApi.runEcolabStage4ResearchWorkflow, "function");
  assert.equal(typeof researchApi.runEcolabStage4ResearchWorkflow, "function");
  assert.equal(typeof workerApi.dispatchTask, "function");
  assert.equal(typeof taskClientApi.TaskClient, "function");
  assert.equal(versionApi.APPLICATION_VERSION, "5.0.0");
});
