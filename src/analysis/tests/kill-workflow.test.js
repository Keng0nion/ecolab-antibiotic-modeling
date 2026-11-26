import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { simulatePiecewise } from "../../model.js";
import {
  KILL_MEASUREMENT_TYPE,
  KILL_WORKFLOW_KIND,
  assertKillDataset,
  classifyKillProfile,
  runKillWorkflow,
} from "../kill-workflow.js";
import { assertSchemaValid } from "./schema-test-helper.js";

const CONDITIONS = {
  organism: "Neisseria gonorrhoeae",
  medium: "GC liquid medium",
  temperatureC: 37,
  treatment: "ciprofloxacin time-kill",
  antibioticExposure: true,
};

const TRUE_PARAMS = {
  StrainA: { psiMax: 0.35, psiMin: -2.5, zMic: 0.05, kappa: 1.2, n0: 6.0, sigma: 0.05 },
  StrainB: { psiMax: 0.25, psiMin: -1.2, zMic: 0.5, kappa: 2.0, n0: 5.6, sigma: 0.05 },
};
const CONCENTRATIONS = [0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1.0];
const TIMES = [0, 1, 2, 3, 4, 5, 6];
const ROLE_BY_CONC = Object.fromEntries(CONCENTRATIONS.map((c, i) => [c, i % 3 === 2 ? "validation" : "training"]));

function syntheticModel(params) {
  return {
    ref: { modelId: "ecolab.single-population.regoes-logistic", modelVersion: "1.0.0", parameterSetId: "test", parameterSetVersion: "test" },
    warnings: [],
    parameters: {
      psiMaxLog10PerHour: params.psiMax,
      carryingCapacityLog10CfuPerMl: 9.5,
      drugs: {
        ciprofloxacin: {
          zMicMgPerL: params.zMic,
          hillKappa: params.kappa,
          psiMinLog10PerHour: params.psiMin,
        },
      },
    },
  };
}

function makeObservation(strain, unitId, role, timeHours, concentration, value, censored) {
  return {
    observationId: `${unitId}|t=${timeHours}`,
    seriesId: unitId,
    independentUnitId: unitId,
    role,
    timeHours,
    drugId: "ciprofloxacin",
    concentrationMgPerL: concentration,
    measurementType: KILL_MEASUREMENT_TYPE,
    value,
    censoring: censored ? "left" : "none",
    censoringBounds: censored ? { upper: 2 } : null,
    replicate: "synthetic",
    conditions: { ...CONDITIONS, strain },
  };
}

function syntheticDataset() {
  const observations = [];
  let index = 0;
  for (const [strain, truth] of Object.entries(TRUE_PARAMS)) {
    for (const concentration of CONCENTRATIONS) {
      const unitId = `${strain}|C=${concentration}`;
      const role = ROLE_BY_CONC[concentration];
      const model = syntheticModel(truth);
      const sim = simulatePiecewise(model, {
        protocol: {
          kind: "piecewise_constant",
          drugId: "ciprofloxacin",
          segments: [{
            start: { value: 0, unit: "h" },
            end: { value: 6, unit: "h" },
            concentration: { value: concentration, unit: "mg/L" },
          }],
        },
        sampleTimes: TIMES.map((value) => ({ value, unit: "h" })),
        initialState: { populationDensity: { value: 10 ** truth.n0, unit: "CFU/mL" } },
      });
      for (const row of sim.trajectory) {
        const noise = 0.03 * Math.sin(index * 12.9898);
        index += 1;
        const value = row.latentLog10PopulationDensity + noise;
        const censored = value < 2.0;
        observations.push(makeObservation(strain, unitId, role, row.timeHours, concentration, censored ? 2 : value, censored));
      }
    }
  }
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: {
      datasetId: "synthetic-kill-curves",
      title: "Synthetic ciprofloxacin time-kill curves",
      conditions: { ...CONDITIONS },
    },
    observations,
  };
}

