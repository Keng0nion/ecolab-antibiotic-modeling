import test from "node:test";
import assert from "node:assert/strict";
import { fingerprintValue, validateLockedPlan } from "../validation.js";

const observations = [
  {
    id: "v1",
    role: "validation",
    independentUnitId: "validation-batch-1",
    value: 2,
    x: 1,
  },
  {
    id: "v2",
    role: "validation",
    independentUnitId: "validation-batch-2",
    value: 4,
    x: 2,
  },
];

function plan() {
  return {
    id: "locked-plan",
    locked: true,
    datasetFingerprint: "dataset:v1",
    splitFingerprint: "split:v1",
    parameters: { slope: 2 },
    errorModel: { kind: "fixed_gaussian", sigma: 0.5 },
    exclusions: [],
    metrics: ["macro_rmse", "pooled_rmse", "mae"],
    validationIndependentUnitIds: ["validation-batch-1", "validation-batch-2"],
  };
}

function validOptions() {
  return {
    plan: plan(),
    observations,
    datasetFingerprint: "dataset:v1",
    splitFingerprint: "split:v1",
    trainingIndependentUnitIds: ["training-batch-1"],
    predictor: ({ slope }, observation) => slope * observation.x,
  };
}

test("locked validation reports procedural holdout evaluation without granting evidence eligibility", () => {
  const result = validateLockedPlan(validOptions());
  assert.equal(result.metrics.pooledRmse, 0);
  assert.deepEqual(result.parameters, { slope: 2 });
  assert.deepEqual(
    {
      role: result.role,
      evidenceStatus: result.evidenceStatus,
      fittedOnThisData: result.fittedOnThisData,
      eligibleAsValidationEvidence: result.eligibleAsValidationEvidence,
      parametersAltered: result.parametersAltered,
    },
    {
      role: "locked_holdout_evaluation",
      evidenceStatus: "procedural_locked_holdout_evaluation",
      fittedOnThisData: false,
      eligibleAsValidationEvidence: false,
      parametersAltered: false,
    },
  );
  assert.equal(result.independentUnitsDocumented, false);
  assert.equal(result.evidenceQualificationSource, "not_provided");
});

test("validation evidence qualification is supplied by the caller and cannot conflict", () => {
  const result = validateLockedPlan({
    ...validOptions(),
    evidenceQualification: {
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
    },
  });
  assert.equal(result.independentUnitsDocumented, true);
  assert.equal(result.eligibleAsValidationEvidence, true);
  assert.equal(result.evidenceQualificationSource, "caller_supplied");

  const direct = validateLockedPlan({
    ...validOptions(),
    independentUnitsDocumented: true,
    eligibleAsValidationEvidence: true,
  });
  assert.equal(direct.independentUnitsDocumented, true);
  assert.equal(direct.eligibleAsValidationEvidence, true);

  assert.throws(
    () => validateLockedPlan({
      ...validOptions(),
      evidenceQualification: {
        independentUnitsDocumented: false,
        eligibleAsValidationEvidence: true,
      },
    }),
    { code: "CONFLICTING_VALIDATION_EVIDENCE_QUALIFICATION" },
  );
  assert.throws(
    () => validateLockedPlan({
      ...validOptions(),
      independentUnitsDocumented: false,
      evidenceQualification: { independentUnitsDocumented: true },
    }),
    { code: "CONFLICTING_VALIDATION_EVIDENCE_QUALIFICATION" },
  );
});

test("validation rejects runtime plan changes", () => {
  assert.throws(
    () => validateLockedPlan({ ...validOptions(), parameters: { slope: 4 } }),
    { code: "VALIDATION_PARAMETER_OVERRIDE" },
  );
  assert.throws(
    () => validateLockedPlan({ ...validOptions(), metrics: ["mae"] }),
    { code: "VALIDATION_PLAN_OVERRIDE" },
  );
});

test("validation rejects fingerprint changes and independent-unit leakage", () => {
  assert.throws(
    () => validateLockedPlan({ ...validOptions(), datasetFingerprint: "dataset:changed" }),
    { code: "DATASET_FINGERPRINT_MISMATCH" },
  );
  assert.throws(
    () =>
      validateLockedPlan({
        ...validOptions(),
        trainingIndependentUnitIds: ["validation-batch-2"],
      }),
    { code: "INDEPENDENT_UNIT_LEAKAGE" },
  );
});

test("validation verifies complete dataset and split objects with existing SHA-256 shapes", () => {
  const dataset = { metadata: { datasetId: "dataset-1" }, observations };
  const splitWithoutFingerprint = {
    lockedValidation: true,
    sourceDatasetFingerprint: fingerprintValue(dataset),
    roles: {
      training: { independentUnitIds: ["training-batch-1"] },
      development: { independentUnitIds: [] },
      validation: {
        independentUnitIds: ["validation-batch-1", "validation-batch-2"],
      },
    },
  };
  const split = {
    ...splitWithoutFingerprint,
    splitFingerprint: fingerprintValue(splitWithoutFingerprint),
  };
  const lockedPlan = {
    ...plan(),
    locked: undefined,
    lockedValidation: true,
    datasetFingerprint: fingerprintValue(dataset),
    splitFingerprint: split.splitFingerprint,
  };
  const result = validateLockedPlan({
    plan: lockedPlan,
    observations,
    dataset,
    split,
    predictor: ({ slope }, observation) => slope * observation.x,
  });
  assert.equal(result.completed, true);
  assert.equal(result.locked, true);
  assert.equal(result.leakageFree, true);
  assert.equal(result.untouched, true);

  let called = false;
  assert.throws(
    () =>
      validateLockedPlan({
        plan: lockedPlan,
        observations: [{ ...observations[0], value: 999 }, observations[1]],
        dataset,
        split,
        predictor: () => {
          called = true;
          return 0;
        },
      }),
    { code: "VALIDATION_OBSERVATIONS_CHANGED" },
  );
  assert.equal(called, false);
});

test("validation rejects training-role observations before prediction", () => {
  let called = false;
  assert.throws(
    () =>
      validateLockedPlan({
        ...validOptions(),
        observations: [{ ...observations[0], role: "training" }],
        predictor: () => {
          called = true;
          return 0;
        },
      }),
    { code: "TRAINING_DATA_IN_VALIDATION" },
  );
  assert.equal(called, false);
});
