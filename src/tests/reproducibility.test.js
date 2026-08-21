import test from "node:test";
import assert from "node:assert/strict";
import { simulatePiecewise } from "../model/simulate-piecewise.js";
import {
  canonicalizeJson,
  createRunManifest,
} from "../experiment/run-manifest.js";
import { loadResolvedModel, readProjectJson } from "./helpers/fixtures.js";

const resolvedModel = await loadResolvedModel();
const example = await readProjectJson("data/examples/ciprofloxacin-washout.json");
const request = {
  initialState: example.initialState,
  protocol: example.protocol,
  sampleTimes: example.sampleTimes,
  observation: example.observation,
};

test("the same JSON-compatible request produces the same trajectory", () => {
  const first = simulatePiecewise(resolvedModel, request);
  const roundTripped = JSON.parse(JSON.stringify(request));
  const second = simulatePiecewise(resolvedModel, roundTripped);
  assert.deepEqual(second, first);
});

test("run manifest records exact versions, resolved parameters and warnings", () => {
  const result = simulatePiecewise(resolvedModel, request);
  const manifest = createRunManifest({
    runId: "example-ciprofloxacin-washout",
    createdAt: "2026-08-20T12:00:00.000Z",
    applicationVersion: "1.0.0",
    resolvedModel,
    request,
    result,
  });
  assert.equal(manifest.engine.version, "2.0.0");
  assert.equal(manifest.parameterSet.conditionMatch, "transferred_calibration");
  assert.equal(
    manifest.parameterSet.resolvedParameters.drugs.ciprofloxacin.zMicMgPerL,
    0.017,
  );
  assert.ok(manifest.warnings.some((warning) => warning.code === "TRANSFERRED_CALIBRATION"));
  assert.deepEqual(JSON.parse(JSON.stringify(manifest)), manifest);
});

test("canonical JSON is independent of object insertion order", () => {
  assert.equal(
    canonicalizeJson({ b: 2, a: { d: 4, c: 3 } }),
    canonicalizeJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});
