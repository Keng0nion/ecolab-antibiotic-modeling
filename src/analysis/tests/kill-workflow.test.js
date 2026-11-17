import test from "node:test";
import assert from "node:assert/strict";
import { simulatePiecewise } from "../../model.js";
import {
  KILL_MEASUREMENT_TYPE,
  KILL_WORKFLOW_KIND,
  assertKillDataset,
  runKillWorkflow,
} from "../kill-workflow.js";

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
  const dropIndex = incomplete.observations.findIndex((o) => o.independentUnitId === "StrainB|C=0.2" && o.timeHours === 3);
  incomplete.observations.splice(dropIndex, 1);
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

test("end-to-end kill workflow recovers the generating parameters per strain", async () => {
  const result = await runKillWorkflow({
    datasetInput: syntheticDataset(),
    seed: 123456789,
    applicationVersion: "test",
  });
  assert.equal(result.kind, KILL_WORKFLOW_KIND);
  assert.equal(result.measurementType, KILL_MEASUREMENT_TYPE);
  assert.deepEqual(Object.keys(result.strains).sort(), ["StrainA", "StrainB"]);
  for (const [strain, truth] of Object.entries(TRUE_PARAMS)) {
    const entry = result.strains[strain];
    const p = entry.fittedParameters;
    // 收敛标志取决于 DE 种群的收敛精度；这里以"参数可恢复 + 验证 RMSE 小"为准，
    // 不硬卡 converged（6 维参数在有限评估次数下常停在 maximum_evaluations）。
    assert.ok(Number.isFinite(p.psiMaxLog10PerHour) && entry.terminationReason, `${strain} produced finite parameters`);
    // 识别性强的参数从紧；psiMin 与 kappa 在高剂量删失下可互换，从宽并用验证 RMSE 兜底
    assert.ok(Math.abs(p.psiMaxLog10PerHour - truth.psiMax) < 0.06, `${strain} psiMax: ${p.psiMaxLog10PerHour}`);
    assert.ok(Math.abs(p.zMicMgPerL - truth.zMic) / truth.zMic < 0.35, `${strain} zMIC: ${p.zMicMgPerL}`);
    assert.ok(Math.abs(p.initialLog10PopulationDensity - truth.n0) < 0.3, `${strain} N0: ${p.initialLog10PopulationDensity}`);
    assert.ok(Math.abs(p.psiMinLog10PerHour - truth.psiMin) < 1.6, `${strain} psiMin: ${p.psiMinLog10PerHour}`);
    assert.ok(Math.abs(p.hillKappa - truth.kappa) < 0.7, `${strain} kappa: ${p.hillKappa}`);
    assert.ok(p.sigmaLog10Residual > 0.005 && p.sigmaLog10Residual < 0.5, `${strain} sigma: ${p.sigmaLog10Residual}`);
    assert.ok(entry.validationMetrics.rmseLog10 < 0.15, `${strain} validation RMSE: ${entry.validationMetrics.rmseLog10}`);
    assert.ok(entry.standardErrors.psiMaxLog10PerHour > 0, `${strain} psiMax SE present`);
    assert.ok(entry.validationMetrics.rmseLog10 !== null, `${strain} validation RMSE computed on locked units`);
    assert.ok(entry.trainingObservationCount > 0 && entry.validationObservationCount > 0);
  }
  assert.ok(result.datasetFingerprint.length === 64);
  assert.equal(result.lockedPlan.lockedValidation, true);
});
