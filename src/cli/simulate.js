import { coursePreset } from "../app/course.js";
import {
  advanceProject,
  compileSimulationRequest,
  createProject,
  diluteDrugConcentration,
  selectDrug,
  setInitialConditions,
  setPendingDose,
  washout,
} from "../app/experiment.js";
import { trajectoryToCsv } from "../app/export.js";
import { createRunManifest, simulatePiecewise } from "../model.js";
import { validationError } from "../model/errors.js";
import { deepFreeze } from "../model/validate.js";
import { CLI_SCHEMA_VERSION, cliError, readJsonInput, safeFileStem, writeArtifact } from "./io.js";

export const SIMULATION_PLAN_KIND = "ecolab.simulation-plan";
export const SIMULATION_PLAN_SCHEMA_VERSION = "1.0.0";
export const SIMULATION_PLAN_PATH = "schemas/simulation-plan.schema.json";
export const COURSE_PRESET_ACTIONS = Object.freeze([
  "run-control",
  "run-zmic",
  "run-high",
  "run-washout",
  "compare-drugs",
]);

const PLAN_KEYS = new Set([
  "schemaVersion",
  "kind",
  "id",
  "drugId",
  "initialPopulationCfuPerMl",
  "detectionLimitCfuPerMl",
  "sampleIntervalMinutes",
  "steps",
]);

function planFail(code, path, message, actual) {
  throw validationError(code, path, undefined, actual, message);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      planFail("UNKNOWN_PLAN_KEY", `${path}.${key}`, `Unknown plan key: ${key}.`, key);
    }
  }
}

function finitePlanNumber(value, path, { exclusiveMinimum = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || (exclusiveMinimum !== null && value <= exclusiveMinimum)) {
    planFail(
      "INVALID_PLAN_NUMBER",
      path,
      `${path} must be a finite number${exclusiveMinimum === null ? "" : ` greater than ${exclusiveMinimum}`}.`,
      value,
    );
  }
  return value;
}

function resolvedDrug(resolvedModel, drugId) {
  const drug = resolvedModel.parameters.drugs[drugId];
  if (!drug) {
    planFail(
      "UNKNOWN_PLAN_DRUG",
      "plan.drugId",
      `Unknown drug ID: ${drugId}. Registered drugs: none, ${Object.keys(resolvedModel.parameters.drugs).join(", ")}.`,
      drugId,
    );
  }
  return drug;
}

function planConcentrationMgPerL(concentration, path, drugId, resolvedModel) {
  if (!isPlainObject(concentration)) {
    planFail("INVALID_PLAN_CONCENTRATION", path, `${path} must be an object with value and unit.`, concentration);
  }
  assertExactKeys(concentration, new Set(["value", "unit"]), path);
  const amount = finitePlanNumber(concentration.value, `${path}.value`);
  if (amount < 0) {
    planFail("INVALID_PLAN_NUMBER", `${path}.value`, `${path}.value must not be negative.`, amount);
  }
  if (concentration.unit === "mg/L") return amount;
  if (concentration.unit === "x_zMIC") {
    if (drugId === "none") {
      planFail(
        "PLAN_UNIT_REQUIRES_DRUG",
        `${path}.unit`,
        "x_zMIC requires a drug with a registered zMIC; the no-antibiotic control is always 0 mg/L.",
        concentration.unit,
      );
    }
    return amount * resolvedDrug(resolvedModel, drugId).zMicMgPerL;
  }
  planFail("INVALID_PLAN_UNIT", `${path}.unit`, `${path}.unit must be "mg/L" or "x_zMIC".`, concentration.unit);
  return null;
}

