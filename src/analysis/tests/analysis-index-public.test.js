import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as publicApi from "../index.js";

const moduleNames = [
  "analysis-manifest",
  "analysis-plan",
  "capability",
  "condition-match",
  "dataset-import",
  "dataset-quality",
  "distributions",
  "fingerprint",
  "fitting",
  "identifiability",
  "likelihood",
  "metrics",
  "model-evaluator",
  "monte-carlo",
  "optimizers",
  "parameter-scan",
  "parameter-space",
  "random",
  "residuals",
  "sensitivity-local",
  "sensitivity-morris",
  "sensitivity-sobol",
  "split",
  "validation",
  "version",
];

test("analysis index re-exports every public symbol from every Stage 4 module", async () => {
  const modules = await Promise.all(moduleNames.map((name) => import(`../${name}.js`)));
  for (let index = 0; index < modules.length; index += 1) {
    for (const [name, value] of Object.entries(modules[index])) {
      assert.ok(Object.hasOwn(publicApi, name), `${name} from ${moduleNames[index]} is not exported`);
      assert.equal(publicApi[name], value, `${name} does not preserve the module export identity`);
    }
  }
  assert.equal(publicApi.ANALYSIS_ENGINE_VERSION, "1.0.0");
  assert.equal(publicApi.ANALYSIS_ENGINE_ID, "ecolab.stage4.analysis");
  assert.equal(publicApi.ANALYSIS_IMPLEMENTATION_ID, "ecolab-stage4-analysis-v1");
});

test("analysis public index has no DOM or Node runtime dependencies", async () => {
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:|document|window|HTMLElement|process\./);
  assert.match(source, /export \* from/);
});
