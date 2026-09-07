import * as analysisApi from "../../analysis/index.js";
import { handleRunEnvelope } from "../workers/analysis-worker.js";

export function resolveResearchWorkflow(api) {
  const workflow = api?.runEcolabResearchWorkflow
    ?? api?.runResearchWorkflow
    ?? api?.runEcolabStage4ResearchWorkflow
    ?? api?.runStage4ResearchWorkflow
    ?? api?.runOd600ResearchWorkflow;
  if (typeof workflow !== "function") {
    const error = new Error("No compatible built-in Research workflow export is available.");
    error.code = "RESEARCH_WORKFLOW_UNAVAILABLE";
    throw error;
  }
  return workflow;
}

export function researchAnalysisApi(api = analysisApi) {
  return {
    ...api,
    runResearchWorkflow: resolveResearchWorkflow(api),
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const workerScope = self;
  workerScope.onmessage = async (event) => {
    workerScope.onmessage = null;
    await handleRunEnvelope(
      event.data,
      (message) => workerScope.postMessage(message),
      { analysisApi: researchAnalysisApi() },
    );
    workerScope.close?.();
  };
}
