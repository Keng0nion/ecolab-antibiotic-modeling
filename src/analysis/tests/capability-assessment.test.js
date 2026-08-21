import test from "node:test";
import assert from "node:assert/strict";
import { assessCapability } from "../capability.js";

function l2() {
  return {
    runId: "run-1",
    uncertainty: { completed: true, assumptions: ["measurement errors are independent"] },
    sensitivity: { completed: true, assumptions: ["parameter ranges are scientifically bounded"] },
  };
}

function l3() {
  return {
    ...l2(),
    dataFit: {
      completed: true,
      realData: true,
      conditionsDescribed: true,
      diagnostics: { residualsReviewed: true, convergenceChecked: true },
    },
  };
}

function l4() {
  return {
    ...l3(),
    validation: {
      completed: true,
      locked: true,
      leakageFree: true,
      untouched: true,
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
      splitFingerprint: "a".repeat(64),
    },
  };
}

test("L1 is the conservative default with reasons and warnings", () => {
  const result = assessCapability();
  assert.equal(result.level, "L1");
  assert.ok(result.warnings.some(({ code }) => code === "MISSING_RUN_ID"));
  assert.ok(result.reasons.some(({ code }) => code === "UNCERTAINTY_SENSITIVITY_REQUIRED"));
});

test("L2 requires both completed analyses and documented assumptions", () => {
  assert.equal(assessCapability(l2()).level, "L2");
  assert.equal(assessCapability({
    runId: "run",
    uncertainty: { completed: true },
    sensitivity: { completed: true },
  }).level, "L1");
  assert.equal(assessCapability({
    runId: "run",
    assumptions: ["documented"],
    uncertainty: { completed: true },
    sensitivity: { completed: false },
  }).level, "L1");
});

test("L3 requires real condition-described data fit with diagnostics and all L2 prerequisites", () => {
  assert.equal(assessCapability(l3()).level, "L3");
  assert.equal(assessCapability({
    ...l2(),
    dataFit: { completed: true, realData: false, conditionsDescribed: true, diagnostics: { ok: true } },
  }).level, "L2");
  assert.equal(assessCapability({
    ...l2(),
    dataFit: { completed: true, realData: true, conditionsDescribed: true, diagnostics: {} },
  }).level, "L2");

  const missingPrerequisite = assessCapability({
    runId: "run",
    dataFit: { completed: true, realData: true, conditionsDescribed: true, diagnostics: { ok: true } },
  });
  assert.equal(missingPrerequisite.level, "L1");
  assert.ok(missingPrerequisite.warnings.some(({ code }) => code === "L3_PREREQUISITE_MISSING"));
});

test("L4 requires locked, leakage-free, untouched, documented and explicitly eligible validation", () => {
  assert.equal(assessCapability(l4()).level, "L4");
  const leaked = assessCapability({
    ...l3(),
    validation: {
      completed: true,
      locked: true,
      leakageFree: false,
      untouched: true,
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
    },
  });
  assert.equal(leaked.level, "L3");
  assert.ok(leaked.warnings.some(({ code }) => code === "VALIDATION_LEAKAGE"));

  const touched = assessCapability({
    ...l3(),
    validation: {
      completed: true,
      locked: true,
      leakageFree: true,
      untouched: false,
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
    },
  });
  assert.equal(touched.level, "L3");
  assert.ok(touched.warnings.some(({ code }) => code === "VALIDATION_TOUCHED"));

  const unlocked = assessCapability({
    ...l3(),
    validation: {
      completed: true,
      locked: false,
      leakageFree: true,
      untouched: true,
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
    },
  });
  assert.equal(unlocked.level, "L3");

  const incompletelyDocumented = assessCapability({
    ...l3(),
    validation: {
      completed: true,
      locked: true,
      leakageFree: true,
      untouched: true,
      independentUnitsDocumented: false,
      eligibleAsValidationEvidence: false,
    },
  });
  assert.equal(incompletelyDocumented.level, "L3");
  assert.ok(incompletelyDocumented.warnings.some(
    ({ code }) => code === "L4_VALIDATION_EVIDENCE_INSUFFICIENT",
  ));
  assert.equal(
    incompletelyDocumented.gates.find(({ level }) => level === "L4").code,
    "L4_VALIDATION_EVIDENCE_INSUFFICIENT",
  );
});

test("L4 accepts lock evidence from a dataset split manifest", () => {
  const result = assessCapability({
    ...l3(),
    validation: {
      completed: true,
      leakageFree: true,
      untouched: true,
      independentUnitsDocumented: true,
      eligibleAsValidationEvidence: true,
      split: { lockedValidation: true, splitFingerprint: "a".repeat(64) },
    },
  });
  assert.equal(result.level, "L4");
});

test("L5 requires an independently identified external source and every lower level", () => {
  const result = assessCapability({
    ...l4(),
    externalValidation: {
      completed: true,
      independentSource: true,
      sourceId: "external-laboratory-dataset",
      diagnostics: { calibrationReviewed: true },
    },
  });
  assert.equal(result.level, "L5");

  const notIndependent = assessCapability({
    ...l4(),
    externalValidation: {
      completed: true,
      independentSource: false,
      sourceId: "same-source",
    },
  });
  assert.equal(notIndependent.level, "L4");

  const missingLowerLevels = assessCapability({
    runId: "run",
    externalValidation: {
      completed: true,
      independentSource: true,
      sourceId: "external",
    },
  });
  assert.equal(missingLowerLevels.level, "L1");
  assert.ok(missingLowerLevels.warnings.some(({ code }) => code === "L5_PREREQUISITE_MISSING"));
});

test("assessment is per run and does not accept a preclaimed capability label", () => {
  const result = assessCapability({ runId: "run", capabilityLevel: "L5" });
  assert.equal(result.level, "L1");
  assert.equal(result.runId, "run");
});

test("invalid assumptions and run identifiers are strictly rejected", () => {
  assert.throws(() => assessCapability({ runId: " " }), { code: "INVALID_RUN_ID" });
  assert.throws(() => assessCapability({ assumptions: [""] }), { code: "INVALID_ASSUMPTIONS" });
});