function planStep(step, index, drugId, resolvedModel) {
  const path = `plan.steps[${index}]`;
  if (!isPlainObject(step)) planFail("INVALID_PLAN_STEP", path, `${path} must be an object.`, step);
  switch (step.action) {
    case "dose":
      assertExactKeys(step, new Set(["action", "concentration"]), path);
      return {
        action: "dose",
        concentrationMgPerL: planConcentrationMgPerL(step.concentration, `${path}.concentration`, drugId, resolvedModel),
      };
    case "dilute":
      assertExactKeys(step, new Set(["action", "fold"]), path);
      return { action: "dilute", fold: finitePlanNumber(step.fold, `${path}.fold`, { exclusiveMinimum: 1 }) };
    case "washout":
      assertExactKeys(step, new Set(["action"]), path);
      return { action: "washout" };
    case "advance":
      assertExactKeys(step, new Set(["action", "durationMinutes"]), path);
      return {
        action: "advance",
        durationMinutes: finitePlanNumber(step.durationMinutes, `${path}.durationMinutes`, { exclusiveMinimum: 0 }),
      };
    default:
      planFail(
        "UNKNOWN_PLAN_ACTION",
        `${path}.action`,
        `Unknown plan action: ${String(step.action)}. Expected dose, dilute, washout, or advance.`,
        step.action,
      );
      return null;
  }
}

/** Strict structural validation of one simulation plan; no value is repaired silently. */
export function validateSimulationPlan(value, { resolvedModel }) {
  if (!isPlainObject(value)) {
    planFail("INVALID_PLAN", "plan", "A simulation plan must be a JSON object.", value);
  }
  assertExactKeys(value, PLAN_KEYS, "plan");
  if (value.schemaVersion !== SIMULATION_PLAN_SCHEMA_VERSION) {
    planFail("UNSUPPORTED_PLAN_SCHEMA", "plan.schemaVersion", `plan.schemaVersion must be ${SIMULATION_PLAN_SCHEMA_VERSION}.`, value.schemaVersion);
  }
  if (value.kind !== SIMULATION_PLAN_KIND) {
    planFail("UNSUPPORTED_PLAN_KIND", "plan.kind", `plan.kind must be ${SIMULATION_PLAN_KIND}.`, value.kind);
  }
  if (typeof value.drugId !== "string" || value.drugId.length === 0) {
    planFail("MISSING_PLAN_DRUG", "plan.drugId", "plan.drugId is required.", value.drugId);
  }
  const drugId = value.drugId;
  if (drugId !== "none") resolvedDrug(resolvedModel, drugId);
  if (value.id !== undefined && (typeof value.id !== "string" || value.id.trim() === "")) {
    planFail("INVALID_PLAN_ID", "plan.id", "plan.id must be a non-empty string.", value.id);
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    planFail("INVALID_PLAN_STEPS", "plan.steps", "plan.steps must be a non-empty array.", value.steps);
  }
  const steps = value.steps.map((step, index) => planStep(step, index, drugId, resolvedModel));
  if (!steps.some(({ action }) => action === "advance")) {
    planFail("EMPTY_PLAN_EXPERIMENT", "plan.steps", "The plan must advance time before it can be simulated.", value.steps);
  }
  if (steps.at(-1).action !== "advance") {
    planFail("PENDING_PLAN_ACTION", "plan.steps", "The final step must be advance so no boundary action stays pending.", steps.at(-1).action);
  }
  return deepFreeze({
    schemaVersion: SIMULATION_PLAN_SCHEMA_VERSION,
    kind: SIMULATION_PLAN_KIND,
    id: value.id === undefined ? "cli-simulation" : value.id,
    drugId,
    initialPopulationCfuPerMl: value.initialPopulationCfuPerMl === undefined
      ? 1_000_000
      : finitePlanNumber(value.initialPopulationCfuPerMl, "plan.initialPopulationCfuPerMl", { exclusiveMinimum: 0 }),
    detectionLimitCfuPerMl: value.detectionLimitCfuPerMl === undefined
      ? 10
      : finitePlanNumber(value.detectionLimitCfuPerMl, "plan.detectionLimitCfuPerMl", { exclusiveMinimum: 0 }),
    sampleIntervalMinutes: value.sampleIntervalMinutes === undefined
      ? 1
      : finitePlanNumber(value.sampleIntervalMinutes, "plan.sampleIntervalMinutes", { exclusiveMinimum: 0 }),
    steps,
  });
}

