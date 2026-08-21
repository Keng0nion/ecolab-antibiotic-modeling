import test from "node:test";
import assert from "node:assert/strict";
import {
  DATASET_IMPORT_LIMITS,
  DatasetImportError,
  importObservationDataset,
  normalizeObservationDataset,
  parseCsv,
  parseJsonStrict,
} from "../dataset-import.js";

function observation(overrides = {}) {
  return {
    observationId: "obs-1",
    seriesId: "series-1",
    independentUnitId: "flask-1",
    role: "training",
    timeHours: 2,
    drugId: "ciprofloxacin",
    concentrationMgPerL: 0.02,
    measurementType: "od600",
    value: 0.31,
    censoring: "none",
    censoringBounds: null,
    replicate: "biological-1/technical-2",
    conditions: {
      organism: "Escherichia coli",
      strain: "BW25113",
      medium: "M9 + glucose",
      temperature: { value: 37, unit: "degC" },
    },
    ...overrides,
  };
}

function dataset(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: {
      datasetId: "dataset-1",
      title: "Strict observations",
      sourceIds: ["source-1"],
      conditions: { laboratory: "A" },
    },
    observations: [observation()],
    ...overrides,
  };
}

function csvCell(value) {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

test("CSV state machine handles BOM, quoted commas/newlines, escaped quotes, and CRLF", () => {
  const parsed = parseCsv('\ufeffname,note\r\nalpha,"comma, newline\r\nand ""quote"""\r\n');
  assert.deepEqual(parsed.rows, [
    ["name", "note"],
    ["alpha", 'comma, newline\r\nand "quote"'],
  ]);
  assert.equal(parsed.stats.bomRemoved, true);
  assert.equal(parsed.stats.dataRowCount, 1);
});

test("CSV parser strictly rejects malformed quoting and structural limits", () => {
  assert.throws(() => parseCsv('a,"unterminated'), { code: "CSV_UNTERMINATED_QUOTE" });
  assert.throws(() => parseCsv('a,"b"x'), { code: "CSV_CHAR_AFTER_QUOTE" });
  assert.throws(() => parseCsv('a,b"c'), { code: "CSV_QUOTE_IN_UNQUOTED_FIELD" });
  assert.throws(() => parseCsv("a,b,c", { limits: { maxColumns: 2 } }), { code: "CSV_TOO_MANY_COLUMNS" });
  assert.throws(() => parseCsv("abcd", { limits: { maxFieldLength: 3 } }), { code: "CSV_FIELD_TOO_LONG" });
  assert.throws(
    () => parseCsv("h\n1\n2", { limits: { warningRows: 1, blockRows: 1 } }),
    { code: "CSV_TOO_MANY_ROWS" },
  );
  assert.throws(
    () => parseCsv("123456", { limits: { warningBytes: 1, blockBytes: 5 } }),
    { code: "INPUT_TOO_LARGE" },
  );
});

test("CSV parser emits configurable size and row warnings below block limits", () => {
  const parsed = parseCsv("a,b\n1,2\n3,4", {
    limits: {
      warningBytes: 1,
      blockBytes: 100,
      warningRows: 1,
      blockRows: 10,
    },
  });
  assert.deepEqual(parsed.warnings.map(({ code }) => code).sort(), ["LARGE_INPUT", "MANY_ROWS"]);
});

test("strict JSON parser detects duplicate keys, unsafe keys, JSON5, and non-finite syntax", () => {
  assert.throws(() => parseJsonStrict('{"a":1,"a":2}'), { code: "DUPLICATE_JSON_KEY" });
  assert.throws(() => parseJsonStrict('{"nested":{"x":1,"x":2}}'), { code: "DUPLICATE_JSON_KEY" });
  assert.throws(() => parseJsonStrict('{"__proto__":{}}'), { code: "UNSAFE_OBJECT_KEY" });
  assert.throws(() => parseJsonStrict('{"\\u005f\\u005fproto__":{}}'), { code: "UNSAFE_OBJECT_KEY" });
  assert.throws(() => parseJsonStrict('{"constructor":{}}'), { code: "UNSAFE_OBJECT_KEY" });
  assert.throws(() => parseJsonStrict('{a:1}'), { code: "JSON_OBJECT_KEY" });
  assert.throws(() => parseJsonStrict("{'a':1}"), { code: "JSON_OBJECT_KEY" });
  assert.throws(() => parseJsonStrict('{"a":1,}'), { code: "JSON_TRAILING_COMMA" });
  assert.throws(() => parseJsonStrict('{"a":NaN}'), { code: "INVALID_JSON_VALUE" });
  assert.throws(() => parseJsonStrict('{"a":Infinity}'), { code: "INVALID_JSON_VALUE" });
  assert.throws(() => parseJsonStrict('{"a":1//comment\n}'), { code: "INVALID_JSON_OBJECT" });
});

test("strict JSON parser enforces depth, node, string, and byte limits", () => {
  assert.throws(() => parseJsonStrict('{"a":{"b":{"c":1}}}', { maxDepth: 2 }), { code: "JSON_DEPTH_LIMIT" });
  assert.throws(() => parseJsonStrict("[1,2,3]", { maxNodes: 3 }), { code: "JSON_NODE_LIMIT" });
  assert.throws(() => parseJsonStrict('"abcd"', { maxStringLength: 3 }), { code: "JSON_STRING_TOO_LONG" });
  assert.throws(
    () => parseJsonStrict('"abcdef"', { warningBytes: 1, blockBytes: 5 }),
    { code: "INPUT_TOO_LARGE" },
  );
});

test("JSON import preserves OD semantics, replicate identity, censoring, and source object immutability", () => {
  const original = dataset({
    observations: [
      observation(),
      observation({
        observationId: "obs-2",
        seriesId: "series-2",
        independentUnitId: "flask-2",
        role: "validation",
        measurementType: "log10_cfu_per_ml",
        value: 2.1,
        censoring: "left",
        censoringBounds: { upper: 2.3 },
        replicate: "biological-2",
      }),
    ],
  });
  const snapshot = structuredClone(original);
  const result = importObservationDataset(`\ufeff${JSON.stringify(original)}`);
  assert.equal(result.format, "json");
  assert.equal(result.dataset.observations[0].measurementType, "od600");
  assert.equal(result.dataset.observations[0].value, 0.31);
  assert.equal(result.dataset.observations[0].replicate, "biological-1/technical-2");
  assert.deepEqual(result.dataset.observations[1].censoringBounds, { upper: 2.3 });
  assert.deepEqual(original, snapshot);
});

test("CSV import requires documented columns and parses nested fields as strict JSON", () => {
  const headers = [
    "observationId",
    "seriesId",
    "independentUnitId",
    "role",
    "timeHours",
    "drugId",
    "concentrationMgPerL",
    "measurementType",
    "value",
    "censoring",
    "censoringBounds",
    "replicate",
    "conditions",
  ];
  const conditions = JSON.stringify({
    organism: "Escherichia coli",
    strain: "BW25113",
    medium: "M9, glucose",
    temperature: { value: 37, unit: "degC" },
    note: "line one\nline two",
  });
  const values = [
    "obs-csv",
    "series-csv",
    "flask-csv",
    "development",
    "1.5",
    "ampicillin",
    "2",
    "od595",
    "0.12",
    "none",
    "null",
    "replicate-A",
    conditions,
  ];
  const text = `\ufeff${headers.join(",")}\r\n${values.map(csvCell).join(",")}\r\n`;
  const result = importObservationDataset(text, {
    format: "csv",
    datasetMetadata: { datasetId: "csv-dataset", title: "CSV dataset" },
  });
  assert.equal(result.dataset.observations[0].measurementType, "od595");
  assert.equal(result.dataset.observations[0].conditions.medium, "M9, glucose");
  assert.equal(result.dataset.observations[0].conditions.note, "line one\nline two");
  assert.equal(result.stats.bomRemoved, true);
});

test("normalization rejects missing units/semantics, silent trimming, unknown fields, and unsafe object keys", () => {
  const missingMeasurement = dataset({ observations: [observation({ measurementType: undefined })] });
  assert.throws(() => normalizeObservationDataset(missingMeasurement), { code: "INVALID_STRING" });
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [observation({ role: " training" })] })),
    { code: "INVALID_STRING" },
  );
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [{ ...observation(), unit: "mg/L" }] })),
    { code: "UNKNOWN_PROPERTY" },
  );
  const unsafeConditions = Object.create(null);
  Object.defineProperty(unsafeConditions, "__proto__", { value: "pollution", enumerable: true });
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [observation({ conditions: unsafeConditions })] })),
    { code: "UNSAFE_OBJECT_KEY" },
  );
  assert.equal({}.pollution, undefined);
});

