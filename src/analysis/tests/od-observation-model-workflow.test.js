import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries } from "../../model.js";
import * as analysis from "../index.js";
import {
  applyOdObservationLayer,
  profileOdObservationLayer,
} from "../od-observation-model.js";
import { runEcolabStage4ResearchWorkflow } from "../research-workflow.js";
import { ANALYSIS_IMPLEMENTATION_ID, ANALYSIS_ENGINE_VERSION } from "../version.js";
import { assertSchemaValid } from "./schema-test-helper.js";

const root = new URL("../../../", import.meta.url);
const CONTENT_HASH = "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817";
const NORMALIZED_FINGERPRINT = "2c30ce8d5dcf43c35aeafff0b495da0e012aef6d6ed3c021acab69eaf2dfbbcc";

async function readProjectText(relativePath) {
  return readFile(new URL(relativePath, root), "utf8");
}

async function readProjectJson(relativePath) {
  return JSON.parse(await readProjectText(relativePath));
}

async function fixture() {
  const [datasetText, modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
    readProjectText("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json"),
    readProjectJson("data/registry/model-definitions.json"),
    readProjectJson("data/registry/parameter-sets.json"),
    readProjectJson("data/registry/sources.json"),
  ]);
  const resolvedModel = resolveModelFromRegistries({
    modelRegistry,
    parameterRegistry,
    sourceRegistry,
    modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
    parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
  });
  return { datasetText, dataset: JSON.parse(datasetText), resolvedModel };
}

function reducedOptions(datasetInput, resolvedModel, overrides = {}) {
  return {
    datasetInput,
    resolvedModel,
    seed: 123456789,
    optimizer: {
      restarts: 1,
      populationSize: 8,
      differentialEvolutionMaxEvaluations: 80,
      nelderMeadMaxEvaluations: 80,
    },
    scanPointsPerAxis: 3,
    monteCarloSamples: 8,
    morrisTrajectories: 2,
    morrisLevels: 4,
    sobolSamples: 8,
    identifiabilityProfilePoints: 3,
    applicationVersion: "4.0.0",
    runId: "reduced-stage4-test",
    createdAt: "2026-08-21T12:00:00.000Z",
    datasetVersion: "1.0.0",
    contentHash: CONTENT_HASH,
    ...overrides,
  };
}

function clone(value) {
  return structuredClone(value);
}

test("OD600 observation-layer profiling recovers synthetic nuisance parameters", () => {
  const latentFractions = [0.01, 0.05, 0.2, 0.55, 0.9];
  const expected = { baselineOd: 0.075, scaleOd: 0.31 };
  const observedOd = latentFractions.map((fraction) => applyOdObservationLayer(fraction, expected));
  const profiled = profileOdObservationLayer({ latentFractions, observedOd });

  assert.equal(profiled.equation, "OD600 = baselineOd + scaleOd * (N/K)");
  assert.equal(profiled.terminology, "observation-layer nuisance parameters");
  assert.ok(Math.abs(profiled.baselineOd - expected.baselineOd) < 1e-12);
  assert.ok(Math.abs(profiled.scaleOd - expected.scaleOd) < 1e-12);
  assert.ok(profiled.sumSquaredErrors < 1e-24);
  assert.equal(profiled.activeConstraint, "none");
});

test("public analysis index exports the OD model and real-data workflow", () => {
  assert.equal(analysis.profileOdObservationLayer, profileOdObservationLayer);
  assert.equal(analysis.runEcolabStage4ResearchWorkflow, runEcolabStage4ResearchWorkflow);
});

