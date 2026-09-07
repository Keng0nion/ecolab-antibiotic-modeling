import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildResearchPackage, createAnalysisManifest } from "../../analysis/analysis-manifest.js";
import { canonicalJson, sha256HexFallback } from "../../analysis/fingerprint.js";
import { assertSchemaValid } from "../../analysis/tests/schema-test-helper.js";
import {
  analysisManifestJson,
  csvCell,
  normalizedDatasetToCsv,
  predictionsMetricsToCsv,
  protectCsvFormula,
  researchExportAvailability,
  researchMethodsText,
  researchPackageJson,
} from "../research/export.js";
import {
  createCatalogFixture,
  createDatasetRecord,
  createNormalizedDataset,
  createResearchResult,
  createResearchV2Result,
} from "./research-test-fixtures.js";

test("Research CSV cells protect spreadsheet formulas and quote unsafe delimiters", () => {
  for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd"]) {
    assert.equal(protectCsvFormula(value).startsWith("'"), true);
  }
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell(-0.24), "-0.24", "finite signed numbers are numeric CSV cells, not formula strings");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("hello,world"), '"hello,world"');
  assert.equal(csvCell('say "hello"'), '"say ""hello"""');
});

function createSourceLinkedDataset() {
  const dataset = createNormalizedDataset();
  dataset.metadata.sourceIds = ["figshare-bw25113-growth-v1"];
  return dataset;
}

