import { ScientificValidationError } from "../model.js";

export const PROJECT_SCHEMA_VERSION = "1.0.0";

export const SANDBOX_LIMITS = Object.freeze({
  maxSimulationMinutes: 365 * 24 * 60,
  minSampleIntervalMinutes: 0.1,
  maxSamplePoints: 10_000,
});

function finite(value, path, { minimum = -Infinity, exclusiveMinimum = false } = {}) {
  const invalidMinimum = exclusiveMinimum ? value <= minimum : value < minimum;
  if (typeof value !== "number" || !Number.isFinite(value) || invalidMinimum) {
    throw new ScientificValidationError(
      "INVALID_PROJECT_NUMBER",
      `${path} must be a finite number${minimum !== -Infinity ? ` ${exclusiveMinimum ? ">" : ">="} ${minimum}` : ""}.`,
      { path, actual: value },
    );
  }
  return value;
}

function samplePointCount(durationMinutes, sampleIntervalMinutes) {
  if (durationMinutes === 0) return 1;
  const lowerIntervalCount = Math.floor(durationMinutes / sampleIntervalMinutes);
  const interiorCount =
    lowerIntervalCount > 0 && lowerIntervalCount * sampleIntervalMinutes >= durationMinutes
      ? lowerIntervalCount - 1
      : lowerIntervalCount;
  return interiorCount + 2;
}

function assertSimulationTimeLimit(value, path) {
  if (!Number.isFinite(value) || value > SANDBOX_LIMITS.maxSimulationMinutes) {
    throw new ScientificValidationError(
      "SIMULATION_TIME_LIMIT_EXCEEDED",
      `${path} must not exceed ${SANDBOX_LIMITS.maxSimulationMinutes} minutes.`,
      { path, expected: SANDBOX_LIMITS.maxSimulationMinutes, actual: value },
    );
  }
  return value;
}

function assertSampleIntervalLimit(value, path) {
  if (value < SANDBOX_LIMITS.minSampleIntervalMinutes) {
    throw new ScientificValidationError(
      "SAMPLE_INTERVAL_TOO_SMALL",
      `${path} must be at least ${SANDBOX_LIMITS.minSampleIntervalMinutes} minutes.`,
      { path, expected: SANDBOX_LIMITS.minSampleIntervalMinutes, actual: value },
    );
  }
  return value;
}

function assertSamplePointLimit(durationMinutes, sampleIntervalMinutes, path) {
  const count = samplePointCount(durationMinutes, sampleIntervalMinutes);
  if (count > SANDBOX_LIMITS.maxSamplePoints) {
    throw new ScientificValidationError(
      "SAMPLE_POINT_LIMIT_EXCEEDED",
      `The sampling schedule must not exceed ${SANDBOX_LIMITS.maxSamplePoints} points.`,
      { path, expected: SANDBOX_LIMITS.maxSamplePoints, actual: count },
    );
  }
  return count;
}

function assertHistoryLimit(count) {
  if (count > SANDBOX_LIMITS.maxSamplePoints) {
    throw new ScientificValidationError(
      "PROJECT_HISTORY_LIMIT_EXCEEDED",
      `Project history must not exceed ${SANDBOX_LIMITS.maxSamplePoints} entries.`,
      { path: "project", expected: SANDBOX_LIMITS.maxSamplePoints, actual: count },
    );
  }
}

function clone(value) {
  return structuredClone(value);
}

function nowIso() {
  return new Date().toISOString();
}

