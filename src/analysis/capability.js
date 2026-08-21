const LEVELS = Object.freeze(["L1", "L2", "L3", "L4", "L5"]);

export const CAPABILITY_LEVELS = LEVELS;

export class CapabilityAssessmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "CapabilityAssessmentError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path, actual) {
  throw new CapabilityAssessmentError(code, message, { path, actual });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isRecord(value)) fail("INVALID_CAPABILITY_INPUT", `${path} must be a plain object.`, path, value);
}

function stage(run, primary, alias) {
  const value = run[primary] ?? (alias ? run[alias] : undefined) ?? {};
  assertRecord(value, primary);
  return value;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringList(value, path) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => !nonEmptyString(item))) {
    fail("INVALID_ASSUMPTIONS", `${path} must be an array of non-empty strings.`, path, value);
  }
  return value.map((item) => item.trim());
}

function hasDiagnostics(value) {
  if (Array.isArray(value)) return value.length > 0;
  return isRecord(value) && Object.keys(value).length > 0 && value.completed !== false;
}

function booleanEvidence(stageValue, key, alias = undefined) {
  if (stageValue[key] !== undefined) return stageValue[key] === true;
  return alias !== undefined && stageValue[alias] === true;
}

function gate(level, passed, code, message, evidence) {
  return { level, passed, code, message, evidence };
}

/**
 * Assess the demonstrated capability of one analysis run. Levels are
 * cumulative: L3 requires the L2 evidence, L4 requires L3, and L5 requires L4.
 * Missing evidence never receives an optimistic interpretation.
 */
