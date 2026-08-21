import test from "node:test";
import assert from "node:assert/strict";
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
  createDatasetRecord,
  createNormalizedDataset,
  createResearchResult,
} from "./research-test-fixtures.js";

test("Research CSV cells protect spreadsheet formulas and quote unsafe delimiters", () => {
  for (const value of ["=1+1", "+SUM(A1:A2)", "-2+3", "@cmd"]) {
    assert.equal(protectCsvFormula(value).startsWith("'"), true);
  }
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell("hello,world"), '"hello,world"');
  assert.equal(csvCell('say "hello"'), '"say ""hello"""');
});

test("normalized dataset export preserves scientific columns and protects imported text", () => {
  const dataset = createNormalizedDataset();
  dataset.observations[0].replicate = "=WEBSERVICE(\"bad\")";
  const csv = normalizedDatasetToCsv(dataset);
  assert.match(csv, /^# source_doi: 10\.6084\/m9\.figshare\.28342064\.v1/);
  assert.match(csv, /# article_doi: 10\.1038\/s41597-025-05356-3/);
  assert.match(csv, /# license: CC BY 4\.0/);
  assert.match(csv, /\nobservationId,seriesId,independentUnitId,role,timeHours,/);
  assert.match(csv, /Raw OD600 is not CFU\/mL/);
  assert.match(csv, /locked held-out units/);
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

test("JSON and methods exports retain bilingual provenance and scientific limitations", () => {
  const result = createResearchResult();
  const manifest = JSON.parse(analysisManifestJson(result));
  const packageExport = JSON.parse(researchPackageJson(result, "zh-CN"));
  assert.equal(manifest.runId, "stage4-fixture-run");
  assert.equal(manifest.ecolabExportNotice.license, "CC BY 4.0");
  assert.match(manifest.ecolabExportNotice.validation_limitation, /locked held-out units/);
  assert.equal(packageExport.kind, "ecolab.research-package");
  assert.match(packageExport.ecolabExportNotice.validation_limitation, /锁定留出单元/);
  assert.match(packageExport.ecolabExportNotice.measurement_limitation, /OD600 不是 CFU\/mL/);

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

test("Chinese CSV disclosures use locked held-out terminology", () => {
  const csv = normalizedDatasetToCsv(createNormalizedDataset(), "zh-CN");
  assert.match(csv, /锁定留出单元/);
  assert.match(csv, /原始 OD600 不是 CFU\/mL/);
  assert.match(csv, /没有药物暴露/);
  assert.doesNotMatch(csv, /独立验证单元/);
});
