import test from "node:test";
import assert from "node:assert/strict";
import { COURSE_STEPS, coursePreset, courseStep } from "../course.js";
import { loadResolvedModel } from "../../tests/helpers/fixtures.js";

test("the first-year guided course is a fixed seven-step path", () => {
  assert.equal(COURSE_STEPS.length, 7);
  assert.deepEqual(
    COURSE_STEPS.map((step) => step.id),
    ["limits", "control-growth", "zmic", "high-dose", "washout", "compare", "reproducibility"],
  );
  assert.equal(courseStep(-1).id, "limits");
  assert.equal(courseStep(99).id, "reproducibility");
});

test("course presets use zMIC explicitly and dilute only drug concentration", async () => {
  const resolvedModel = await loadResolvedModel();
  const zMic = resolvedModel.parameters.drugs.ciprofloxacin.zMicMgPerL;
  const high = coursePreset("run-high", resolvedModel);
  const washout = coursePreset("run-washout", resolvedModel);

  assert.equal(high.segments[0].concentrationMgPerL, 4 * zMic);
  assert.deepEqual(
    washout.segments.map((segment) => [
      segment.durationMinutes,
      segment.concentrationMgPerL,
      segment.operation ?? "dose",
    ]),
    [
      [60, 4 * zMic, "dose"],
      [30, 2 * zMic, "dilute"],
      [60, 0, "washout"],
    ],
  );
  assert.equal(washout.initialPopulationCfuPerMl, 1_000_000);
  assert.equal(coursePreset("open-sources", resolvedModel), null);
});