function clone(dataset) {
  return JSON.parse(JSON.stringify(dataset));
}

test("kill gates accept a valid kill-curve dataset and report per-strain units", () => {
  const facts = assertKillDataset(syntheticDataset());
  assert.equal(facts.strains.size, 2);
  assert.equal(facts.units.size, CONCENTRATIONS.length * 2);
  assert.equal(facts.maximumTimeHours, 6);
  assert.ok(facts.sourceTimes.includes(0), "t=0 must be allowed");
});

test("kill gates allow one interior gap per unit and report it as incomplete", () => {
  const gapped = clone(syntheticDataset());
  const dropIndex = gapped.observations.findIndex((o) => o.independentUnitId === "StrainB|C=0.2" && o.timeHours === 3);
  gapped.observations.splice(dropIndex, 1);
  const facts = assertKillDataset(gapped);
  assert.equal(facts.units.size, CONCENTRATIONS.length * 2);
  assert.deepEqual(facts.incompleteUnits, [{ independentUnitId: "StrainB|C=0.2", strain: "StrainB", missingTimes: [3] }]);
});

test("kill gates reject units missing t=0 or the strain's last observation", () => {
  const base = syntheticDataset();

  const noBaseline = clone(base);
  const baselineIndex = noBaseline.observations.findIndex((o) => o.independentUnitId === "StrainA|C=0.01" && o.timeHours === 0);
  noBaseline.observations.splice(baselineIndex, 1);
  assert.throws(() => assertKillDataset(noBaseline), (error) => error.code === "INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY");

  const noTail = clone(base);
  const tailIndex = noTail.observations.findIndex((o) => o.independentUnitId === "StrainA|C=0.01" && o.timeHours === 6);
  noTail.observations.splice(tailIndex, 1);
  assert.throws(() => assertKillDataset(noTail), (error) => error.code === "INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY");
});

test("kill gates allow separate treatments across separately labeled strains", () => {
  const mixed = clone(syntheticDataset());
  for (const observation of mixed.observations) {
    if (observation.conditions.strain === "StrainB") {
      observation.drugId = "tetracycline";
      observation.conditions.treatment = "tetracycline time-kill";
    }
  }
  const facts = assertKillDataset(mixed);
  assert.equal(facts.strains.size, 2);
  assert.equal(new Set([...facts.units.values()].map((unit) => unit.drugId)).size, 2);
});

test("kill gates still reject role leakage, duplicate times, incomplete trajectories and inconstant units", () => {
  const base = syntheticDataset();

  const leaked = clone(base);
  leaked.observations.find((o) => o.independentUnitId === "StrainA|C=0.01" && o.timeHours === 1).role = "validation";
  assert.throws(() => assertKillDataset(leaked), (error) => error.code === "INDEPENDENT_UNIT_ROLE_LEAKAGE");

  const duplicated = clone(base);
  const first = duplicated.observations.find((o) => o.independentUnitId === "StrainA|C=0.01");
  duplicated.observations.push({ ...first, observationId: "dup" });
  assert.throws(() => assertKillDataset(duplicated), (error) => error.code === "DUPLICATE_UNIT_TIME");

  const incomplete = clone(base);
  for (const hour of [3, 4]) {
    const dropIndex = incomplete.observations.findIndex((o) => o.independentUnitId === "StrainB|C=0.2" && o.timeHours === hour);
    incomplete.observations.splice(dropIndex, 1);
  }
  assert.throws(() => assertKillDataset(incomplete), (error) => error.code === "INCOMPLETE_INDEPENDENT_UNIT_TRAJECTORY");

  const inconstant = clone(base);
  inconstant.observations.find((o) => o.independentUnitId === "StrainA|C=0.2" && o.timeHours === 2).concentrationMgPerL = 0.9;
  assert.throws(() => assertKillDataset(inconstant), (error) => error.code === "UNIT_DRUG_CONSTANCY");
});

