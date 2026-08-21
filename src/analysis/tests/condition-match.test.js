import test from "node:test";
import assert from "node:assert/strict";
import { matchConditions } from "../condition-match.js";

const target = {
  organism: "Escherichia coli",
  strain: "BW25113",
  medium: "M9",
  temperature: { value: 37, unit: "degC" },
  aeration: "200 rpm",
  measurementType: "log10_cfu_per_ml",
};

test("all documented fields match exactly", () => {
  const result = matchConditions(target, structuredClone(target));
  assert.equal(result.status, "matched");
  assert.equal(result.summary.matchedFieldCount, 6);
  assert.equal(result.criticalMismatches.length, 0);
  assert.equal(result.mismatches.length, 0);
  assert.ok(result.reasons.some(({ code }) => code === "ALL_DOCUMENTED_FIELDS_MATCH"));
});

test("non-critical mismatch returns partially_matched with visible field evidence", () => {
  const result = matchConditions(target, { ...target, aeration: "static" });
  assert.equal(result.status, "partially_matched");
  assert.deepEqual(result.mismatches.map(({ field }) => field), ["aeration"]);
  assert.equal(result.criticalMismatches.length, 0);
  assert.equal(result.fields.find(({ field }) => field === "aeration").status, "incompatible");
});

test("critical mismatch returns incompatible and cannot be hidden behind the summary counts", () => {
  const candidate = { ...target, strain: "MG1655", aeration: "static" };
  const result = matchConditions(target, candidate);
  assert.equal(result.status, "incompatible");
  assert.deepEqual(result.criticalMismatches.map(({ field }) => field), ["strain"]);
  assert.equal(result.summary.criticalMismatchCount, 1);
  assert.ok(result.reasons.some(({ code }) => code === "CRITICAL_CONDITION_MISMATCH"));
});

test("critical mismatch is transferred_calibration only when transfer is explicitly declared", () => {
  const result = matchConditions(target, { ...target, strain: "CAB1", medium: "LB" }, {
    transferredCalibration: true,
  });
  assert.equal(result.status, "transferred_calibration");
  assert.deepEqual(result.criticalMismatches.map(({ field }) => field), ["medium", "strain"]);
  assert.ok(result.reasons.some(({ code }) => code === "TRANSFERRED_CRITICAL_MISMATCH"));
});

test("missing condition fields are unknown and produce a partially matched result when other fields match", () => {
  const result = matchConditions(target, {
    organism: "Escherichia coli",
    strain: "BW25113",
  });
  assert.equal(result.status, "partially_matched");
  assert.deepEqual(result.unknownFields.map(({ field }) => field), ["aeration", "measurementType", "medium", "temperature"]);
  assert.ok(result.warnings.some(({ code }) => code === "UNKNOWN_CONDITION_FIELDS"));
});

test("no comparable fields returns unknown", () => {
  const result = matchConditions({}, {}, { fields: ["organism"] });
  assert.equal(result.status, "unknown");
  assert.equal(result.summary.unknownCount, 1);
  assert.ok(result.reasons.some(({ code }) => code === "NO_COMPARABLE_CONDITIONS"));
});

test("explicit comparator supports documented tolerances without implicit unit conversion", () => {
  const result = matchConditions(
    { temperature: { value: 37, unit: "degC" } },
    { temperature: { value: 37.2, unit: "degC" } },
    {
      fields: ["temperature"],
      criticalFields: ["temperature"],
      comparators: {
        temperature(left, right) {
          return left.unit === right.unit && Math.abs(left.value - right.value) <= 0.5;
        },
      },
    },
  );
  assert.equal(result.status, "matched");

  const unitsDiffer = matchConditions(
    { temperature: { value: 37, unit: "degC" } },
    { temperature: { value: 310.15, unit: "K" } },
    { fields: ["temperature"], criticalFields: ["temperature"] },
  );
  assert.equal(unitsDiffer.status, "incompatible");
});

test("transfer declaration without a critical mismatch is retained as a warning", () => {
  const result = matchConditions(target, target, { transferredCalibration: true });
  assert.equal(result.status, "matched");
  assert.ok(result.warnings.some(({ code }) => code === "UNNEEDED_TRANSFER_DECLARATION"));
});
