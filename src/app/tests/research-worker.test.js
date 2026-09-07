import test from "node:test";
import assert from "node:assert/strict";
import {
  researchAnalysisApi,
  resolveResearchWorkflow,
} from "../research/research-worker.js";

test("Research Worker prefers the versioned development workflow without removing legacy aliases", () => {
  const current = () => "current";
  const legacy = () => "legacy";
  assert.equal(resolveResearchWorkflow({ runEcolabResearchWorkflow: current, runResearchWorkflow: legacy }), current);
  assert.equal(researchAnalysisApi({ runEcolabResearchWorkflow: current }).runResearchWorkflow, current);
});

test("Research Worker bridges the primary public Stage 4 workflow export", () => {
  const primary = () => "primary";
  assert.equal(resolveResearchWorkflow({ runEcolabStage4ResearchWorkflow: primary }), primary);
  assert.equal(researchAnalysisApi({ runEcolabStage4ResearchWorkflow: primary }).runResearchWorkflow, primary);
});

test("Research Worker prefers an exact alias and supports documented fallback aliases", () => {
  const exact = () => "exact";
  const stage4 = () => "stage4";
  const od = () => "od";
  assert.equal(resolveResearchWorkflow({ runResearchWorkflow: exact, runStage4ResearchWorkflow: stage4 }), exact);
  assert.equal(resolveResearchWorkflow({ runStage4ResearchWorkflow: stage4 }), stage4);
  assert.equal(resolveResearchWorkflow({ runOd600ResearchWorkflow: od }), od);
  assert.throws(() => resolveResearchWorkflow({}), { code: "RESEARCH_WORKFLOW_UNAVAILABLE" });
});