export function assessCapability(run = {}) {
  assertRecord(run, "run");
  const runId = run.runId ?? run.analysisRunId ?? null;
  if (runId !== null && !nonEmptyString(runId)) {
    fail("INVALID_RUN_ID", "runId must be a non-empty string or null.", "run.runId", runId);
  }

  const uncertainty = stage(run, "uncertainty", "uncertaintyAnalysis");
  const sensitivity = stage(run, "sensitivity", "sensitivityAnalysis");
  const dataFit = stage(run, "dataFit");
  const validation = stage(run, "validation");
  const externalValidation = stage(run, "externalValidation");
  const assumptions = [
    ...stringList(run.assumptions, "run.assumptions"),
    ...stringList(uncertainty.assumptions, "run.uncertainty.assumptions"),
    ...stringList(sensitivity.assumptions, "run.sensitivity.assumptions"),
  ];
  const uniqueAssumptions = [...new Set(assumptions)];

  const l2Evidence = {
    uncertaintyCompleted: uncertainty.completed === true,
    sensitivityCompleted: sensitivity.completed === true,
    assumptions: uniqueAssumptions,
  };
  const l2Passed = l2Evidence.uncertaintyCompleted && l2Evidence.sensitivityCompleted && uniqueAssumptions.length > 0;

  const l3Evidence = {
    fitCompleted: dataFit.completed === true,
    realData: booleanEvidence(dataFit, "realData", "usesRealData"),
    conditionsDescribed: booleanEvidence(dataFit, "conditionsDescribed", "conditionDescribed"),
    diagnosticsPresent: hasDiagnostics(dataFit.diagnostics),
  };
  const l3OwnPassed = l3Evidence.fitCompleted && l3Evidence.realData && l3Evidence.conditionsDescribed && l3Evidence.diagnosticsPresent;
  const l3Passed = l2Passed && l3OwnPassed;

  const validationLocked = booleanEvidence(validation, "locked", "lockedValidation") || validation.split?.lockedValidation === true;
  const l4Evidence = {
    validationCompleted: validation.completed === true,
    locked: validationLocked,
    leakageFree: validation.leakageFree === true,
    untouched: validation.untouched === true,
    independentUnitsDocumented: validation.independentUnitsDocumented === true,
    eligibleAsValidationEvidence: booleanEvidence(
      validation,
      "eligibleAsValidationEvidence",
      "eligibleForL4",
    ),
    splitFingerprint: validation.splitFingerprint ?? validation.split?.splitFingerprint ?? null,
  };
  const l4OwnPassed = l4Evidence.validationCompleted
    && l4Evidence.locked
    && l4Evidence.leakageFree
    && l4Evidence.untouched
    && l4Evidence.independentUnitsDocumented
    && l4Evidence.eligibleAsValidationEvidence;
  const l4Passed = l3Passed && l4OwnPassed;

  const externalSourceId = externalValidation.sourceId ?? externalValidation.datasetId ?? null;
  const l5Evidence = {
    externalValidationCompleted: externalValidation.completed === true,
    independentSource: externalValidation.independentSource === true,
    sourceId: externalSourceId,
    diagnosticsPresent: externalValidation.diagnostics === undefined ? null : hasDiagnostics(externalValidation.diagnostics),
  };
  const l5OwnPassed = l5Evidence.externalValidationCompleted && l5Evidence.independentSource && nonEmptyString(externalSourceId);
  const l5Passed = l4Passed && l5OwnPassed;

  const gates = [
    gate("L2", l2Passed, "UNCERTAINTY_SENSITIVITY_REQUIRED", "L2 requires completed uncertainty and sensitivity analyses with documented assumptions.", l2Evidence),
    gate("L3", l3Passed, "REAL_DATA_FIT_REQUIRED", "L3 requires L2 plus a completed fit to real, condition-described data with diagnostics.", l3Evidence),
    gate("L4", l4Passed, "L4_VALIDATION_EVIDENCE_INSUFFICIENT", "L4 requires L3 plus completed, locked, leakage-free, untouched validation with documented independent units and explicit eligibility as validation evidence.", l4Evidence),
    gate("L5", l5Passed, "EXTERNAL_VALIDATION_REQUIRED", "L5 requires L4 plus validation against an independent external source.", l5Evidence),
  ];

  let level = "L1";
  if (l2Passed) level = "L2";
  if (l3Passed) level = "L3";
  if (l4Passed) level = "L4";
  if (l5Passed) level = "L5";

  const reasons = [
    {
      code: `CAPABILITY_${level}`,
      level,
      message: level === "L1"
        ? "Only baseline exploratory capability is demonstrated for this analysis run."
        : `This analysis run satisfies all cumulative requirements through ${level}.`,
    },
  ];
  const warnings = [];
  for (const current of gates) {
    if (!current.passed) {
      reasons.push({
        code: current.code,
        level: current.level,
        message: current.message,
        evidence: current.evidence,
      });
    }
  }
  if (runId === null) {
    warnings.push({ code: "MISSING_RUN_ID", message: "No runId was supplied; the assessment is still run-local but less auditable." });
  }
  if (l3OwnPassed && !l2Passed) {
    warnings.push({ code: "L3_PREREQUISITE_MISSING", message: "Real-data fitting evidence is present, but L2 uncertainty/sensitivity evidence is incomplete." });
  }
  if (l4OwnPassed && !l3Passed) {
    warnings.push({ code: "L4_PREREQUISITE_MISSING", message: "Validation evidence is present, but lower capability prerequisites are incomplete." });
  }
  if (validation.leakageFree === false) {
    warnings.push({ code: "VALIDATION_LEAKAGE", message: "Validation was explicitly marked as having leakage; L4 and L5 are forbidden." });
  }
  if (validation.untouched === false) {
    warnings.push({ code: "VALIDATION_TOUCHED", message: "Validation data was explicitly marked as touched; L4 and L5 are forbidden." });
  }
  const proceduralValidationPassed = l4Evidence.validationCompleted
    && l4Evidence.locked
    && l4Evidence.leakageFree
    && l4Evidence.untouched;
  if (
    proceduralValidationPassed
    && (!l4Evidence.independentUnitsDocumented || !l4Evidence.eligibleAsValidationEvidence)
  ) {
    warnings.push({
      code: "L4_VALIDATION_EVIDENCE_INSUFFICIENT",
      message: "Validation was locked, leakage-free, and untouched, but independent-unit documentation or explicit validation-evidence eligibility is insufficient for L4.",
      evidence: l4Evidence,
    });
  }
  if (l5OwnPassed && !l4Passed) {
    warnings.push({ code: "L5_PREREQUISITE_MISSING", message: "External validation evidence is present, but L4 prerequisites are incomplete." });
  }

  return {
    schemaVersion: "1.0.0",
    kind: "analysis-capability-assessment",
    runId,
    level,
    gates,
    reasons,
    warnings,
  };
}

export const assessAnalysisCapability = assessCapability;
export const determineCapabilityLevel = assessCapability;