test("real bundled import, training fit, lock, and held-out validation are deterministic and leakage-free", async () => {
  const { datasetText, resolvedModel } = await fixture();
  const progress = [];
  const first = await runEcolabStage4ResearchWorkflow(reducedOptions(datasetText, resolvedModel, {
    onProgress: (event) => progress.push(event),
  }));
  const second = await runEcolabStage4ResearchWorkflow(reducedOptions(datasetText, resolvedModel));

  assert.doesNotThrow(() => JSON.stringify(first));
  assert.deepEqual(first, second);
  assert.ok(progress.length > 0);
  assert.deepEqual(progress.at(-1), { phase: "complete", completed: 1, total: 1 });
  assert.ok(progress.every(({ phase, completed, total }) =>
    typeof phase === "string" && Number.isFinite(completed) && Number.isFinite(total)));

  assert.equal(first.dataset.id, "figshare-bw25113-growth-v1");
  assert.equal(first.dataset.observationCount, 528);
  assert.equal(first.dataset.trainingObservationCount, 352);
  assert.equal(first.dataset.validationObservationCount, 176);
  assert.equal(first.dataset.trainingUnitCount, 8);
  assert.equal(first.dataset.validationUnitCount, 4);
  assert.equal(first.dataset.sourceIncludesTimeZero, false);
  assert.deepEqual(first.dataset.sourceTimesHours, Array.from({ length: 44 }, (_, index) => (index + 1) / 2));
  assert.equal(first.dataset.normalizedDatasetFingerprint, NORMALIZED_FINGERPRINT);
  assert.equal(first.dataset.sourceArtifactSha256, CONTENT_HASH);
  assert.equal(first.dataset.sourceArtifactSha256Verified, true);
  assert.equal(first.dataset.sourceContentHash, CONTENT_HASH);
  assert.equal(first.dataset.sourceContentHashVerified, true);

  const trainingUnits = new Set(first.split.roles.training.independentUnitIds);
  const validationUnits = new Set(first.split.roles.validation.independentUnitIds);
  assert.equal([...trainingUnits].some((unitId) => validationUnits.has(unitId)), false);
  assert.equal(first.split.lockedValidation, true);
  assert.equal(first.training.role, "training_calibration");
  assert.equal(first.training.calibrationOnly, true);
  assert.equal(first.training.eligibleAsValidationEvidence, false);
  assert.equal(first.training.observationRoleUsed, "training");
  assert.equal(first.training.observationCount, 352);
  assert.deepEqual(first.training.parameterWhitelist, [
    "psiMaxLog10PerHour",
    "initialStates.pooled.log10PopulationDensity",
  ]);
  assert.deepEqual(Object.keys(first.training.fittedBiologicalParameters), [
    "psiMaxLog10PerHour",
    "initialStates.pooled.log10PopulationDensity",
  ]);
  assert.equal(first.training.profiledObservationLayer.profiledOnRole, "training");
  assert.equal(first.training.profiledObservationLayer.observationCount, 352);
  assert.equal(first.training.profiledObservationLayer.lockedBeforeValidation, true);
  assert.ok(first.training.profiledObservationLayer.baselineOd >= 0);
  assert.ok(first.training.profiledObservationLayer.scaleOd > 0);
  assert.equal(first.training.profiledObservationLayer.equation, "OD600 = baselineOd + scaleOd * (N/K)");

  assert.equal(first.model.scientificCore, "no-drug piecewise-analytic logistic growth");
  assert.equal(first.model.carryingCapacityFixed, true);
  assert.equal(first.model.treatmentOrAntibioticInference, false);
  assert.equal(first.model.protocol.drugId, "none");
  assert.equal(first.model.protocol.segments.length, 1);
  assert.equal(first.model.protocol.segments[0].start.value, 0);
  assert.equal(first.model.protocol.segments[0].end.value, 22);
  assert.equal(first.model.protocol.segments[0].concentration.value, 0);

  assert.equal(first.lockedPlan.lockedValidation, true);
  assert.equal(first.lockedPlan.errorModel.profiledOnRole, "training");
  assert.equal(first.lockedPlan.errorModel.reprofileDuringValidation, false);
  assert.equal(first.lockedPlan.errorModel.baselineOd, first.training.profiledObservationLayer.baselineOd);
  assert.equal(first.lockedPlan.errorModel.scaleOd, first.training.profiledObservationLayer.scaleOd);
  assert.equal(first.lockedPlan.baseline.sourceRole, "training");
  assert.equal(first.lockedPlan.baseline.predeclared, true);
  assert.deepEqual(first.lockedPlan.baseline.trainingIndependentUnitIds, first.split.roles.training.independentUnitIds);
  assert.equal(first.lockedPlan.baseline.predictions.length, 176);

  assert.equal(first.validation.role, "locked_holdout_evaluation");
  assert.equal(first.validation.evidenceStatus, "procedural_locked_holdout_evaluation");
  assert.equal(first.validation.fittedOnThisData, false);
  assert.equal(first.validation.independentUnitsDocumented, false);
  assert.equal(first.validation.eligibleAsValidationEvidence, false);
  assert.equal(first.validation.parametersAltered, false);
  assert.equal(first.validation.optimizerUsed, false);
  assert.equal(first.validation.nuisanceParametersReprofiled, false);
  assert.equal(first.validation.validationEvaluatorCalls, 1);
  assert.equal(first.validation.observationCount, 176);
  assert.equal(first.validation.predictions.length, 176);
  assert.equal(first.validation.residuals.length, 176);
  assert.equal(first.validation.metrics.perUnit.length, 4);
  assert.equal(first.validation.residualConvention, "observed - predicted");
  for (const residual of first.validation.residuals) {
    assert.equal(residual.kind, "point");
    assert.ok(Math.abs(residual.residual - (residual.observed - residual.predicted)) < 1e-15);
  }
  assert.equal(first.validation.metrics.baselineComparison.predeclared, true);
  assert.equal(
    first.validation.metrics.baselineComparison.baselineId,
    "training-unit-mean-od-by-exact-source-time",
  );

  assert.equal(first.analyses.parameterScan.candidateCount, 9);
  assert.equal(first.analyses.parameterScan.results.length, 9);
  assert.equal(first.analyses.monteCarlo.sampleCount, 8);
  assert.equal(first.analyses.monteCarlo.intervalName, "parameter_uncertainty_simulation_interval");
  assert.match(first.analyses.monteCarlo.interpretation, /not confidence intervals/);
  assert.equal(Object.hasOwn(first.analyses.monteCarlo, "samples"), false);
  assert.equal(first.analyses.sensitivity.sobolInputAssumption, "independent_inputs_only");
  assert.equal(first.analyses.scalarOutput.timeHours, 10);

  assert.equal(first.capability.level, "L3");
  assert.equal(first.capability.independentUnitsDocumented, false);
  assert.equal(first.capability.heldOutValidationEligibleForL4, false);
  assert.equal(first.capability.gates.find(({ level }) => level === "L4").passed, false);
  assert.ok(first.warnings.some(({ code }) => code === "INDEPENDENT_UNIT_DOCUMENTATION_INCOMPLETE"));
  assert.ok(first.warnings.some(({ code }) => code === "RAW_OD_ABSOLUTE_SCALE_NOT_IDENTIFIED"));
  assert.ok(first.warnings.some(({ code }) => code === "OD600_NOT_CFU"));

  assert.equal(first.manifest.dataset.normalizedDatasetFingerprint, NORMALIZED_FINGERPRINT);
  assert.equal(first.manifest.dataset.sourceArtifactSha256, CONTENT_HASH);
  assert.equal(first.manifest.dataset.fingerprint, NORMALIZED_FINGERPRINT);
  assert.equal(first.manifest.splitFingerprint, first.split.splitFingerprint);
  assert.equal(first.manifest.plan.fingerprint, first.lockedPlan.planFingerprint);
  assert.equal(first.manifest.capabilityAssessment.level, "L3");
  assert.equal(first.reproducibility.sourceArtifactSha256, CONTENT_HASH);
  assert.equal(first.reproducibility.sourceContentHash, CONTENT_HASH);
  assert.equal(first.researchPackage.kind, "ecolab.research-package");
  assert.equal(first.researchPackage.replay.selfContained, false);
  assert.equal(first.researchPackage.replay.status, "requires_declared_dependencies");
  assert.deepEqual(first.researchPackage.replay.artifactIds, [
    "normalized-observation-dataset",
    "dataset-split",
    "locked-analysis-plan",
    "resolved-model-snapshot",
  ]);
  assert.deepEqual(
    first.researchPackage.replay.dependencies.map(({ id }) => id),
    [ANALYSIS_IMPLEMENTATION_ID, "regoes-logistic-piecewise-analytic-v1"],
  );
  assert.equal(first.researchPackage.replay.dependencies[0].version, ANALYSIS_ENGINE_VERSION);
  assert.equal(
    first.researchPackage.contents.artifacts["normalized-observation-dataset"].metadata.datasetId,
    first.dataset.id,
  );
  assert.deepEqual(
    first.researchPackage.contents.artifacts["locked-analysis-plan"],
    first.lockedPlan,
  );
  assert.equal(first.researchPackage.contents.analysisManifest.runId, "reduced-stage4-test");
  assert.match(first.methodsSummaryMarkdown, /`EXPLORATORY_PARAMETER_INTERVALS` \[warning\]/);
  assert.match(first.methodsSummaryMarkdown, /not confidence intervals/);
  assert.match(first.methodsSummaryMarkdown, /`OD600_NOT_CFU` \[warning\]/);
  assert.match(first.methodsSummaryMarkdown, /not CFU\/mL/);

  const [analysisRunSchema, researchPackageSchema] = await Promise.all([
    readProjectJson("schemas/analysis-run.schema.json"),
    readProjectJson("schemas/research-package.schema.json"),
  ]);
  assertSchemaValid(first.manifest, analysisRunSchema);
  assertSchemaValid(first.researchPackage, researchPackageSchema, {
    documents: { "analysis-run.schema.json": analysisRunSchema },
  });

  assert.equal(first.methodsSummaryMarkdown, second.methodsSummaryMarkdown);
  assert.deepEqual(first.manifest, second.manifest);
  assert.deepEqual(first.researchPackage.artifactInventory, second.researchPackage.artifactInventory);
});