test("normalization validates measurement domains and exact censoring-bound shape", () => {
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [observation({ measurementType: "od600", value: -0.1 })] })),
    { code: "NEGATIVE_MEASUREMENT" },
  );
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [observation({ censoring: "none", censoringBounds: {} })] })),
    { code: "INVALID_CENSORING_BOUNDS" },
  );
  assert.throws(
    () => normalizeObservationDataset(dataset({ observations: [observation({ censoring: "interval", censoringBounds: { lower: 3, upper: 2 } })] })),
    { code: "INVALID_CENSORING_INTERVAL" },
  );
  assert.equal(DATASET_IMPORT_LIMITS.warningBytes, 5 * 1024 * 1024);
  assert.equal(DATASET_IMPORT_LIMITS.blockBytes, 10 * 1024 * 1024);
  assert.equal(DATASET_IMPORT_LIMITS.warningRows, 50_000);
  assert.equal(DATASET_IMPORT_LIMITS.blockRows, 100_000);
  assert.ok(DATASET_IMPORT_LIMITS.maxColumns > 0);
  assert.ok(DATASET_IMPORT_LIMITS.maxFieldLength > 0);
});

test("CSV import rejects blank records and malformed strict numbers instead of repairing them", () => {
  const headers = [
    "observationId", "seriesId", "independentUnitId", "role", "timeHours", "drugId",
    "concentrationMgPerL", "measurementType", "value", "censoring", "censoringBounds",
    "replicate", "conditions",
  ];
  assert.throws(
    () => importObservationDataset(`${headers.join(",")}\n\n`, {
      format: "csv",
      datasetMetadata: { datasetId: "d", title: "t" },
    }),
    DatasetImportError,
  );
  const row = ["o", "s", "u", "training", "+1", "d", "0", "od600", "1", "none", "null", "r", "{}"];
  assert.throws(
    () => importObservationDataset(`${headers.join(",")}\n${row.map(csvCell).join(",")}`, {
      format: "csv",
      datasetMetadata: { datasetId: "d", title: "t" },
    }),
    { code: "INVALID_CSV_NUMBER" },
  );
});
