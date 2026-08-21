import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const coreModules = [
  "src/model/errors.js",
  "src/model/index.js",
  "src/model/observe.js",
  "src/model/protocol.js",
  "src/model/regoes-logistic-v1.js",
  "src/model/simulate-piecewise.js",
  "src/model/units.js",
  "src/model/validate.js",
  "src/model/version.js",
  "src/registry/resolve.js",
  "src/experiment/run-manifest.js",
];

test("shared scientific modules do not import environment-specific APIs or JSON modules", async () => {
  for (const relativePath of coreModules) {
    const source = await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /node:|\bfs\b|document\.|window\.|fetch\s*\(|with\s*\{\s*type:\s*["']json/);
  }
});