test("real workflow retains OD semantics in names and warnings", async () => {
  const { datasetText, resolvedModel } = await fixture();
  const result = await runEcolabStage4ResearchWorkflow(reducedOptions(datasetText, resolvedModel));
  const text = JSON.stringify({
    dataset: result.dataset,
    model: result.model,
    training: result.training,
    validation: result.validation,
    warnings: result.warnings,
    methodsSummaryMarkdown: result.methodsSummaryMarkdown,
  }).toLowerCase();

  assert.match(text, /od600/);
  assert.match(text, /observation-layer nuisance parameters/);
  assert.doesNotMatch(text, /cfu conversion/);
  assert.doesNotMatch(text, /blank correction/);
  assert.equal(result.dataset.sourceSemantics, "raw OD600 source values retained without modification");
});

test("workflow rejects non-OD data, exposure, missing conditions, role leakage, incomplete roles, and inserted source t0", async (t) => {
  const { dataset, resolvedModel } = await fixture();
  const cases = [
    {
      name: "non-OD observation",
      mutate(value) { value.observations[0].measurementType = "od595"; },
      code: "NON_OD600_OBSERVATION",
    },
    {
      name: "drug exposure",
      mutate(value) {
        value.observations[0].drugId = "ciprofloxacin";
        value.observations[0].concentrationMgPerL = 0.01;
      },
      code: "DRUG_EXPOSURE_NOT_SUPPORTED",
    },
    {
      name: "missing conditions",
      mutate(value) { delete value.metadata.conditions.temperatureC; },
      code: "MISSING_REQUIRED_CONDITION",
    },
    {
      name: "independent-unit role leakage",
      mutate(value) { value.observations[0].role = "validation"; },
      code: "INDEPENDENT_UNIT_ROLE_LEAKAGE",
    },
    {
      name: "missing validation role",
      mutate(value) {
        for (const observation of value.observations) observation.role = "training";
      },
      code: "INCOMPLETE_TRAINING_VALIDATION_ROLES",
    },
    {
      name: "fabricated t0",
      mutate(value) {
        const fabricated = clone(value.observations[0]);
        fabricated.observationId = `${fabricated.observationId}|fabricated-t0`;
        fabricated.timeHours = 0;
        value.observations.push(fabricated);
      },
      code: "SOURCE_T0_FORBIDDEN",
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, async () => {
      const mutated = clone(dataset);
      entry.mutate(mutated);
      await assert.rejects(
        () => runEcolabStage4ResearchWorkflow({
          datasetInput: mutated,
          resolvedModel,
          seed: 1,
          optimizer: {
            restarts: 1,
            populationSize: 4,
            differentialEvolutionMaxEvaluations: 4,
            nelderMeadMaxEvaluations: 3,
          },
          scanPointsPerAxis: 3,
          monteCarloSamples: 4,
          morrisTrajectories: 1,
          sobolSamples: 2,
          identifiabilityProfilePoints: 3,
        }),
        { code: entry.code },
      );
    });
  }
});