export function createProject({ modelRef, parameterSetRef, id = crypto.randomUUID() }) {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id,
    revision: 0,
    name: "Ecolab experiment",
    modelRef: clone(modelRef),
    parameterSetRef: clone(parameterSetRef),
    drugId: "none",
    initialPopulationCfuPerMl: 1_000_000,
    detectionLimitCfuPerMl: 10,
    sampleIntervalMinutes: 1,
    currentTimeMinutes: 0,
    currentConcentrationMgPerL: 0,
    pendingAction: null,
    segments: [],
    actions: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

export function validateProject(project) {
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw new ScientificValidationError("INVALID_PROJECT", "Project must be an object.", {
      path: "project",
      actual: project,
    });
  }
  if (project.schemaVersion !== PROJECT_SCHEMA_VERSION) {
    throw new ScientificValidationError(
      "UNSUPPORTED_PROJECT_SCHEMA",
      `Unsupported project schema: ${project.schemaVersion}.`,
      { path: "project.schemaVersion", expected: PROJECT_SCHEMA_VERSION, actual: project.schemaVersion },
    );
  }
  finite(project.initialPopulationCfuPerMl, "project.initialPopulationCfuPerMl", {
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(project.detectionLimitCfuPerMl, "project.detectionLimitCfuPerMl", {
    minimum: 0,
    exclusiveMinimum: true,
  });
  assertSampleIntervalLimit(
    finite(project.sampleIntervalMinutes, "project.sampleIntervalMinutes", {
      minimum: 0,
      exclusiveMinimum: true,
    }),
    "project.sampleIntervalMinutes",
  );
  assertSimulationTimeLimit(
    finite(project.currentTimeMinutes, "project.currentTimeMinutes", { minimum: 0 }),
    "project.currentTimeMinutes",
  );
  finite(project.currentConcentrationMgPerL, "project.currentConcentrationMgPerL", {
    minimum: 0,
  });
  if (!Array.isArray(project.segments) || !Array.isArray(project.actions)) {
    throw new ScientificValidationError(
      "INVALID_PROJECT_HISTORY",
      "Project segments and actions must be arrays.",
      { path: "project" },
    );
  }
  assertHistoryLimit(project.segments.length + project.actions.length);
  assertSamplePointLimit(
    project.currentTimeMinutes,
    project.sampleIntervalMinutes,
    "project.sampleIntervalMinutes",
  );
  return project;
}

function update(project, patch) {
  return {
    ...project,
    ...patch,
    updatedAt: nowIso(),
  };
}

export function renameProject(project, name) {
  validateProject(project);
  const normalized = String(name ?? "").trim().slice(0, 80);
  return update(project, { name: normalized || "Ecolab experiment" });
}

export function setInitialConditions(project, { initialPopulationCfuPerMl, detectionLimitCfuPerMl }) {
  validateProject(project);
  if (project.currentTimeMinutes > 0) {
    throw new ScientificValidationError(
      "EXPERIMENT_ALREADY_STARTED",
      "Initial conditions cannot change after time has advanced.",
      { path: "project.currentTimeMinutes" },
    );
  }
  finite(initialPopulationCfuPerMl, "initialPopulationCfuPerMl", {
    minimum: 0,
    exclusiveMinimum: true,
  });
  finite(detectionLimitCfuPerMl, "detectionLimitCfuPerMl", {
    minimum: 0,
    exclusiveMinimum: true,
  });
  return update(project, { initialPopulationCfuPerMl, detectionLimitCfuPerMl });
}

export function selectDrug(project, drugId, availableDrugIds) {
  validateProject(project);
  if (!availableDrugIds.includes(drugId)) {
    throw new ScientificValidationError("UNKNOWN_DRUG", `Unknown drug ID: ${drugId}.`, {
      path: "drugId",
      expected: availableDrugIds,
      actual: drugId,
    });
  }
  if (project.currentTimeMinutes > 0 || project.segments.length > 0) {
    throw new ScientificValidationError(
      "DRUG_CHANGE_REQUIRES_RESET",
      "Changing the drug requires resetting the experiment.",
      { path: "project.drugId" },
    );
  }
  return update(project, {
    drugId,
    currentConcentrationMgPerL: 0,
    pendingAction: null,
    actions: [],
  });
}

export function effectiveConcentration(project) {
  validateProject(project);
  return project.pendingAction?.concentrationMgPerL ?? project.currentConcentrationMgPerL;
}

export function setPendingDose(project, concentrationMgPerL, input = {}) {
  validateProject(project);
  finite(concentrationMgPerL, "concentrationMgPerL", { minimum: 0 });
  if (project.drugId === "none" && concentrationMgPerL !== 0) {
    throw new ScientificValidationError(
      "CONTROL_WITH_NONZERO_CONCENTRATION",
      "The no-antibiotic control must remain at zero concentration.",
      { path: "concentrationMgPerL", expected: 0, actual: concentrationMgPerL },
    );
  }
  return update(project, {
    pendingAction: {
      kind: concentrationMgPerL === 0 ? "washout" : "dose",
      timeMinutes: project.currentTimeMinutes,
      concentrationMgPerL,
      input: clone(input),
    },
  });
}

export function diluteDrugConcentration(project, fold) {
  validateProject(project);
  finite(fold, "fold", { minimum: 1, exclusiveMinimum: true });
  const before = effectiveConcentration(project);
  return update(project, {
    pendingAction: {
      kind: "dilute_drug_concentration",
      timeMinutes: project.currentTimeMinutes,
      concentrationMgPerL: before / fold,
      input: { fold, beforeMgPerL: before },
    },
  });
}

export function washout(project) {
  return setPendingDose(project, 0, { operation: "washout" });
}

function canMergeSegment(previous, segment) {
  return Boolean(
    previous &&
    Math.abs(previous.endMinutes - segment.startMinutes) < 1e-9 &&
    Math.abs(previous.concentrationMgPerL - segment.concentrationMgPerL) < 1e-15
  );
}

function appendSegment(segments, segment) {
  const next = segments.map((item) => ({ ...item }));
  const previous = next.at(-1);
  if (canMergeSegment(previous, segment)) {
    previous.endMinutes = segment.endMinutes;
    return next;
  }
  next.push(segment);
  return next;
}

export function advanceProject(project, durationMinutes) {
  validateProject(project);
  finite(durationMinutes, "durationMinutes", { minimum: 0, exclusiveMinimum: true });
  const startMinutes = project.currentTimeMinutes;
  const endMinutes = assertSimulationTimeLimit(
    startMinutes + durationMinutes,
    "project.currentTimeMinutes",
  );
  assertSamplePointLimit(endMinutes, project.sampleIntervalMinutes, "project.sampleIntervalMinutes");

  const concentrationMgPerL = effectiveConcentration(project);
  const segment = { startMinutes, endMinutes, concentrationMgPerL };
  const addedSegmentCount = canMergeSegment(project.segments.at(-1), segment) ? 0 : 1;
  const addedActionCount = project.pendingAction ? 1 : 0;
  assertHistoryLimit(
    project.segments.length + project.actions.length + addedSegmentCount + addedActionCount,
  );

  const segments = appendSegment(project.segments, segment);
  const actions = project.pendingAction
    ? [...project.actions, clone(project.pendingAction)]
    : [...project.actions];
  return update(project, {
    currentTimeMinutes: endMinutes,
    currentConcentrationMgPerL: concentrationMgPerL,
    pendingAction: null,
    segments,
    actions,
  });
}

export function resetProject(project) {
  validateProject(project);
  const reset = createProject({
    id: project.id,
    modelRef: project.modelRef,
    parameterSetRef: project.parameterSetRef,
  });
  return {
    ...reset,
    revision: project.revision,
    name: project.name,
    drugId: project.drugId,
    initialPopulationCfuPerMl: project.initialPopulationCfuPerMl,
    detectionLimitCfuPerMl: project.detectionLimitCfuPerMl,
    sampleIntervalMinutes: project.sampleIntervalMinutes,
    createdAt: project.createdAt,
  };
}

export function compileSimulationRequest(project) {
  validateProject(project);
  if (project.currentTimeMinutes <= 0 || project.segments.length === 0) {
    throw new ScientificValidationError(
      "EMPTY_EXPERIMENT",
      "Advance time before running the experiment.",
      { path: "project.currentTimeMinutes" },
    );
  }
  if (project.pendingAction) {
    throw new ScientificValidationError(
      "PENDING_BOUNDARY_ACTION",
      "Advance time to include the pending concentration action.",
      { path: "project.pendingAction" },
    );
  }

  const regularSamplePointCount = assertSamplePointLimit(
    project.currentTimeMinutes,
    project.sampleIntervalMinutes,
    "project.sampleIntervalMinutes",
  );
  const sampleTimes = new Set([0, project.currentTimeMinutes]);
  const addSampleTime = (time, path) => {
    sampleTimes.add(time);
    if (sampleTimes.size > SANDBOX_LIMITS.maxSamplePoints) {
      throw new ScientificValidationError(
        "SAMPLE_POINT_LIMIT_EXCEEDED",
        `The compiled sampling schedule must not exceed ${SANDBOX_LIMITS.maxSamplePoints} points.`,
        { path, expected: SANDBOX_LIMITS.maxSamplePoints, actual: sampleTimes.size },
      );
    }
  };

  for (let index = 1; index < regularSamplePointCount - 1; index += 1) {
    const time = index * project.sampleIntervalMinutes;
    if (time < project.currentTimeMinutes) {
      addSampleTime(Number(time.toFixed(12)), "project.sampleIntervalMinutes");
    }
  }
  for (const segment of project.segments) {
    addSampleTime(segment.startMinutes, "project.segments");
    addSampleTime(segment.endMinutes, "project.segments");
  }
  for (const action of project.actions) addSampleTime(action.timeMinutes, "project.actions");

  return {
    initialState: {
      populationDensity: {
        value: project.initialPopulationCfuPerMl,
        unit: "CFU/mL",
      },
    },
    protocol: {
      kind: "piecewise_constant",
      drugId: project.drugId,
      segments: project.segments.map((segment) => ({
        start: { value: segment.startMinutes, unit: "min" },
        end: { value: segment.endMinutes, unit: "min" },
        concentration: { value: segment.concentrationMgPerL, unit: "mg/L" },
      })),
    },
    sampleTimes: [...sampleTimes]
      .sort((a, b) => a - b)
      .map((value) => ({ value, unit: "min" })),
    observation: {
      detectionLimit: {
        value: project.detectionLimitCfuPerMl,
        unit: "CFU/mL",
      },
    },
  };
}

export function hydrateProject(value) {
  validateProject(value);
  return clone(value);
}
