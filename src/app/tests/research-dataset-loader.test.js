import test from "node:test";
import assert from "node:assert/strict";
import {
  SUPPORTED_DATASET_REF,
  assessWorkflowEligibility,
  buildDatasetRecord,
  bundledDatasetRecord,
  conditionComparison,
  fetchBundledDatasetText,
  trustedDatasetUrl,
  validateCsvMetadata,
} from "../research/dataset-loader.js";
import {
  TEST_HASH,
  createCatalogFixture,
  createDatasetRecord,
  createNormalizedDataset,
  createQualityReport,
} from "./research-test-fixtures.js";

test("bundled registry lookup and trusted URL accept only the exact local dataset path", () => {
  const catalog = createCatalogFixture();
  const record = bundledDatasetRecord(catalog.datasetRegistry);
  assert.equal(`${record.id}@${record.version}`, SUPPORTED_DATASET_REF);
  const url = trustedDatasetUrl(record, "https://example.test/src/app/research/dataset-loader.js");
  assert.equal(url.href, "https://example.test/data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json");
  assert.throws(() => trustedDatasetUrl({ paths: { normalizedJson: "../secret.json" } }), /not trusted/);
  assert.throws(() => trustedDatasetUrl({ paths: { normalizedJson: "https://other.test/data.json" } }), /not trusted/);
});

test("bundled loading verifies the exact UTF-8 text SHA-256 before import", async () => {
  const record = bundledDatasetRecord(createCatalogFixture().datasetRegistry);
  const calls = [];
  const verified = await fetchBundledDatasetText({
    registryRecord: record,
    fetchImpl: async (url) => {
      calls.push(url.href);
      return { ok: true, async text() { return "exact UTF-8 text"; } };
    },
    hashImpl: async (text) => {
      assert.equal(text, "exact UTF-8 text");
      return TEST_HASH;
    },
  });
  assert.equal(verified.contentHash, TEST_HASH);
  assert.equal(calls.length, 1);

  await assert.rejects(
    fetchBundledDatasetText({
      registryRecord: record,
      fetchImpl: async () => ({ ok: true, async text() { return "tampered"; } }),
      hashImpl: async () => "0".repeat(64),
    }),
    { code: "BUNDLED_DATASET_HASH_MISMATCH" },
  );
});

test("workflow eligibility requires the trusted exact contract, not a matching dataset ID", () => {
  const exactDataset = createNormalizedDataset();
  const observations = [];
  for (let unitIndex = 0; unitIndex < 12; unitIndex += 1) {
    const role = unitIndex < 8 ? "training" : "validation";
    for (let timeIndex = 0; timeIndex < 44; timeIndex += 1) {
      observations.push({
        ...exactDataset.observations[0],
        observationId: `o-${unitIndex}-${timeIndex}`,
        seriesId: `unit-${unitIndex}`,
        independentUnitId: `unit-${unitIndex}`,
        role,
        timeHours: (timeIndex + 1) / 2,
        value: 0.08 + timeIndex / 1000,
      });
    }
  }
  exactDataset.observations = observations;
  const imported = {
    dataset: exactDataset,
    qualityReport: createQualityReport({
      summary: {
        observationCount: 528,
        independentUnitCount: 12,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        byRole: { training: 352, validation: 176 },
        byMeasurementType: { od600: 528 },
        byCensoring: { none: 528 },
      },
    }),
    warnings: [],
    stats: { rowCount: 528 },
    format: "json",
  };
  const registryRecord = bundledDatasetRecord(createCatalogFixture().datasetRegistry);
  const exact = buildDatasetRecord({
    imported,
    sourceText: "fixture",
    contentHash: TEST_HASH,
    sourceKind: "bundled",
    registryRecord,
    trustedBundledArtifact: true,
  });
  assert.deepEqual(assessWorkflowEligibility(exact, { trustedBundledArtifact: true }), { eligible: true, reasons: [] });

  const copiedFile = createDatasetRecord({
    normalizedDataset: exactDataset,
    qualityReport: imported.qualityReport,
    registryRef: SUPPORTED_DATASET_REF,
  });
  const generic = assessWorkflowEligibility(copiedFile, { trustedBundledArtifact: false });
  assert.equal(generic.eligible, false);
  assert.match(generic.reasons[0], /integrity-verified bundled artifact/);
});

test("CSV metadata is explicit and condition comparison preserves separate mismatches", () => {
  assert.throws(() => validateCsvMetadata({ datasetId: "", title: "A", license: "" }), {
    code: "CSV_METADATA_REQUIRED",
  });
  assert.deepEqual(
    validateCsvMetadata({ datasetId: " local-id ", title: " Local title ", license: " CC0 " }),
    { datasetId: "local-id", title: "Local title", license: "CC0" },
  );

  const catalog = createCatalogFixture();
  const rows = conditionComparison(
    bundledDatasetRecord(catalog.datasetRegistry),
    catalog.resolvedModel,
    createNormalizedDataset(),
  );
  assert.deepEqual(rows.map(({ field, status }) => [field, status]), [
    ["strain", "match"],
    ["medium", "mismatch"],
    ["measurement", "incompatible"],
  ]);
  assert.equal(rows[1].target, "M9 salts + 0.1% casamino acids + 0.2% glucose");
  assert.match(rows[2].dataset, /OD600/);

  const genericMissingConditions = createNormalizedDataset({
    metadata: {
      datasetId: "generic-missing-conditions",
      title: "Generic missing-condition fixture",
      license: "CC0",
    },
    observations: createNormalizedDataset().observations.map((observation) => ({
      ...observation,
      measurementType: undefined,
    })),
  });
  const genericRows = conditionComparison(
    bundledDatasetRecord(catalog.datasetRegistry),
    catalog.resolvedModel,
    genericMissingConditions,
  );
  assert.deepEqual(genericRows.map(({ field, status }) => [field, status]), [
    ["strain", "unknown"],
    ["medium", "unknown"],
    ["measurement", "unknown"],
  ]);
  assert.equal(genericRows[0].dataset, "unknown");
  assert.notEqual(genericRows[0].dataset, "BW25113");
});