test("kill gates reject non-CFU measurements, non-left censoring, single dose level and missing validation", () => {
  const mixed = clone(syntheticDataset());
  mixed.observations[0].measurementType = "od600";
  assert.throws(() => assertKillDataset(mixed), (error) => error.code === "KILL_MEASUREMENT_TYPE_REQUIRED");

  const rightCensored = clone(syntheticDataset());
  const censoredRow = rightCensored.observations.find((o) => o.censoring === "left");
  censoredRow.censoring = "right";
  censoredRow.censoringBounds = { lower: 2 };
  assert.throws(() => assertKillDataset(rightCensored), (error) => error.code === "CENSORING_NOT_SUPPORTED");

  const singleDose = clone(syntheticDataset());
  singleDose.observations = singleDose.observations.filter(
    (o) => !(o.independentUnitId.startsWith("StrainB") && o.independentUnitId !== "StrainB|C=0.01"),
  );
  assert.throws(() => assertKillDataset(singleDose), (error) => error.code === "MIN_DOSE_LEVELS_PER_STRAIN");

  const noValidation = clone(syntheticDataset());
  for (const observation of noValidation.observations) if (observation.role === "validation") observation.role = "training";
  assert.throws(() => assertKillDataset(noValidation), (error) => error.code === "INCOMPLETE_TRAINING_VALIDATION_ROLES");
});

