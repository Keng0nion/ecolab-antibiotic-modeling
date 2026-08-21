import test from "node:test";
import assert from "node:assert/strict";
import {
  fingerprintAnalysisPlan,
  lockAnalysisPlan,
  validateAnalysisPlan,
  validateLockedAnalysisPlan,
} from "../analysis-plan.js";

function plan(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "analysis-plan",
    id: "fit-plan-1",
    analysisKind: "parameter_fit_and_locked_validation",
    datasetFingerprint: "a".repeat(64),
    splitFingerprint: "b".repeat(64),
    modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
    baseParameterSetRef: { id: "base", version: "1.0.0" },
    parameterSpace: {
      parameters: [{
        name: "psiMaxLog10PerHour",
        lower: 0.1,
        upper: 0.8,
        rationale: "Covers the predeclared plausible growth-rate range.",
      }],
      initialStateSeriesIds: [],
    },
    randomAlgorithm: "xoshiro128ss-splitmix32-v1",
    seeds: { analysis: 42, optimizer: 314 },
    lockedValidation: false,
    parameters: { psiMaxLog10PerHour: 0.3 },
    errorModel: { kind: "fixed_gaussian", sigma: 0.2 },
    exclusions: [{ observationId: "bad-1", rationale: "Predeclared instrument failure." }],
    metrics: ["macro_rmse", "pooled_rmse", "mae"],
    validationIndependentUnitIds: ["validation-1"],
    ...overrides,
  };
}

test("analysis plans validate explicit bounded, rationalized parameter spaces and locked settings", () => {
  const validated = validateAnalysisPlan(plan());
  assert.equal(validated.parameterSpace.parameters[0].transform, "identity");
  assert.deepEqual(validated.seeds, { analysis: 42, optimizer: 314 });
  assert.deepEqual(validated.parameters, { psiMaxLog10PerHour: 0.3 });
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.errorModel), true);
});

test("lockAnalysisPlan is canonical, immutable, non-mutating, and fingerprint-verifiable", async () => {
  const input = plan();
  const snapshot = structuredClone(input);
  const locked = await lockAnalysisPlan(input);
  assert.deepEqual(input, snapshot);
  assert.equal(locked.lockedValidation, true);
  assert.match(locked.planFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(locked.parameterSpace.parameters[0]), true);
  assert.throws(() => { locked.metrics.push("mean_residual"); }, TypeError);
  assert.equal(await fingerprintAnalysisPlan(locked, { requireLocked: true }), locked.planFingerprint);
  assert.deepEqual(await validateLockedAnalysisPlan(locked), locked);

  const reordered = await lockAnalysisPlan({
    ...plan(),
    seeds: { optimizer: 314, analysis: 42 },
    errorModel: { sigma: 0.2, kind: "fixed_gaussian" },
  });
  assert.equal(reordered.planFingerprint, locked.planFingerprint);
});

test("locked analysis plans reject later validation-plan mutation", async () => {
  const locked = await lockAnalysisPlan(plan());
  const changed = structuredClone(locked);
  changed.parameters.psiMaxLog10PerHour = 0.4;
  await assert.rejects(() => validateLockedAnalysisPlan(changed), { code: "PLAN_FINGERPRINT_MISMATCH" });
});

test("analysis plan validation rejects incomplete science declarations and unsafe values", () => {
  assert.throws(
    () => validateAnalysisPlan(plan({
      parameterSpace: {
        parameters: [{ name: "notAllowed", lower: 0, upper: 1, rationale: "No." }],
        initialStateSeriesIds: [],
      },
      parameters: { notAllowed: 0.5 },
    })),
    { code: "PARAMETER_NOT_WHITELISTED" },
  );
  assert.throws(
    () => validateAnalysisPlan(plan({
      parameterSpace: {
        parameters: [{ name: "psiMaxLog10PerHour", lower: 0, upper: 1, rationale: "" }],
        initialStateSeriesIds: [],
      },
    })),
    { code: "INVALID_STRING" },
  );
  assert.throws(() => validateAnalysisPlan(plan({ seeds: { analysis: -1 } })), { code: "INVALID_SEED" });
  assert.throws(
    () => validateAnalysisPlan(plan({ errorModel: { kind: "fixed_gaussian", sigma: NaN } })),
    { code: "NON_FINITE_NUMBER" },
  );
  assert.throws(
    () => validateAnalysisPlan(plan({ parameters: { psiMaxLog10PerHour: 2 } })),
    { code: "LOCKED_PARAMETER_OUT_OF_BOUNDS" },
  );
  assert.throws(() => validateAnalysisPlan(plan({ inventedSetting: true })), { code: "UNKNOWN_PLAN_FIELD" });
  assert.throws(
    () => validateAnalysisPlan(plan({ lockedValidation: false, locked: true })),
    { code: "CONFLICTING_LOCK_SETTINGS" },
  );
  const sparse = [];
  sparse[1] = "mae";
  assert.throws(() => validateAnalysisPlan(plan({ metrics: sparse })), { code: "SPARSE_ARRAY" });
});