function availableDrugIds(resolvedModel) {
  return ["none", ...Object.keys(resolvedModel.parameters.drugs)];
}

function projectFromPlan(plan, resolvedModel) {
  let project = createProject({
    id: plan.id,
    modelRef: { id: resolvedModel.ref.id, version: resolvedModel.ref.version },
    parameterSetRef: { id: resolvedModel.ref.parameterSetId, version: resolvedModel.ref.parameterSetVersion },
  });
  project = setInitialConditions(project, {
    initialPopulationCfuPerMl: plan.initialPopulationCfuPerMl,
    detectionLimitCfuPerMl: plan.detectionLimitCfuPerMl,
  });
  project = { ...project, sampleIntervalMinutes: plan.sampleIntervalMinutes };
  project = selectDrug(project, plan.drugId, availableDrugIds(resolvedModel));
  for (const step of plan.steps) {
    if (step.action === "dose") project = setPendingDose(project, step.concentrationMgPerL, { source: "ecolab-terminal-plan" });
    else if (step.action === "dilute") project = diluteDrugConcentration(project, step.fold);
    else if (step.action === "washout") project = washout(project);
    else project = advanceProject(project, step.durationMinutes);
  }
  return project;
}

function runPlan({ plan, resolvedModel, applicationVersion, runId, createdAt }) {
  const request = compileSimulationRequest(projectFromPlan(plan, resolvedModel));
  const result = simulatePiecewise(resolvedModel, request);
  return {
    plan,
    result,
    runManifest: createRunManifest({ runId, createdAt, applicationVersion, resolvedModel, request, result }),
  };
}

/**
 * Convert one Learn-course preset into the declarative plan vocabulary, mirroring
 * the browser course loader: dilute divides the current concentration, and a dose
 * is only placed at the first segment or when the target concentration changes.
 */
export function planFromCoursePreset(action, resolvedModel) {
  const preset = coursePreset(action, resolvedModel);
  if (!preset || action === "compare-drugs") {
    throw cliError(
      "CLI_UNKNOWN_COURSE_PRESET",
      `Unknown course preset: ${String(action)}. Expected one of ${COURSE_PRESET_ACTIONS.join(", ")}.`,
      { actual: action },
    );
  }
  const steps = [];
  let currentConcentration = 0;
  preset.segments.forEach((segment, index) => {
    const target = segment.concentrationMgPerL;
    if (preset.drugId !== "none") {
      if (segment.operation === "dilute") steps.push({ action: "dilute", fold: currentConcentration / target });
      else if (segment.operation === "washout") steps.push({ action: "washout" });
      else if (index === 0 || target !== currentConcentration) {
        steps.push({ action: "dose", concentration: { value: target, unit: "mg/L" } });
      }
    }
    currentConcentration = target;
    steps.push({ action: "advance", durationMinutes: segment.durationMinutes });
  });
  return validateSimulationPlan({
    schemaVersion: SIMULATION_PLAN_SCHEMA_VERSION,
    kind: SIMULATION_PLAN_KIND,
    id: `course-${action}`,
    drugId: preset.drugId,
    initialPopulationCfuPerMl: preset.initialPopulationCfuPerMl,
    detectionLimitCfuPerMl: preset.detectionLimitCfuPerMl,
    sampleIntervalMinutes: preset.sampleIntervalMinutes,
    steps,
  }, { resolvedModel });
}