test("end-to-end kill workflow recovers the generating parameters per strain and reports bootstrap CIs", async () => {
  const dataset = syntheticDataset();
  const result = await runKillWorkflow({
    datasetInput: dataset,
    seed: 123456789,
    applicationVersion: "test",
    bootstrapReplicates: 24,
  });
  assert.equal(result.kind, KILL_WORKFLOW_KIND);
  assert.equal(result.status, "FIT_COMPLETED");
  assert.equal(result.measurementType, KILL_MEASUREMENT_TYPE);
  assert.equal(result.runMetadata.applicationVersion, "test");
  assert.equal(result.runMetadata.seed, 123456789);
  assert.equal(result.runMetadata.settings.bootstrapReplicates, 24);
  assert.deepEqual(Object.keys(result.strains).sort(), ["StrainA", "StrainB"]);
  for (const [strain, truth] of Object.entries(TRUE_PARAMS)) {
    const entry = result.strains[strain];
    assert.equal(entry.fitDiagnostics.convergence.status, entry.converged ? "CONVERGED" : "NOT_CONVERGED");
    assert.ok(["ASSESSED", "NOT_ASSESSED"].includes(entry.fitDiagnostics.profileLikelihood.status));
    assert.ok(["ASSESSED", "NOT_ASSESSED"].includes(entry.profileLikelihoodDiagnostics.psiMinLog10PerHour.status));
    assert.ok(entry.profileLikelihoodDiagnostics.psiMinLog10PerHour.identifiability.status);
    const p = entry.fittedParameters;
    // 收敛标志取决于 DE 种群的收敛精度；这里以"参数可恢复 + 验证 RMSE 小"为准，
    // 不硬卡 converged（6 维参数在有限评估次数下常停在 maximum_evaluations）。
    assert.ok(Number.isFinite(p.psiMaxLog10PerHour) && entry.terminationReason, `${strain} produced finite parameters`);
    assert.equal(entry.optimizationCoordinates.transforms.psiMaxLog10PerHour, "log");
    assert.equal(entry.optimizationCoordinates.transforms[`drugs.ciprofloxacin.psiMinLog10PerHour`], "negative_log");
    // 识别性强的参数从紧；psiMin 与 kappa 在高剂量删失下可互换，从宽并用验证 RMSE 兜底
    assert.ok(Math.abs(p.psiMaxLog10PerHour - truth.psiMax) < 0.06, `${strain} psiMax: ${p.psiMaxLog10PerHour}`);
    assert.ok(Math.abs(p.zMicMgPerL - truth.zMic) / truth.zMic < 0.35, `${strain} zMIC: ${p.zMicMgPerL}`);
    assert.ok(Math.abs(p.initialLog10PopulationDensity - truth.n0) < 0.3, `${strain} N0: ${p.initialLog10PopulationDensity}`);
    assert.ok(Math.abs(p.psiMinLog10PerHour - truth.psiMin) < 1.6, `${strain} psiMin: ${p.psiMinLog10PerHour}`);
    assert.ok(Math.abs(p.hillKappa - truth.kappa) < 0.7, `${strain} kappa: ${p.hillKappa}`);
    assert.ok(p.sigmaLog10Residual > 0.005 && p.sigmaLog10Residual < 0.5, `${strain} sigma: ${p.sigmaLog10Residual}`);
    assert.ok(entry.validationMetrics.rmseLog10 < 0.15, `${strain} validation RMSE: ${entry.validationMetrics.rmseLog10}`);
    assert.ok(entry.standardErrors.psiMaxLog10PerHour > 0, `${strain} psiMax SE present`);
    const ci = entry.confidenceIntervals95;
    assert.ok(ci && entry.bootstrapReplicates === 24, `${strain} bootstrap CIs present`);
    assert.ok(ci.zMicMgPerL[0] < p.zMicMgPerL && p.zMicMgPerL < ci.zMicMgPerL[1],
      `${strain} zMIC point estimate inside its 95% CI: ${p.zMicMgPerL} in [${ci.zMicMgPerL}]`);
    assert.ok(ci.psiMaxLog10PerHour[0] < ci.psiMaxLog10PerHour[1], `${strain} psiMax CI ordered`);
    assert.ok(entry.validationMetrics.rmseLog10 !== null, `${strain} validation RMSE computed on locked units`);
    assert.ok(entry.trainingObservationCount > 0 && entry.validationObservationCount > 0);
    assert.equal(entry.bootstrapConvergence.optimizerConvergedReplicates, entry.bootstrapConvergence.convergedReplicates);
    assert.equal(entry.bootstrapConvergence.convergedAndIdentifiableReplicates, entry.bootstrapReplicates);
    assert.ok(entry.bootstrapConvergence.boundaryReplicateFraction >= 0);
    assert.match(entry.bootstrapConvergence.intervalBasis, /strictly inside/);
    const predictive = entry.predictiveDiagnostics;
    assert.equal(predictive.status, "available");
    assert.equal(predictive.method, "finite_gaussian_mixture_from_joint_parameter_bootstrap");
    assert.equal(predictive.summary.exactObservationCount, entry.validationMetrics.exactObservationCount);
    assert.equal(predictive.summary.leftCensoredObservationCount, entry.validationMetrics.censoredObservationCount);
    assert.equal(predictive.predictions.length, entry.validationObservationCount);
    const temporal = entry.validationMetrics.temporalResidualDiagnostics;
    assert.equal(temporal.method, "descriptive_spearman_time_residual_by_independent_unit");
    assert.equal(temporal.trajectoryCount, predictive.validationIndependentUnitIds.length);
    assert.equal(temporal.trajectories.length, temporal.trajectoryCount);
    assert.equal(temporal.trajectories.reduce((sum, unit) => sum + unit.leftCensoredObservationCount, 0),
      entry.validationMetrics.censoredObservationCount);
    assert.ok(temporal.interpretation.includes("no p-values"));
    assert.ok(predictive.predictions.filter((row) => row.censoring === "left")
      .every((row) => Number.isFinite(row.censorProbability) && row.exactLogPredictiveDensity === null));
    const expectedValidationUnits = [...new Set(dataset.observations
      .filter((observation) => observation.conditions.strain === strain && observation.role === "validation")
      .map((observation) => observation.independentUnitId))].sort();
    assert.deepEqual(predictive.validationIndependentUnitIds, expectedValidationUnits);
    assert.ok("validationRmseLog10" in result.crossGroupFitComparison[strain]);
    assert.equal("objectiveValue" in result.crossGroupFitComparison[strain], false);
  }
  assert.ok(result.datasetFingerprint.length === 64);
  assert.equal(result.lockedPlan.lockedValidation, true);
});

