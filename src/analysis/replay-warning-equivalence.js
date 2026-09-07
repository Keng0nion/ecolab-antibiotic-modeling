// These closed templates describe redundant display text in existing v2 artifacts.
// Callers must still compare every structured field, including the numeric value.
export function hasCanonicalNumericWarningMessage(warning) {
  if (!warning || typeof warning !== "object" || Array.isArray(warning)) return false;
  if (warning.code === "HIGH_CONDITION_NUMBER" && Number.isFinite(warning.conditionNumber)) {
    return warning.message === `Normalized Jacobian condition number is ${warning.conditionNumber}.`;
  }
  if (warning.code !== "STRONG_PARAMETER_CORRELATION" || !Number.isFinite(warning.correlation)
    || !Array.isArray(warning.parameters) || warning.parameters.length !== 2
    || !warning.parameters.every((name) => typeof name === "string")) return false;
  const names = warning.parameters.join(" and ");
  if (warning.source === "unscaled_inverse_information") {
    return warning.message === `${names} have strong inverse-information geometry correlation ${warning.correlation}; this is not calibrated parameter uncertainty.`;
  }
  if (warning.source === "normalized_jacobian_columns") {
    return warning.message === `${names} have collinear normalized sensitivity columns (cosine ${warning.correlation}), not an estimable parameter correlation.`;
  }
  return false;
}