/** One 60-minute 4×zMIC plan per registered drug, matching the Learn compare step. */
function comparisonPlans(catalog, resolvedModel) {
  const preset = coursePreset("compare-drugs", resolvedModel);
  const durationMinutes = preset.segments[0].durationMinutes;
  const multiple = preset.compareAtZMicMultiple;
  const plans = catalog.drugRegistry.records
    .filter((drug) => drug.id !== "none")
    .map((drug) => ({
      label: drug.id,
      plan: validateSimulationPlan({
        schemaVersion: SIMULATION_PLAN_SCHEMA_VERSION,
        kind: SIMULATION_PLAN_KIND,
        id: `compare-drugs-${drug.id}`,
        drugId: drug.id,
        initialPopulationCfuPerMl: preset.initialPopulationCfuPerMl,
        detectionLimitCfuPerMl: preset.detectionLimitCfuPerMl,
        sampleIntervalMinutes: preset.sampleIntervalMinutes,
        steps: [
          { action: "dose", concentration: { value: resolvedDrug(resolvedModel, drug.id).zMicMgPerL * multiple, unit: "mg/L" } },
          { action: "advance", durationMinutes },
        ],
      }, { resolvedModel }),
    }));
  return { plans, durationMinutes, multiple };
}

export async function runSimulateCommand({
  planPath = null,
  preset = null,
  outDir = null,
  runId = null,
  createdAt = null,
  catalog,
  applicationVersion,
}) {
  if ((planPath === null) === (preset === null)) {
    throw cliError("CLI_SIMULATE_INPUT", "simulate requires exactly one of --plan <file|-> or --preset <course-preset>.");
  }
  if (runId !== null && planPath === null) {
    throw cliError("CLI_SIMULATE_RUN_ID", "--run-id applies to --plan runs; course presets keep their stable derived run IDs.");
  }
  const timestamp = createdAt ?? new Date().toISOString();
  const { resolvedModel } = catalog;

  let mode;
  let plans;
  let comparison = null;
  if (planPath !== null) {
    mode = "plan";
    const { value } = await readJsonInput(planPath, { label: "simulation plan" });
    const plan = validateSimulationPlan(value, { resolvedModel });
    plans = [{ label: plan.id, plan }];
  } else {
    mode = "preset";
    if (preset === "compare-drugs") {
      const generated = comparisonPlans(catalog, resolvedModel);
      plans = generated.plans;
      comparison = { atZMicMultiple: generated.multiple, durationMinutes: generated.durationMinutes, rows: [] };
    } else {
      const plan = planFromCoursePreset(preset, resolvedModel);
      plans = [{ label: plan.id, plan }];
    }
  }

  const runs = plans.map(({ label, plan }) => {
    const effectiveRunId = runId ?? plan.id;
    const run = runPlan({ plan, resolvedModel, applicationVersion, runId: effectiveRunId, createdAt: timestamp });
    return { label, runId: effectiveRunId, createdAt: timestamp, runManifest: run.runManifest, result: run.result };
  });

  if (comparison) {
    // Same terminal readout as the Learn compare step: the last sampled point per drug.
    comparison.rows = runs.map(({ label, result }) => {
      const final = result.trajectory.at(-1);
      return {
        drugId: label,
        concentrationMgPerL: final.concentrationMgPerL,
        netGrowthLog10PerHour: final.netGrowthLog10PerHour,
        finalPopulationLog10: final.latentLog10PopulationDensity,
      };
    });
  }

  const artifacts = [];
  if (outDir !== null) {
    for (const run of runs) {
      const stem = safeFileStem(run.runId);
      artifacts.push(await writeArtifact(
        "run-manifest-json",
        `${outDir}/${stem}.run-manifest.json`,
        `${JSON.stringify(run.runManifest, null, 2)}\n`,
      ));
      artifacts.push(await writeArtifact(
        "trajectory-csv",
        `${outDir}/${stem}.trajectory.csv`,
        trajectoryToCsv(run.result, resolvedModel),
      ));
    }
  }

  return {
    kind: "ecolab.cli.simulation",
    schemaVersion: CLI_SCHEMA_VERSION,
    mode,
    preset,
    plans: plans.map(({ label, plan }) => ({ label, plan })),
    runs: runs.map(({ label, runId: id, createdAt: created, runManifest }) => ({
      label, runId: id, createdAt: created, runManifest,
    })),
    comparison,
    artifacts,
  };
}