test("normalized dataset export preserves scientific columns and protects imported text", () => {
  const dataset = createSourceLinkedDataset();
  dataset.observations[0].replicate = "=WEBSERVICE(\"bad\")";
  const csv = normalizedDatasetToCsv(dataset);
  assert.match(csv, /^# source_doi: 10\.6084\/m9\.figshare\.28342064\.v1/);
  assert.match(csv, /# article_doi: 10\.1038\/s41597-025-05356-3/);
  assert.match(csv, /# license: CC-BY-4\.0/);
  assert.match(csv, /\nobservationId,seriesId,independentUnitId,role,timeHours,/);
  assert.match(csv, /Raw OD600 is not CFU\/mL/);
  assert.match(csv, /previously viewed development curves/);
  assert.match(csv, /not confidence intervals/);
  assert.match(csv, /no antibiotic exposure/);
  assert.match(csv, /transferred across unmatched measurement and medium conditions/);
  assert.match(csv, /od600/);
  assert.match(csv, /'=WEBSERVICE/);
  assert.equal(csv.endsWith("\n"), true);
});

test("predictions export aligns validation rows and appends training, validation, and baseline metrics", () => {
  const dataset = createNormalizedDataset();
  const result = createResearchResult();
  const csv = predictionsMetricsToCsv(dataset, result);
  assert.match(csv, /validation-1,validation-unit,0.5,od600,0.09,0.085,0.005/);
  assert.match(csv, /training\.pooledRmse/);
  assert.match(csv, /validation\.pooledRmse/);
  assert.match(csv, /validation\.baseline\.training-unit-mean-od-by-exact-source-time\.pooledRmse/);

  assert.throws(
    () => predictionsMetricsToCsv(dataset, { ...result, validation: { ...result.validation, predictions: [] } }),
    /not aligned/,
  );
});

test("v2 prediction CSV uses development labels, retains source roles, and exports growth and sensitivity semantics", () => {
  const dataset = createSourceLinkedDataset();
  const result = createResearchV2Result();
  const before = structuredClone({ dataset, result });
  const csv = predictionsMetricsToCsv(dataset, result);
  assert.match(csv, /source_role/);
  assert.match(csv, /prediction,development,validation-1/);
  assert.match(csv, /development\.pooledRmse/);
  assert.doesNotMatch(csv, /metric,validation|validation\.pooledRmse/);
  assert.match(csv, /growth\.cv\.training_mean\.macroRmse/);
  assert.match(csv, /growth\.development\.selected\.macroRmse/);
  assert.match(csv, /growth\.bootstrap\.successfulSamples/);
  assert.match(csv, /firstOrderInterval/);
  assert.match(csv, /sobol\.bootstrap/);
  assert.match(csv, /confidenceLevel/);
  assert.match(csv, /-0\.48/);
  assert.match(csv, /WIDE_BOOTSTRAP_INTERVAL/);
  assert.match(csv, /output_per_unit_normalized_coordinate/);
  assert.match(csv, /objective_slice/);
  assert.match(csv, /previously viewed development/i);
  assert.equal(JSON.parse(researchPackageJson(result)).kind, result.researchPackage.kind);
  assert.deepEqual({ dataset, result }, before);
  const normalized = normalizedDatasetToCsv(dataset);
  assert.match(normalized, /validation-1,validation-unit,validation-unit,validation,/);
});

test("each export format has independent artifact availability and requires a QC-valid dataset", () => {
  const dataset = createDatasetRecord();
  const result = createResearchResult();
  const allAvailable = {
    dataset: true,
    manifest: true,
    package: true,
    predictions: true,
    methods: true,
    svg: true,
  };
  assert.deepEqual(researchExportAvailability(dataset, result), allAvailable);
  assert.deepEqual(researchExportAvailability(null, result), {
    dataset: false,
    manifest: false,
    package: false,
    predictions: false,
    methods: false,
    svg: false,
  });
  assert.deepEqual(researchExportAvailability({ ...dataset, qualityReport: { ...dataset.qualityReport, valid: false } }, result), {
    dataset: false,
    manifest: false,
    package: false,
    predictions: false,
    methods: false,
    svg: false,
  });

  assert.equal(researchExportAvailability(dataset, { ...result, manifest: null }).manifest, false);
  assert.equal(researchExportAvailability(dataset, { ...result, researchPackage: null }).package, false);
  assert.equal(researchExportAvailability(dataset, { ...result, methodsSummaryMarkdown: "" }).methods, false);
  assert.equal(researchExportAvailability(dataset, { ...result, validation: { ...result.validation, predictions: [] } }).predictions, false);
  assert.equal(researchExportAvailability(dataset, { manifest: result.manifest }).svg, true);
});

test("JSON exports serialize only the actual artifacts, independent of locale", () => {
  const result = createResearchResult();
  const original = structuredClone(result);
  for (const locale of ["en", "zh-CN"]) {
    const manifestText = analysisManifestJson(result, locale);
    const packageText = researchPackageJson(result, locale);
    assert.equal(manifestText, JSON.stringify(result.manifest, null, 2));
    assert.equal(packageText, JSON.stringify(result.researchPackage, null, 2));
    assert.deepEqual(JSON.parse(manifestText), result.manifest);
    assert.deepEqual(JSON.parse(packageText), result.researchPackage);
    assert.equal(Object.hasOwn(JSON.parse(manifestText), "ecolabExportNotice"), false);
    assert.equal(Object.hasOwn(JSON.parse(packageText), "ecolabExportNotice"), false);
  }
  assert.deepEqual(result, original);
  assert.throws(() => analysisManifestJson({}), /No completed/);
  assert.throws(() => researchPackageJson({}), /No completed/);
});

test("methods exports retain bilingual provenance and scientific limitations", () => {
  const result = createResearchResult();
  const englishMethods = researchMethodsText(result);
  const chineseMethods = researchMethodsText(result, "zh-CN");
  assert.match(englishMethods, /^# Methods/);
  assert.match(englishMethods, /Required provenance and limitations/);
  assert.match(englishMethods, /no antibiotic exposure/);
  assert.match(chineseMethods, /必须保留的来源与限制/);
  assert.match(chineseMethods, /不是置信区间/);
  assert.equal(englishMethods.endsWith("\n"), true);
  assert.throws(() => analysisManifestJson({}), /No completed/);
  assert.throws(() => researchPackageJson({}), /No completed/);
  assert.throws(() => researchMethodsText({}), /No completed/);
});

for (const locale of ["en", "zh-CN"]) {
  test(`source-linked normalized CSV in ${locale} discloses previously viewed development without a result`, () => {
    const dataset = createSourceLinkedDataset();
    const before = structuredClone(dataset);
    const csv = normalizedDatasetToCsv(dataset, locale);
    const limitation = csv.split("\n").find((line) => line.startsWith("# validation_limitation:"));
    if (locale === "zh-CN") {
      assert.match(limitation, /L4 不合格.*已查看的开发曲线/);
      assert.match(limitation, /不是未触碰或外部验证/);
      assert.match(limitation, /源角色 validation 保留供审计/);
      assert.match(limitation, /轨迹间独立性未验证/);
      assert.match(csv, /原始 OD600 不是 CFU\/mL/);
      assert.match(csv, /没有药物暴露/);
    } else {
      assert.match(limitation, /L4 ineligible.*previously viewed development curves/);
      assert.match(limitation, /not untouched or external validation/);
      assert.match(limitation, /Source role validation is retained for audit/);
      assert.match(limitation, /between-trajectory independence is unverified/);
    }
    assert.doesNotMatch(limitation, /locked held-out units|锁定留出单元|独立验证单元/);
    assert.doesNotMatch(csv, /whole-curve joint-refit intervals|完整曲线联合重拟合区间/);
    assert.match(csv, /validation-1,validation-unit,validation-unit,validation,/);
    assert.deepEqual(dataset, before);
  });

  test(`historical run exports in ${locale} retain their recorded validation semantics`, () => {
    const dataset = createSourceLinkedDataset();
    const result = createResearchResult();
    const before = structuredClone(result);
    const csv = predictionsMetricsToCsv(dataset, result, locale);
    const methods = researchMethodsText(result, locale);
    for (const text of [csv, methods]) {
      assert.match(text, locale === "zh-CN" ? /验证使用锁定留出单元/ : /validation uses locked held-out units/);
      assert.doesNotMatch(text, /previously viewed development|已查看的开发曲线/);
    }
    assert.match(csv, /prediction,validation,validation-1/);
    assert.match(csv, /validation\.pooledRmse/);
    assert.deepEqual(result, before);
  });
  for (const [name, exportCsv] of [
    ["normalized dataset", (dataset) => normalizedDatasetToCsv(dataset, locale)],
    ["predictions", (dataset) => predictionsMetricsToCsv(dataset, createResearchResult(), locale)],
  ]) {
    test(`${name} CSV in ${locale} uses only the generic dataset's declared source and license`, () => {
      const dataset = createNormalizedDataset({
        metadata: { datasetId: "own-study", title: "Own study", license: "All rights reserved", sourceIds: ["own-source"] },
      });
      const csv = exportCsv(dataset);
      assert.match(csv, /# license: All rights reserved/);
      assert.match(csv, /own-source/);
      assert.doesNotMatch(csv, /figshare|10\.6084|10\.1038|CC[- ]BY|# source_doi:|# article_doi:/);
      assert.doesNotMatch(csv, /no antibiotic exposure|没有药物暴露|locked held-out units|锁定留出单元|unmatched measurement/);
      assert.doesNotMatch(csv, /# validation_limitation:|previously viewed development|已查看的开发曲线|independence|独立性/);
    });

    test(`${name} CSV in ${locale} never infers provenance or a license from a familiar dataset id`, () => {
      const dataset = createNormalizedDataset({
        metadata: { datasetId: "figshare-bw25113-growth-v1", title: "Unverified import" },
      });
      const csv = exportCsv(dataset);
      assert.doesNotMatch(csv, /# source_doi:|# article_doi:|# license:|10\.6084|10\.1038|CC[- ]BY/);
      assert.doesNotMatch(csv, /# validation_limitation:|previously viewed development|已查看的开发曲线|independence|独立性/);
    });
  }
}

test("source-linked CSV preserves the declared license instead of overriding it with a bundled default", () => {
  const dataset = createSourceLinkedDataset();
  dataset.metadata.license = "License supplied by importer";
  assert.match(normalizedDatasetToCsv(dataset), /# license: License supplied by importer/);
  delete dataset.metadata.license;
  assert.doesNotMatch(normalizedDatasetToCsv(dataset), /# license:/);
});

test("JSON export round trips preserve strict schemas, warnings, and content-addressed package artifacts", async () => {
  const manifest = createAnalysisManifest({
    runId: "export-integrity",
    createdAt: "2026-08-21T12:00:00.000Z",
    applicationVersion: "5.0.0",
    resolvedModel: createCatalogFixture().resolvedModel,
    dataset: { id: "generic", version: "1.0.0", normalizedDatasetFingerprint: "a".repeat(64), license: "All rights reserved" },
    splitFingerprint: "b".repeat(64),
    planId: "export-plan",
    analysisKind: "parameter_fit_and_locked_validation",
    planFingerprint: "c".repeat(64),
    random: { algorithm: "xoshiro128ss-splitmix32-v1", seed: 42 },
    algorithm: { name: "fixture", bounds: {}, stopping: { maxEvaluations: 1 } },
    convergence: { converged: false },
    warnings: [{ code: "TRANSFER_LIMIT", severity: "warning", message: "Condition transfer remains limited." }],
  });
  const researchPackage = buildResearchPackage({
    manifest,
    artifacts: [{ artifactId: "data", role: "normalized_dataset", path: "data.json", mediaType: "application/json", content: createNormalizedDataset() }],
  });
  const analysisSchema = JSON.parse(await readFile(new URL("../../../schemas/analysis-run.schema.json", import.meta.url), "utf8"));
  const packageSchema = JSON.parse(await readFile(new URL("../../../schemas/research-package.schema.json", import.meta.url), "utf8"));
  const exportedManifest = JSON.parse(analysisManifestJson({ manifest }));
  const exportedPackage = JSON.parse(researchPackageJson({ researchPackage }));
  assertSchemaValid(exportedManifest, analysisSchema);
  assertSchemaValid(exportedPackage, packageSchema, { documents: { "analysis-run.schema.json": analysisSchema } });
  assert.deepEqual(exportedManifest, manifest);
  assert.deepEqual(exportedPackage, researchPackage);
  assert.equal(sha256HexFallback(canonicalJson(exportedPackage)), sha256HexFallback(canonicalJson(researchPackage)));
  for (const artifact of exportedPackage.artifactInventory) {
    const content = artifact.artifactId === "analysis-manifest"
      ? exportedPackage.contents.analysisManifest
      : artifact.artifactId === "methods-summary"
        ? exportedPackage.contents.methodsSummaryMarkdown
        : exportedPackage.contents.artifacts[artifact.artifactId];
    const text = artifact.mediaType === "application/json" ? canonicalJson(content) : content;
    assert.equal(sha256HexFallback(text), artifact.sha256);
    assert.equal(new TextEncoder().encode(text).byteLength, artifact.byteLength);
  }
});
