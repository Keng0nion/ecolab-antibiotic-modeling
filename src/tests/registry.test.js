import test from "node:test";
import assert from "node:assert/strict";
import { resolveModel, resolveModelFromRegistries } from "../registry/resolve.js";
import { loadResolvedModel, readProjectJson } from "./helpers/fixtures.js";

test("registered model resolves with version, evidence and exact source links", async () => {
  const resolved = await loadResolvedModel();
  assert.equal(resolved.ref.version, "1.0.0");
  assert.equal(resolved.ref.parameterSetVersion, "1.0.0");
  assert.equal(resolved.conditionMatch, "transferred_calibration");
  assert.equal(resolved.capabilityLevel, "L1");
  assert.deepEqual(resolved.sourceIds, ["bionumbers-111767", "regoes-2004"]);
  assert.ok(Object.isFrozen(resolved));
  assert.ok(Object.isFrozen(resolved.parameters.drugs.ciprofloxacin));
});

test("unknown versions never fall back to the latest record", async () => {
  const [modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
    readProjectJson("data/registry/model-definitions.json"),
    readProjectJson("data/registry/parameter-sets.json"),
    readProjectJson("data/registry/sources.json"),
  ]);
  assert.throws(
    () =>
      resolveModelFromRegistries({
        modelRegistry,
        parameterRegistry,
        sourceRegistry,
        modelRef: {
          id: "ecolab.single-population.regoes-logistic",
          version: "9.9.9",
        },
        parameterSetRef: {
          id: "ecolab.bw25113-m9-regoes-transferred",
          version: "1.0.0",
        },
      }),
    { code: "REGISTRY_RECORD_NOT_FOUND" },
  );
});

test("dangling source references and model-version mismatches are rejected", async () => {
  const [modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
    readProjectJson("data/registry/model-definitions.json"),
    readProjectJson("data/registry/parameter-sets.json"),
    readProjectJson("data/registry/sources.json"),
  ]);
  const definition = structuredClone(modelRegistry.records[0]);
  const parameterSet = structuredClone(parameterRegistry.records[0]);
  parameterSet.parameters.drugs.ampicillin.zMic.provenance[0].sourceId = "missing";
  assert.throws(() => resolveModel({ definition, parameterSet, sourceRegistry }), {
    code: "UNKNOWN_SOURCE_REFERENCE",
  });

  parameterSet.parameters.drugs.ampicillin.zMic.provenance[0].sourceId = "regoes-2004";
  parameterSet.modelRef.version = "2.0.0";
  assert.throws(() => resolveModel({ definition, parameterSet, sourceRegistry }), {
    code: "MODEL_VERSION_MISMATCH",
  });
});
