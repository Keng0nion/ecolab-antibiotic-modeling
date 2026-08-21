import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildResearchPackage,
  createAnalysisManifest,
  generateMethodsSummaryMarkdown,
} from "../analysis-manifest.js";
import { lockAnalysisPlan } from "../analysis-plan.js";
import { sha256HexFallback } from "../fingerprint.js";
import { assertSchemaValid } from "./schema-test-helper.js";

function planInput() {
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
        rationale: "Predeclared biological range.",
      }],
      initialStateSeriesIds: [],
    },
    randomAlgorithm: "xoshiro128ss-splitmix32-v1",
    seeds: { analysis: 42 },
    lockedValidation: false,
    parameters: { psiMaxLog10PerHour: 0.3 },
    errorModel: { kind: "fixed_gaussian", sigma: 0.2 },
    exclusions: [],
    metrics: ["macro_rmse"],
    validationIndependentUnitIds: ["validation-1"],
  };
}

function resolvedModel() {
  return {
    ref: {
      id: "ecolab.single-population.regoes-logistic",
      version: "1.0.0",
      implementationId: "regoes-logistic-piecewise-analytic-v1",
      parameterSetId: "base",
      parameterSetVersion: "1.0.0",
    },
    parameters: {
      psiMaxLog10PerHour: 0.3,
      carryingCapacityLog10CfuPerMl: 9,
      drugs: {
        ciprofloxacin: {
          zMicMgPerL: 1,
          hillKappa: 2,
          psiMinLog10PerHour: -1,
        },
      },
    },
  };
}

async function manifest(overrides = {}) {
  const plan = await lockAnalysisPlan(planInput());
  return createAnalysisManifest({
    runId: "analysis-run-1",
    createdAt: "2026-08-21T12:00:00.000Z",
    applicationVersion: "3.0.0",
    resolvedModel: resolvedModel(),
    parameterOverrides: { psiMaxLog10PerHour: 0.35 },
    overrideOrigins: {
      psiMaxLog10PerHour: {
        kind: "fitted_training_parameter",
        sourceRunId: "fit-1",
      },
    },
    dataset: {
      id: "dataset-a",
      version: "1.2.0",
      normalizedDatasetFingerprint: plan.datasetFingerprint,
      sourceArtifactSha256: "c".repeat(64),
      license: "CC-BY-4.0",
    },
    splitFingerprint: plan.splitFingerprint,
    plan,
    random: { algorithm: "xoshiro128ss-splitmix32-v1", seed: 42 },
    algorithm: {
      name: "differential_evolution_then_nelder_mead",
      version: "1",
      bounds: { psiMaxLog10PerHour: [0.1, 0.8] },
      stopping: { maxEvaluations: 1000, tolerance: 1e-8 },
      settings: { restarts: 3 },
    },
    failures: [{ stage: "restart", index: 1, code: "NO_IMPROVEMENT" }],
    convergence: { converged: true, evaluations: 321 },
    residuals: { count: 12, mean: 0.01 },
    identifiability: { rank: 1, conditionNumber: 2.5 },
    metrics: { macroRmse: 0.2 },
    capabilityAssessment: { level: "L4", warnings: [] },
    warnings: [{ code: "TRANSFER_LIMIT", severity: "warning", message: "Condition transfer remains limited." }],
    ...overrides,
  });
}

test("analysis manifests are immutable, JSON-safe, fully versioned, and use analysis randomness", async () => {
  const value = await manifest();
  assert.equal(value.versions.application, "3.0.0");
  assert.equal(value.versions.core, "2.0.0");
  assert.equal(value.versions.analysis, "1.0.0");
  assert.equal(value.random.algorithm, "xoshiro128ss-splitmix32-v1");
  assert.equal(value.random.seed, 42);
  assert.equal(Object.hasOwn(value.random, "used"), false);
  assert.equal(value.dataset.normalizedDatasetFingerprint, "a".repeat(64));
  assert.equal(value.dataset.fingerprint, value.dataset.normalizedDatasetFingerprint);
  assert.equal(value.dataset.hash, value.dataset.normalizedDatasetFingerprint);
  assert.equal(value.dataset.sourceArtifactSha256, "c".repeat(64));
  assert.equal(Object.isFrozen(value.baseParameterSet.resolvedParameters.drugs), true);
  assert.doesNotThrow(() => JSON.stringify(value));
  assert.deepEqual(value.parameterOverrides[0].origin, {
    kind: "fitted_training_parameter",
    sourceRunId: "fit-1",
  });
});

test("manifest validation rejects non-finite diagnostics and overrides without origins", async () => {
  await assert.rejects(() => manifest({ metrics: { rmse: Infinity } }), { code: "NON_FINITE_NUMBER" });
  await assert.rejects(
    () => manifest({ parameterOverrides: { psiMaxLog10PerHour: 0.35 }, overrideOrigins: {} }),
    { code: "INVALID_OBJECT" },
  );
  const sparse = [];
  sparse[1] = { code: "late" };
  await assert.rejects(() => manifest({ warnings: sparse }), { code: "SPARSE_ARRAY" });
});