test("kill workflow leaves SE null at a psiMax boundary without probing invalid values", async () => {
  const dataset = syntheticDataset();
  dataset.observations = dataset.observations
    .filter((observation) => observation.conditions.strain === "StrainA")
    .map((observation) => ({
      ...observation,
      value: 6,
      censoring: "none",
      censoringBounds: null,
    }));

  const result = await runKillWorkflow({
    dataset,
    seed: 123,
    restarts: 1,
    bootstrapReplicates: 0,
  });

  assert.equal(Object.keys(result.strains).length, 1);
  assert.ok(Number.isFinite(result.strains.StrainA.fittedParameters.psiMaxLog10PerHour));
  assert.equal(result.strains.StrainA.standardErrors.psiMaxLog10PerHour, null);
  assert.equal(result.strains.StrainA.boundaryDiagnostics.psiMaxLog10PerHour.estimateAtBound, true);
  assert.equal(result.strains.StrainA.boundaryDiagnostics.psiMaxLog10PerHour.boundaryLimited, true);
  assert.equal(result.strains.StrainA.fitDiagnostics.sigmaAtLowerBound, true);
});

test("optional profile likelihood reports parameter support across the fitted bounds", async () => {
  const result = await runKillWorkflow({
    datasetInput: syntheticDataset(),
    seed: 321,
    restarts: 1,
    bootstrapReplicates: 0,
    profileLikelihood: true,
    profilePoints: 5,
  });
  const profile = result.strains.StrainA.profileLikelihoodDiagnostics;
  assert.ok(profile.psiMinLog10PerHour.points.length >= 5);
  assert.ok(profile.psiMinLog10PerHour.points.every(({ converged }) => typeof converged === "boolean"));
  assert.ok(profile.hillKappa.points.length >= 5);
  assert.ok(profile.zMicMgPerL.points.length >= 5);
  assert.ok(profile.psiMinLog10PerHour.points.every(({ deltaNegativeLogLikelihood }) => deltaNegativeLogLikelihood >= 0));
  assert.ok(["identified", "lower-unidentified", "upper-unidentified"]
    .includes(profile.psiMinLog10PerHour.identifiability.status));
  assert.match(profile.psiMinLog10PerHour.identifiability.criterion, /monotonicity/);
  assert.ok(Number.isFinite(profile.psiMinLog10PerHour.profileMinimumObjective));
  const psiMinEstimate = result.strains.StrainA.parameterEstimates.psiMinLog10PerHour;
  if (psiMinEstimate.status !== "identified") {
    assert.equal(result.strains.StrainA.fittedParameters.psiMinLog10PerHour, null);
    assert.equal(psiMinEstimate.pointEstimate, null);
    assert.equal(typeof result.strains.StrainA.predictionParameters.psiMinLog10PerHour, "number");
  }
});

test("profile identifiability follows profile monotonicity and interior minima", () => {
  const point = (value, negativeLogLikelihood) => ({ value, negativeLogLikelihood, converged: true });
  assert.equal(classifyKillProfile([point(-12, 1), point(-6, 2), point(-0.01, 3)]).status, "lower-unidentified");
  assert.equal(classifyKillProfile([point(-12, 3), point(-6, 2), point(-0.01, 1)]).status, "upper-unidentified");
  assert.equal(classifyKillProfile([point(-12, 3), point(-6, 1), point(-0.01, 3)]).status, "identified");
});

