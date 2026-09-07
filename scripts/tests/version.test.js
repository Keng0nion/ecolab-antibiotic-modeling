import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const rootPath = fileURLToPath(new URL("../../", import.meta.url));

test("version gate rejects stale application/analysis identities and changes to the teaching core/model", async (t) => {
  const fixturePath = await mkdtemp(resolve(tmpdir(), "ecolab-version-test-"));
  t.after(() => rm(fixturePath, { recursive: true, force: true }));
  const paths = ["package.json", "scripts/check-version.js", "src/app/version.js", "src/analysis/version.js", "src/model/version.js", "data/registry/model-definitions.json"];
  await Promise.all(paths.map(async (path) => {
    await mkdir(dirname(resolve(fixturePath, path)), { recursive: true });
    await cp(resolve(rootPath, path), resolve(fixturePath, path));
  }));
  for (const [path, oldText, newText, message] of [
    ["src/app/version.js", '"6.0.0"', '"5.0.0"', /Application version mismatch/],
    ["src/analysis/version.js", '"2.0.0"', '"1.0.0"', /analysis.*2\.0\.0/i],
    ["src/analysis/version.js", '"ecolab.stage4.analysis"', '"ecolab.stage6.analysis"', /stable.*ecolab\.stage4\.analysis/i],
    ["src/analysis/version.js", '"ecolab-research-analysis-v2"', '"ecolab-stage4-analysis-v1"', /implementation.*ecolab-research-analysis-v2/i],
    ["src/model/version.js", '"2.0.0"', '"3.0.0"', /core.*2\.0\.0/i],
    ["data/registry/model-definitions.json", '"version": "1.0.0"', '"version": "2.0.0"', /model.*1\.0\.0/i],
  ]) {
    await t.test(`${path}: ${newText}`, async () => {
      const fixtureFile = resolve(fixturePath, path);
      const original = await readFile(fixtureFile, "utf8");
      assert.ok(original.includes(oldText));
      try {
        await writeFile(fixtureFile, original.replace(oldText, newText));
        await assert.rejects(execute(process.execPath, ["scripts/check-version.js"], {
          cwd: fixturePath, timeout: 10_000,
        }), message);
      } finally {
        await writeFile(fixtureFile, original);
      }
    });
  }
});