test("methods summary is deterministic and includes auditable model, data, plan, random, and convergence facts", async () => {
  const value = await manifest();
  const first = generateMethodsSummaryMarkdown(value);
  const second = generateMethodsSummaryMarkdown(value);
  assert.equal(first, second);
  assert.match(first, /Analysis methods summary/);
  assert.match(first, /ecolab\.single-population\.regoes-logistic@1\.0\.0/);
  assert.match(first, /Normalized canonical dataset fingerprint/);
  assert.match(first, /Source artifact SHA-256 \(source bytes\)/);
  assert.match(first, /Locked plan SHA-256/);
  assert.match(first, /xoshiro128ss-splitmix32-v1/);
  assert.match(first, /Converged: yes/);
  assert.match(first, /`TRANSFER_LIMIT` \[warning\]: Condition transfer remains limited\./);
});

test("research packages include a content-addressed artifact inventory", async () => {
  const value = await manifest();
  const researchPackage = buildResearchPackage({
    packageId: "package-1",
    manifest: value,
    artifacts: [{
      artifactId: "fit-result",
      role: "fitted_parameter_set",
      path: "fitted-parameter-set.json",
      mediaType: "application/json",
      content: { schemaVersion: "1.0.0", kind: "fitted-parameter-set", value: 0.35 },
    }],
  });
  assert.equal(researchPackage.kind, "ecolab.research-package");
  assert.equal(researchPackage.replay.selfContained, false);
  assert.equal(researchPackage.replay.status, "replay_requirements_incomplete");
  assert.match(researchPackage.replay.statement, /does not claim to be self-contained/);
  assert.deepEqual(
    researchPackage.artifactInventory.map(({ artifactId }) => artifactId),
    ["analysis-manifest", "methods-summary", "fit-result"],
  );
  const methods = researchPackage.artifactInventory.find(({ artifactId }) => artifactId === "methods-summary");
  assert.equal(methods.sha256, sha256HexFallback(researchPackage.contents.methodsSummaryMarkdown));
  assert.deepEqual(researchPackage.contents.artifacts["fit-result"], {
    schemaVersion: "1.0.0",
    kind: "fitted-parameter-set",
    value: 0.35,
  });
  assert.equal(Object.isFrozen(researchPackage.artifactInventory), true);
});

test("generated manifest and package objects satisfy schemas and schema checks reject contract violations", async () => {
  const analysisRunSchema = JSON.parse(
    await readFile(new URL("../../../schemas/analysis-run.schema.json", import.meta.url), "utf8"),
  );
  const researchPackageSchema = JSON.parse(
    await readFile(new URL("../../../schemas/research-package.schema.json", import.meta.url), "utf8"),
  );
  const value = await manifest();
  const researchPackage = buildResearchPackage({
    manifest: value,
    artifacts: [{
      artifactId: "locked-plan",
      role: "locked_analysis_plan",
      path: "locked-plan.json",
      mediaType: "application/json",
      content: { kind: "analysis-plan", lockedValidation: true },
    }],
    replay: {
      selfContained: false,
      artifactIds: ["locked-plan"],
      dependencies: [{
        id: "ecolab-stage4-analysis-v1",
        kind: "software_implementation",
        requirement: "exact",
      }],
    },
  });

  assertSchemaValid(value, analysisRunSchema);
  assertSchemaValid(researchPackage, researchPackageSchema, {
    documents: { "analysis-run.schema.json": analysisRunSchema },
  });

  const missingRequired = structuredClone(value);
  delete missingRequired.dataset.normalizedDatasetFingerprint;
  assert.throws(() => assertSchemaValid(missingRequired, analysisRunSchema), /missing required property/);

  const additionalProperty = structuredClone(value);
  additionalProperty.unexpected = true;
  assert.throws(() => assertSchemaValid(additionalProperty, analysisRunSchema), /unexpected additional property/);

  const wrongConst = structuredClone(value);
  wrongConst.kind = "not-an-analysis-run";
  assert.throws(() => assertSchemaValid(wrongConst, analysisRunSchema), /expected const/);

  const wrongPattern = structuredClone(value);
  wrongPattern.dataset.normalizedDatasetFingerprint = "not-a-sha256";
  assert.throws(() => assertSchemaValid(wrongPattern, analysisRunSchema), /did not match pattern/);

  const unresolvedExternalRef = structuredClone(researchPackage);
  assert.throws(
    () => assertSchemaValid(unresolvedExternalRef, researchPackageSchema),
    /unresolved schema document analysis-run\.schema\.json/,
  );
});

test("new Stage 4 schemas are parseable Draft 2020-12 JSON schemas", async () => {
  for (const name of [
    "analysis-plan.schema.json",
    "analysis-run.schema.json",
    "fitted-parameter-set.schema.json",
    "research-package.schema.json",
  ]) {
    const schema = JSON.parse(await readFile(new URL(`../../../schemas/${name}`, import.meta.url), "utf8"));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(typeof schema.$id, "string");
    assert.equal(schema.type, "object");
  }
});