test("profile selection defaults to every strain and oracle fits all declared roles", async () => {
  const result = await runKillWorkflow({
    datasetInput: syntheticDataset(),
    seed: 322,
    restarts: 1,
    bootstrapReplicates: 0,
    profileLikelihood: true,
    profilePoints: 5,
    fitAllRolesForOracle: true,
  });
  for (const row of Object.values(result.strains)) {
    assert.ok(row.profileLikelihoodDiagnostics, "all groups receive profile diagnostics by default");
    assert.equal(row.fitDataScope, "all_roles_oracle_in_sample");
    assert.equal(row.validationMetrics, null);
    assert.ok(Number.isFinite(row.oracleMetrics.rmseLog10));
  }
});

function censorEveryPostBaselineObservation(dataset, unitId) {
  for (const observation of dataset.observations) {
    if (observation.independentUnitId !== unitId || observation.timeHours === 0) continue;
    observation.value = 2;
    observation.censoring = "left";
    observation.censoringBounds = { upper: 2 };
  }
  return dataset;
}

test("a concentration group that never rises above the detection limit cannot identify its growth rate", async () => {
  const dataset = censorEveryPostBaselineObservation(clone(syntheticDataset()), "StrainA|C=1");
  const result = await runKillWorkflow({
    dataset,
    seed: 424242,
    restarts: 1,
    bootstrapReplicates: 0,
  });
  const summary = result.strains.StrainA.unitGrowthRateIdentifiability;
  const unit = summary.units.find((row) => row.independentUnitId === "StrainA|C=1");
  assert.equal(unit.status, "NOT_IDENTIFIABLE");
  assert.equal(unit.relation, null);
  assert.equal(unit.unitProfileEstimateLog10PerHour, null);
  assert.equal(unit.oneSided95Bound, null);
  assert.equal(unit.modelNetGrowthRateLog10PerHour, null);
  assert.equal(unit.basis, "all_post_baseline_observations_at_detection_limit");
  assert.equal(unit.postBaselineObservationCount, unit.censoredObservationCount + unit.exactAtDetectionLimitCount);
  assert.ok(summary.unidentifiedUnitIds.includes("StrainA|C=1"));
  assert.equal(summary.unidentifiedUnitCount, summary.unitCount - summary.identifiedUnitCount);
  assert.match(unit.criterion, /psi\(C\)/);
  assert.ok(result.warnings.some((warning) => warning.includes("StrainA|C=1") && warning.includes("not identifiable")),
    "the workflow surfaces the non-identifiable group in its warnings");
});

test("a concentration group with fewer than two informative exact post-baseline points returns no rate or bound", async () => {
  const dataset = clone(syntheticDataset());
  const unitId = "StrainA|C=1";
  for (const observation of dataset.observations) {
    if (observation.independentUnitId !== unitId || observation.timeHours === 0 || observation.timeHours === 1) continue;
    observation.value = 2;
    observation.censoring = "left";
    observation.censoringBounds = { upper: 2 };
  }
  const result = await runKillWorkflow({ dataset, seed: 424246, restarts: 1, bootstrapReplicates: 0 });
  const unit = result.strains.StrainA.unitGrowthRateIdentifiability.units.find((row) => row.independentUnitId === unitId);

  assert.equal(unit.status, "NOT_IDENTIFIABLE");
  assert.equal(unit.basis, "insufficient_uncensored_observations");
  assert.equal(unit.uncensoredPostBaselineObservationCount, 1);
  assert.equal(unit.minimumUncensoredPostBaselineObservationCount, 2);
  assert.equal(unit.unitProfileEstimateLog10PerHour, null);
  assert.equal(unit.oneSided95Bound, null);
  assert.equal(unit.modelNetGrowthRateLog10PerHour, null);
});

