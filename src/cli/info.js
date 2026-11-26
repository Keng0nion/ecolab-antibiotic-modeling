import {
  ANALYSIS_ENGINE_ID,
  ANALYSIS_ENGINE_VERSION,
  ANALYSIS_IMPLEMENTATION_ID,
} from "../analysis/version.js";
import { COURSE_STEPS } from "../app/course.js";
import { SANDBOX_LIMITS } from "../app/experiment.js";
import { RESEARCH_PRESETS } from "../app/research/state.js";
import { APPLICATION_VERSION } from "../app/version.js";
import { TASK_KINDS } from "../app/workers/task-protocol.js";
import { ENGINE_VERSION, IMPLEMENTATION_ID, MODEL_ID } from "../model/version.js";
import { CLI_SCHEMA_VERSION } from "./io.js";
import {
  COURSE_PRESET_ACTIONS,
  SIMULATION_PLAN_KIND,
  SIMULATION_PLAN_PATH,
  SIMULATION_PLAN_SCHEMA_VERSION,
} from "./simulate.js";

/** Machine-readable discovery document: versions, catalog, presets, limits, commands. */
export async function runInfoCommand({ catalog, commands }) {
  const { resolvedModel } = catalog;
  const datasetRecord = (catalog.datasetRegistry?.records ?? [])
    .find((record) => record.bundled === true) ?? null;
  const drugRecordFor = (drugId) => catalog.drugRegistry.records
    .find((record) => record.id === drugId) ?? null;

  return {
    kind: "ecolab.cli.info",
    schemaVersion: CLI_SCHEMA_VERSION,
    application: { version: APPLICATION_VERSION },
    scientificCore: {
      engineVersion: ENGINE_VERSION,
      modelId: MODEL_ID,
      modelVersion: resolvedModel.ref.version,
      implementationId: IMPLEMENTATION_ID,
      parameterSet: {
        id: resolvedModel.ref.parameterSetId,
        version: resolvedModel.ref.parameterSetVersion,
        evidenceLevel: resolvedModel.evidenceLevel,
        conditionMatch: resolvedModel.conditionMatch,
        capabilityLevel: resolvedModel.capabilityLevel,
      },
      warnings: resolvedModel.warnings.map(({ code }) => code),
    },
    analysis: {
      stableEngineId: ANALYSIS_ENGINE_ID,
      engineVersion: ANALYSIS_ENGINE_VERSION,
      implementationId: ANALYSIS_IMPLEMENTATION_ID,
    },
    drugs: Object.entries(resolvedModel.parameters.drugs).map(([id, drug]) => ({
      id,
      name: drugRecordFor(id)?.name ?? null,
      short: drugRecordFor(id)?.short ?? null,
      kind: drugRecordFor(id)?.kind ?? null,
      ...drug,
    })),
    coursePresets: COURSE_STEPS.map(({ id, action }) => ({ id, action })),
    coursePresetActions: COURSE_PRESET_ACTIONS,
    dataset: datasetRecord === null ? null : {
      id: datasetRecord.id,
      version: datasetRecord.version,
      status: datasetRecord.status,
      normalizedDataSha256: datasetRecord.artifactIntegrity?.normalizedDataSha256 ?? null,
      observationCount: datasetRecord.artifactIntegrity?.observationCount ?? null,
      trainingObservationCount: datasetRecord.artifactIntegrity?.trainingObservationCount ?? null,
      validationObservationCount: datasetRecord.artifactIntegrity?.validationObservationCount ?? null,
      independentUnitCount: datasetRecord.artifactIntegrity?.independentUnitCount ?? null,
      license: datasetRecord.redistributionLicense?.spdx ?? null,
    },
    researchPresets: Object.keys(RESEARCH_PRESETS),
    simulationPlan: {
      kind: SIMULATION_PLAN_KIND,
      schemaVersion: SIMULATION_PLAN_SCHEMA_VERSION,
      path: SIMULATION_PLAN_PATH,
    },
    sandboxLimits: SANDBOX_LIMITS,
    taskKinds: TASK_KINDS,
    commands,
    runtime: {
      node: process.version,
      platform: process.platform,
      networkUsed: false,
    },
  };
}
