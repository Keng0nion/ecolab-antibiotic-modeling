import test from "node:test";
import assert from "node:assert/strict";
import { simulatePiecewise } from "../../model.js";
import {
  SANDBOX_LIMITS,
  advanceProject,
  compileSimulationRequest,
  createProject,
  diluteDrugConcentration,
  effectiveConcentration,
  selectDrug,
  setPendingDose,
  validateProject,
  washout,
} from "../experiment.js";
import { loadResolvedModel } from "../../tests/helpers/fixtures.js";

const resolvedModel = await loadResolvedModel();
const refs = {
  modelRef: { id: resolvedModel.ref.id, version: resolvedModel.ref.version },
  parameterSetRef: {
    id: resolvedModel.ref.parameterSetId,
    version: resolvedModel.ref.parameterSetVersion,
  },
  id: "experiment-test",
};

function project() {
  return selectDrug(
    createProject(refs),
    "ciprofloxacin",
    ["none", ...Object.keys(resolvedModel.parameters.drugs)],
  );
}

test("boundary actions stay pending until positive time advances", () => {
  let value = project();
  value = setPendingDose(value, 0.068, { unit: "xZMic", value: 4 });
  assert.equal(value.segments.length, 0);
  assert.equal(effectiveConcentration(value), 0.068);
  assert.throws(() => compileSimulationRequest(value), {
    code: "EMPTY_EXPERIMENT",
  });

  value = advanceProject(value, 60);
  assert.equal(value.pendingAction, null);
  assert.deepEqual(value.segments, [
    { startMinutes: 0, endMinutes: 60, concentrationMgPerL: 0.068 },
  ]);
});

test("multiple operations at one boundary replace the pending concentration", () => {
  let value = advanceProject(project(), 60);
  value = setPendingDose(value, 0.068);
  value = diluteDrugConcentration(value, 2);
  value = washout(value);
  assert.equal(value.pendingAction.kind, "washout");
  assert.equal(effectiveConcentration(value), 0);
  assert.equal(value.actions.length, 0);

  value = advanceProject(value, 30);
  assert.equal(value.actions.length, 1);
  assert.equal(value.actions[0].kind, "washout");
  assert.deepEqual(value.segments, [
    { startMinutes: 0, endMinutes: 90, concentrationMgPerL: 0 },
  ]);
});

test("dose, dilution and washout compile into a contiguous scientific protocol", () => {
  let value = advanceProject(project(), 60);
  value = advanceProject(setPendingDose(value, 0.068), 60);
  value = advanceProject(diluteDrugConcentration(value, 2), 30);
  value = advanceProject(washout(value), 60);

  const request = compileSimulationRequest(value);
  assert.deepEqual(
    request.protocol.segments.map((segment) => [
      segment.start.value,
      segment.end.value,
      segment.concentration.value,
    ]),
    [
      [0, 60, 0],
      [60, 120, 0.068],
      [120, 150, 0.034],
      [150, 210, 0],
    ],
  );
  const result = simulatePiecewise(resolvedModel, request);
  assert.equal(result.trajectory.at(-1).timeHours, 3.5);
  assert.equal(result.trajectory.at(-1).concentrationMgPerL, 0);
});

test("changing drug after time advances requires reset", () => {
  const value = advanceProject(project(), 1);
  assert.throws(
    () => selectDrug(value, "ampicillin", ["none", "ampicillin"]),
    { code: "DRUG_CHANGE_REQUIRES_RESET" },
  );
});

test("sandbox limits are centralized and accept their exact teaching boundaries", () => {
  assert.deepEqual(SANDBOX_LIMITS, {
    maxSimulationMinutes: 525_600,
    minSampleIntervalMinutes: 0.1,
    maxSamplePoints: 10_000,
  });
  assert.equal(Object.isFrozen(SANDBOX_LIMITS), true);

  const atMinimumInterval = {
    ...project(),
    sampleIntervalMinutes: SANDBOX_LIMITS.minSampleIntervalMinutes,
  };
  assert.equal(validateProject(atMinimumInterval), atMinimumInterval);
  assert.throws(
    () => validateProject({
      ...atMinimumInterval,
      sampleIntervalMinutes: SANDBOX_LIMITS.minSampleIntervalMinutes - 0.001,
    }),
    { code: "SAMPLE_INTERVAL_TOO_SMALL", path: "project.sampleIntervalMinutes" },
  );

  const intervalAtMaximumTime =
    SANDBOX_LIMITS.maxSimulationMinutes / (SANDBOX_LIMITS.maxSamplePoints - 1);
  const atMaximumTime = advanceProject({
    ...project(),
    sampleIntervalMinutes: intervalAtMaximumTime,
  }, SANDBOX_LIMITS.maxSimulationMinutes);
  assert.equal(atMaximumTime.currentTimeMinutes, SANDBOX_LIMITS.maxSimulationMinutes);
  assert.throws(
    () => advanceProject(atMaximumTime, SANDBOX_LIMITS.minSampleIntervalMinutes),
    { code: "SIMULATION_TIME_LIMIT_EXCEEDED", path: "project.currentTimeMinutes" },
  );
});

test("sample point limits accept exactly the cap and reject one additional point before compilation grows", () => {
  const intervalMinutes = 1;
  const atPointLimit = advanceProject({
    ...project(),
    sampleIntervalMinutes: intervalMinutes,
  }, (SANDBOX_LIMITS.maxSamplePoints - 1) * intervalMinutes);

  const request = compileSimulationRequest(atPointLimit);
  assert.equal(request.sampleTimes.length, SANDBOX_LIMITS.maxSamplePoints);
  assert.equal(request.sampleTimes.at(-1).value, SANDBOX_LIMITS.maxSamplePoints - 1);

  assert.throws(
    () => advanceProject(atPointLimit, intervalMinutes),
    { code: "SAMPLE_POINT_LIMIT_EXCEEDED", path: "project.sampleIntervalMinutes" },
  );
  assert.throws(
    () => advanceProject(atPointLimit, Number.EPSILON * atPointLimit.currentTimeMinutes),
    { code: "SAMPLE_POINT_LIMIT_EXCEEDED", path: "project.sampleIntervalMinutes" },
  );
  assert.throws(
    () => validateProject({
      ...project(),
      segments: Array(SANDBOX_LIMITS.maxSamplePoints + 1).fill(null),
    }),
    { code: "PROJECT_HISTORY_LIMIT_EXCEEDED" },
  );
});

test("compileSimulationRequest caps irregular boundary samples in addition to regular samples", () => {
  const durationMinutes = SANDBOX_LIMITS.maxSamplePoints - 1;
  const value = {
    ...advanceProject(project(), durationMinutes),
    segments: [
      { startMinutes: 0, endMinutes: 0.5, concentrationMgPerL: 0 },
      { startMinutes: 0.5, endMinutes: durationMinutes, concentrationMgPerL: 0 },
    ],
  };

  assert.throws(
    () => compileSimulationRequest(value),
    { code: "SAMPLE_POINT_LIMIT_EXCEEDED", expected: SANDBOX_LIMITS.maxSamplePoints },
  );
});
