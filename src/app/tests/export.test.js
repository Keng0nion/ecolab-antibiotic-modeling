import test from "node:test";
import assert from "node:assert/strict";
import { simulatePiecewise } from "../../model.js";
import { loadResolvedModel } from "../../tests/helpers/fixtures.js";
import { buildRunManifest, trajectoryToCsv } from "../export.js";
import {
  advanceProject,
  compileSimulationRequest,
  createProject,
  selectDrug,
  setPendingDose,
} from "../experiment.js";

const resolvedModel = await loadResolvedModel();

function completedProject() {
  let project = createProject({
    id: "export-test",
    modelRef: { id: resolvedModel.ref.id, version: resolvedModel.ref.version },
    parameterSetRef: {
      id: resolvedModel.ref.parameterSetId,
      version: resolvedModel.ref.parameterSetVersion,
    },
  });
  project = selectDrug(project, "ciprofloxacin", ["none", "ciprofloxacin"]);
  project = advanceProject(setPendingDose(project, 0.068), 60);
  return project;
}

test("CSV preserves latent state, units, versions and warnings", () => {
  const project = completedProject();
  const request = compileSimulationRequest(project);
  const result = simulatePiecewise(resolvedModel, request);
  const csv = trajectoryToCsv(result, resolvedModel);
  assert.match(csv, /latent_population_log10_CFU_per_mL/);
  assert.match(csv, /ecolab\.single-population\.regoes-logistic/);
  assert.match(csv, /TRANSFERRED_CALIBRATION/);
  assert.match(csv, /,4,/);
});

test("run manifest is generated from the current scientific result", () => {
  const project = completedProject();
  const request = compileSimulationRequest(project);
  const result = simulatePiecewise(resolvedModel, request);
  const manifest = buildRunManifest({
    project,
    resolvedModel,
    request,
    result,
    applicationVersion: "3.0.0",
  });
  assert.equal(manifest.application.version, "3.0.0");
  assert.equal(manifest.model.version, "1.0.0");
  assert.equal(manifest.request.protocol.segments[0].concentration.value, 0.068);
});

test("scientific export rejects an uncommitted boundary action", () => {
  let project = completedProject();
  project = setPendingDose(project, 0.034, { unit: "xZMic", value: 2 });
  assert.throws(() => compileSimulationRequest(project), {
    code: "PENDING_BOUNDARY_ACTION",
  });
});
