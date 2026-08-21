import test from "node:test";
import assert from "node:assert/strict";
import {
  RESEARCH_PRESETS,
  buildResearchWorkflowOptions,
  captureResearchRun,
  createResearchState,
  isCompletedAnalysis,
  newestCompletedAnalysis,
  normalizeResearchSeed,
  researchPreset,
  routeFromHashValue,
  setResearchSection,
} from "../research/state.js";
import { createDatasetRecord } from "./research-test-fixtures.js";

test("Research route is exact and unknown hashes fall back to Learn", () => {
  assert.equal(routeFromHashValue("#/learn"), "learn");
  assert.equal(routeFromHashValue("#/sandbox"), "sandbox");
  assert.equal(routeFromHashValue("#/research"), "research");
  assert.equal(routeFromHashValue("#/research/extra"), "learn");
  assert.equal(routeFromHashValue("#/unknown"), "learn");
  assert.equal(routeFromHashValue(""), "learn");
});

test("Research state exposes four sections, uint32 seeds, and bounded presets", () => {
  const state = createResearchState();
  assert.equal(state.activeSection, "data");
  setResearchSection(state, "results");
  assert.equal(state.activeSection, "results");
  assert.throws(() => setResearchSection(state, "other"), RangeError);
  assert.equal(normalizeResearchSeed("4294967295"), 0xffff_ffff);
  assert.throws(() => normalizeResearchSeed(-1), RangeError);
  assert.throws(() => normalizeResearchSeed(0x1_0000_0000), RangeError);
  assert.deepEqual(Object.keys(RESEARCH_PRESETS), ["small", "standard"]);
  assert.ok(researchPreset("small").monteCarloSamples < researchPreset("standard").monteCarloSamples);
  assert.throws(() => researchPreset("large"), RangeError);
});

test("run capture records reproducibility once and workflow options include every required field", () => {
  const dataset = createDatasetRecord();
  let calls = 0;
  const run = captureResearchRun({
    dataset,
    seed: 17,
    preset: "small",
    applicationVersion: "4.0.0",
    now() {
      calls += 1;
      return new Date("2026-08-21T12:00:00.000Z");
    },
  });
  assert.equal(calls, 1);
  assert.equal(run.createdAt, "2026-08-21T12:00:00.000Z");
  assert.match(run.runId, /^stage4-figshare-bw25113-growth-v1-67b5fc275707-17-/);
  assert.equal(Object.isFrozen(run), true);

  const resolvedModel = { ref: { id: "model" } };
  const options = buildResearchWorkflowOptions({ run, dataset, resolvedModel });
  assert.equal(options.datasetInput, dataset.sourceText);
  assert.equal(options.resolvedModel, resolvedModel);
  assert.equal(options.applicationVersion, "4.0.0");
  assert.equal(options.runId, run.runId);
  assert.equal(options.createdAt, run.createdAt);
  assert.equal(options.datasetVersion, "1.0.0");
  assert.equal(options.contentHash, dataset.contentHash);
  assert.equal(options.seed, 17);
  assert.deepEqual(options.optimizer, researchPreset("small").optimizer);
});

test("only completed analyses are restorable scientific results", () => {
  const records = [
    { id: "new-running", status: "running", result: { partial: true }, updatedAt: "2026-08-22T00:00:00Z" },
    { id: "older-complete", status: "completed", result: { ok: true }, updatedAt: "2026-08-20T00:00:00Z" },
    { id: "newer-complete", status: "completed", result: { ok: true }, updatedAt: "2026-08-21T00:00:00Z" },
  ];
  assert.equal(isCompletedAnalysis(records[0]), false);
  assert.equal(isCompletedAnalysis(records[1]), true);
  assert.equal(newestCompletedAnalysis(records).id, "newer-complete");
});
