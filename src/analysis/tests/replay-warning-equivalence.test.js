import test from "node:test";
import assert from "node:assert/strict";

const module = await import("../replay-warning-equivalence.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND" && error.message.includes("replay-warning-equivalence.js")) return null;
  throw error;
});
const canonical = (warning) => {
  assert.equal(typeof module?.hasCanonicalNumericWarningMessage, "function");
  return module.hasCanonicalNumericWarningMessage(warning);
};

function examples() {
  return [
    {
      code: "HIGH_CONDITION_NUMBER", conditionNumber: 1000000.000000001, threshold: 1e6,
      message: "Normalized Jacobian condition number is 1000000.000000001.",
    },
    {
      code: "STRONG_PARAMETER_CORRELATION", source: "unscaled_inverse_information",
      parameters: ["rate", "initial"], correlation: -0.9936582411628538, threshold: 0.95,
      message: "rate and initial have strong inverse-information geometry correlation -0.9936582411628538; this is not calibrated parameter uncertainty.",
    },
    {
      code: "STRONG_PARAMETER_CORRELATION", source: "normalized_jacobian_columns",
      parameters: ["rate", "initial"], correlation: 0.9999999999999998, threshold: 0.95,
      message: "rate and initial have collinear normalized sensitivity columns (cosine 0.9999999999999998), not an estimable parameter correlation.",
    },
  ];
}

test("only closed numeric warning templates with exact own-field text are canonical", () => {
  for (const warning of examples()) {
    assert.equal(canonical(warning), true);
    const key = warning.code === "HIGH_CONDITION_NUMBER" ? "conditionNumber" : "correlation";
    const changed = structuredClone(warning);
    changed[key] += Math.abs(changed[key]) * 1e-12;
    assert.notEqual(changed[key], warning[key]);
    assert.equal(canonical(changed), false, "Numbers in text must agree exactly with their own field, not merely within replay tolerance.");
    changed.message = changed.message.replace(String(warning[key]), String(changed[key]));
    assert.equal(canonical(changed), true);
  }
});

test("canonical numeric messages cannot omit qualifiers or add arbitrary text", () => {
  for (const warning of examples()) {
    for (const message of [warning.message + " ", warning.message + " Proven valid.", warning.message.slice(0, -1), "Everything is safe."]) {
      assert.equal(canonical({ ...warning, message }), false);
    }
  }
  const warning = examples()[1];
  assert.equal(canonical({ ...warning, message: warning.message.replace("; this is not calibrated parameter uncertainty.", ".") }), false);
});

test("unknown codes and sources, malformed parameters and nonnumeric fields fall back to exact comparison", () => {
  const warning = examples()[1];
  for (const value of [null, undefined, [], "warning", {}, { ...warning, code: "OTHER" }, { ...warning, source: "unknown" }]) {
    assert.equal(canonical(value), false);
  }
  for (const parameters of [undefined, null, "rate and initial", [], ["rate"], ["rate", "initial", "extra"], ["rate", 1]]) {
    assert.equal(canonical({ ...warning, parameters }), false);
  }
  for (const correlation of [null, undefined, String(warning.correlation), NaN, Infinity, -Infinity]) {
    assert.equal(canonical({ ...warning, correlation }), false);
  }
  const condition = examples()[0];
  for (const conditionNumber of [null, undefined, "Infinity", Infinity, -Infinity, NaN, "1000000.000000001"]) {
    assert.equal(canonical({ ...condition, conditionNumber, message: `Normalized Jacobian condition number is ${conditionNumber}.` }), false);
  }
});

test("numeric message recognition is nonmutating and does not certify other warning fields", () => {
  for (const warning of examples()) {
    const original = structuredClone(warning);
    Object.freeze(warning.parameters);
    Object.freeze(warning);
    assert.equal(canonical(warning), true);
    assert.deepEqual(warning, original);
    assert.equal(canonical({ ...warning, severity: "different", unsupportedClaim: true }), true);
  }
});