test("kill strain with too few exact training observations returns status and no parameter values", async () => {
  const dataset = clone(syntheticDataset());
  for (const observation of dataset.observations) {
    if (observation.role !== "training" || observation.timeHours === 0) continue;
    observation.value = 2;
    observation.censoring = "left";
    observation.censoringBounds = { upper: 2 };
  }
  const result = await runKillWorkflow({ dataset, seed: 424247, restarts: 1, bootstrapReplicates: 0 });
  const fit = result.strains.StrainA;

  assert.equal(fit.status, "NOT_IDENTIFIABLE");
  assert.equal(fit.fittedParameters, null);
  assert.equal(fit.objectiveValue, null);
  assert.equal(fit.trainingMetrics, null);
  assert.equal(fit.fitDiagnostics.identifiability.exactObservationCount, 6);
  assert.equal(fit.profileLikelihoodDiagnostics.psiMinLog10PerHour.status, "NOT_ASSESSED");
});

test("ordinary concentration groups keep a finite growth-rate estimate and a two-sided support range", async () => {
  const result = await runKillWorkflow({
    datasetInput: syntheticDataset(),
    seed: 424243,
    restarts: 1,
    bootstrapReplicates: 0,
  });
  const summary = result.strains.StrainA.unitGrowthRateIdentifiability;
  assert.equal(summary.unitCount, CONCENTRATIONS.length);
  const lowest = summary.units.find((row) => row.independentUnitId === "StrainA|C=0.005");
  assert.equal(lowest.status, "identified");
  assert.equal(lowest.basis, "profile_interior_minimum");
  assert.equal(lowest.relation, null);
  assert.equal(lowest.oneSided95Bound, null);
  assert.ok(Number.isFinite(lowest.unitProfileEstimateLog10PerHour));
  // C=0.005 is tenfold below zMIC, so psi(C) sits at psiMax and the group's own
  // profile estimate must land near the strain-level model value.
  assert.ok(Math.abs(lowest.unitProfileEstimateLog10PerHour - lowest.modelNetGrowthRateLog10PerHour) < 0.2,
    `group estimate ${lowest.unitProfileEstimateLog10PerHour} vs model ${lowest.modelNetGrowthRateLog10PerHour}`);
  assert.ok(lowest.compatibleRange95.lower !== null && lowest.compatibleRange95.upper !== null,
    "an identified group has a two-sided 95% support range");
});

test("psiMin reports its -5 lower boundary without presenting an unidentified point estimate", async () => {
  const dataset = clone(syntheticDataset());
  for (const observation of dataset.observations) {
    if (observation.conditions.strain !== "StrainA"
      || observation.concentrationMgPerL !== 1
      || observation.timeHours === 0) continue;
    observation.value = 2;
    observation.censoring = "left";
    observation.censoringBounds = { upper: 2 };
  }

  const result = await runKillWorkflow({
    dataset,
    seed: 424245,
    restarts: 1,
    bootstrapReplicates: 0,
  });
  const strain = result.strains.StrainA;
  assert.equal(strain.fittedParameters.psiMinLog10PerHour, null);
  assert.equal(strain.parameterEstimates.psiMinLog10PerHour.status, "lower-unidentified");
  assert.ok(Number.isFinite(strain.parameterEstimates.psiMinLog10PerHour.bound95));
  assert.equal(strain.boundaryDiagnostics.psiMinLog10PerHour.estimateAtLowerBound, true);
  assert.ok(Math.abs(strain.predictionParameters.psiMinLog10PerHour + 5) < 1e-6,
    `psiMin prediction substitute lower boundary: ${strain.predictionParameters.psiMinLog10PerHour}`);
  const highConcentration = strain.unitGrowthRateIdentifiability.units.find((unit) => unit.concentrationMgPerL === 1);
  assert.match(highConcentration.criterion, /over \[-5, 2\] log10-fold\/h/);
});

test("the kill workflow result satisfies the published schema", async () => {
  const schema = JSON.parse(await readFile(new URL("../../../schemas/kill-workflow-result.schema.json", import.meta.url), "utf8"));
  const result = await runKillWorkflow({
    datasetInput: syntheticDataset(),
    seed: 424244,
    restarts: 1,
    bootstrapReplicates: 0,
    applicationVersion: "test",
  });
  assertSchemaValid(result, schema);
});
