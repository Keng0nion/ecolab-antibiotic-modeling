import test from "node:test";
import assert from "node:assert/strict";
import { readProjectJson } from "./helpers/fixtures.js";

test("unlicensed candidate datasets are never marked as bundled", async () => {
  const registry = await readProjectJson("data/registry/datasets.json");
  assert.ok(registry.records.length >= 2);
  for (const dataset of registry.records) {
    if (dataset.licenseStatus.includes("unknown")) {
      assert.equal(dataset.bundled, false, dataset.id);
    }
  }
});

test("current evidence registry does not pretend to contain matched validation data", async () => {
  const registry = await readProjectJson("data/registry/datasets.json");
  assert.equal(
    registry.records.some(
      (dataset) => dataset.bundled && dataset.status === "independent_validation",
    ),
    false,
  );
});
