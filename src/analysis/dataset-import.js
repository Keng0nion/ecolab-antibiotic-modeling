const MIB = 1024 * 1024;

export const DATASET_IMPORT_LIMITS = Object.freeze({
  warningBytes: 5 * MIB,
  blockBytes: 10 * MIB,
  warningRows: 50_000,
  blockRows: 100_000,
  maxColumns: 256,
  maxFieldLength: MIB,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxStringLength: MIB,
});

const ROLES = new Set(["training", "validation", "development"]);
const MEASUREMENT_TYPES = new Set([
  "log10_cfu_per_ml",
  "cfu_per_ml",
  "od600",
  "od595",
]);
const CENSORING_TYPES = new Set(["none", "left", "right", "interval"]);
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const DATASET_KEYS = new Set(["schemaVersion", "kind", "metadata", "observations"]);
const METADATA_KEYS = new Set([
  "datasetId",
  "title",
  "description",
  "createdAt",
  "license",
  "sourceIds",
  "conditions",
]);
const OBSERVATION_KEYS = new Set([
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
]);
const CSV_HEADERS = [...OBSERVATION_KEYS];

export class DatasetImportError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DatasetImportError";
    this.code = code;
    this.path = details.path ?? null;
    this.offset = details.offset ?? null;
    this.expected = details.expected;
    this.actual = details.actual;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      path: this.path,
      offset: this.offset,
      expected: this.expected,
      actual: this.actual,
    };
  }
}

function fail(code, message, details) {
  throw new DatasetImportError(code, message, details);
}

function mergeLimits(overrides = {}) {
  if (!isRecord(overrides)) {
    fail("INVALID_LIMITS", "limits must be a plain object.", {
      path: "limits",
      expected: "plain object",
      actual: overrides,
    });
  }
  const limits = { ...DATASET_IMPORT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits)) {
      fail("UNKNOWN_LIMIT", `Unknown import limit: ${key}.`, {
        path: `limits.${key}`,
        expected: Object.keys(limits),
        actual: value,
      });
    }
    if (!Number.isSafeInteger(value) || value <= 0) {
      fail("INVALID_LIMIT", `${key} must be a positive safe integer.`, {
        path: `limits.${key}`,
        expected: "positive safe integer",
        actual: value,
      });
    }
    limits[key] = value;
  }
  if (limits.warningBytes > limits.blockBytes) {
    fail("INVALID_LIMIT_ORDER", "warningBytes cannot exceed blockBytes.", {
      path: "limits.warningBytes",
      expected: `<= ${limits.blockBytes}`,
      actual: limits.warningBytes,
    });
  }
  if (limits.warningRows > limits.blockRows) {
    fail("INVALID_LIMIT_ORDER", "warningRows cannot exceed blockRows.", {
      path: "limits.warningRows",
      expected: `<= ${limits.blockRows}`,
      actual: limits.warningRows,
    });
  }
  return limits;
}

function utf8Bytes(text) {
  let length = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) length += 1;
    else if (code <= 0x7ff) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      length += 4;
    } else length += 3;
  }
  return length;
}

function checkTextSize(text, limits, path) {
  if (typeof text !== "string") {
    fail("INVALID_TEXT_INPUT", `${path} must be a string.`, {
      path,
      expected: "string",
      actual: typeof text,
    });
  }
  const bytes = utf8Bytes(text);
  if (bytes > limits.blockBytes) {
    fail("INPUT_TOO_LARGE", `${path} exceeds the ${limits.blockBytes}-byte block limit.`, {
      path,
      expected: `<= ${limits.blockBytes} UTF-8 bytes`,
      actual: bytes,
    });
  }
  return bytes;
}

function warning(code, message, details = {}) {
  const result = { code, severity: "warning", message };
  if (Object.keys(details).length > 0) result.details = details;
  return result;
}

/**
 * Parse RFC-4180-style CSV with a character state machine. Quoted commas,
 * CR/LF newlines and doubled quote escapes are preserved. Blank records are
 * not discarded; downstream import rejects malformed column counts.
 */
export function parseCsv(text, options = {}) {
  const limits = mergeLimits(options.limits ?? options);
  const delimiter = options.delimiter ?? ",";
  if (
    typeof delimiter !== "string" ||
    delimiter.length !== 1 ||
    delimiter === "\"" ||
    delimiter === "\r" ||
    delimiter === "\n"
  ) {
    fail("INVALID_CSV_DELIMITER", "CSV delimiter must be one non-quote, non-newline character.", {
      path: "delimiter",
      expected: "one non-quote, non-newline character",
      actual: delimiter,
    });
  }

  const bytes = checkTextSize(text, limits, "csv");
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = [];
  let row = [];
  let field = "";
  let state = "field_start";
  let index = 0;

  function append(character) {
    field += character;
    if (field.length > limits.maxFieldLength) {
      fail("CSV_FIELD_TOO_LONG", `CSV field exceeds ${limits.maxFieldLength} characters.`, {
        path: `rows.${rows.length}.${row.length}`,
        offset: index,
        expected: `<= ${limits.maxFieldLength} characters`,
        actual: field.length,
      });
    }
  }

  function pushField() {
    row.push(field);
    field = "";
    if (row.length > limits.maxColumns) {
      fail("CSV_TOO_MANY_COLUMNS", `CSV row exceeds ${limits.maxColumns} columns.`, {
        path: `rows.${rows.length}`,
        offset: index,
        expected: `<= ${limits.maxColumns} columns`,
        actual: row.length,
      });
    }
  }

  function pushRow() {
    pushField();
    rows.push(row);
    row = [];
    if (rows.length > limits.blockRows + 1) {
      fail("CSV_TOO_MANY_ROWS", `CSV exceeds the ${limits.blockRows}-data-row block limit.`, {
        path: "rows",
        offset: index,
        expected: `<= ${limits.blockRows} data rows plus one header`,
        actual: rows.length,
      });
    }
  }

  while (index < source.length) {
    const character = source[index];
    const isCrLf = character === "\r" && source[index + 1] === "\n";
    const isNewline = character === "\n" || character === "\r";

    if (state === "quoted") {
      if (character === "\"") state = "after_quote";
      else append(character);
      index += 1;
      continue;
    }

    if (state === "after_quote") {
      if (character === "\"") {
        append("\"");
        state = "quoted";
      } else if (character === delimiter) {
        pushField();
        state = "field_start";
      } else if (isNewline) {
        pushRow();
        state = "field_start";
        if (isCrLf) index += 1;
      } else {
        fail("CSV_CHAR_AFTER_QUOTE", "Only a delimiter or newline may follow a closing CSV quote.", {
          path: `rows.${rows.length}.${row.length}`,
          offset: index,
          expected: "escaped quote, delimiter, newline, or end of input",
          actual: character,
        });
      }
      index += 1;
      continue;
    }

    if (state === "field_start" && character === "\"") {
      state = "quoted";
    } else if (character === delimiter) {
      pushField();
      state = "field_start";
    } else if (isNewline) {
      pushRow();
      state = "field_start";
      if (isCrLf) index += 1;
    } else if (character === "\"") {
      fail("CSV_QUOTE_IN_UNQUOTED_FIELD", "A quote cannot appear inside an unquoted CSV field.", {
        path: `rows.${rows.length}.${row.length}`,
        offset: index,
        expected: "unquoted character or a fully quoted field",
        actual: character,
      });
    } else {
      append(character);
      state = "unquoted";
    }
    index += 1;
  }

  if (state === "quoted") {
    fail("CSV_UNTERMINATED_QUOTE", "CSV ended inside a quoted field.", {
      path: `rows.${rows.length}.${row.length}`,
      offset: source.length,
      expected: "closing quote",
      actual: "end of input",
    });
  }
  if (source.length > 0 && (row.length > 0 || field.length > 0 || state === "after_quote" || state === "unquoted")) {
    pushRow();
  }

  const warnings = [];
  if (bytes > limits.warningBytes) {
    warnings.push(warning("LARGE_INPUT", `CSV exceeds the ${limits.warningBytes}-byte warning threshold.`, { bytes }));
  }
  const dataRows = Math.max(0, rows.length - 1);
  if (dataRows > limits.warningRows) {
    warnings.push(warning("MANY_ROWS", `CSV exceeds the ${limits.warningRows}-data-row warning threshold.`, { rows: dataRows }));
  }

  return {
    rows,
    warnings,
    stats: {
      bytes,
      rowCount: rows.length,
      dataRowCount: dataRows,
      columnCount: rows[0]?.length ?? 0,
      bomRemoved: text.charCodeAt(0) === 0xfeff,
    },
  };
}

class StrictJsonParser {
  constructor(text, limits) {
    this.text = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    this.limits = limits;
    this.index = 0;
    this.nodes = 0;
  }

  error(code, message, path, expected, actual = this.text[this.index] ?? "end of input") {
    fail(code, message, { path, offset: this.index, expected, actual });
  }

  skipWhitespace() {
    while (this.index < this.text.length && /[\u0009\u000a\u000d\u0020]/.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  countNode(path) {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      this.error("JSON_NODE_LIMIT", `JSON exceeds ${this.limits.maxNodes} values.`, path, `<= ${this.limits.maxNodes} values`, this.nodes);
    }
  }

  parse() {
    this.skipWhitespace();
    const value = this.parseValue("$", 0);
    this.skipWhitespace();
    if (this.index !== this.text.length) {
      this.error("JSON_TRAILING_CONTENT", "JSON has trailing non-whitespace content.", "$", "end of input");
    }
    return value;
  }

  parseValue(path, depth) {
    if (depth > this.limits.maxDepth) {
      this.error("JSON_DEPTH_LIMIT", `JSON exceeds maximum depth ${this.limits.maxDepth}.`, path, `depth <= ${this.limits.maxDepth}`, depth);
    }
    this.skipWhitespace();
    this.countNode(path);
    const character = this.text[this.index];
    if (character === "{") return this.parseObject(path, depth);
    if (character === "[") return this.parseArray(path, depth);
    if (character === "\"") return this.parseString(path);
    if (character === "t") return this.parseLiteral("true", true, path);
    if (character === "f") return this.parseLiteral("false", false, path);
    if (character === "n") return this.parseLiteral("null", null, path);
    if (character === "-" || (character >= "0" && character <= "9")) return this.parseNumber(path);
    this.error("INVALID_JSON_VALUE", "Expected a strict JSON value.", path, "object, array, string, finite number, boolean, or null");
  }

  parseLiteral(token, value, path) {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      this.error("INVALID_JSON_LITERAL", `Invalid JSON literal at ${path}.`, path, token);
    }
    this.index += token.length;
    return value;
  }

  parseString(path) {
    this.index += 1;
    let result = "";
    while (this.index < this.text.length) {
      const character = this.text[this.index];
      if (character === "\"") {
        this.index += 1;
        return result;
      }
      if (character === "\\") {
        this.index += 1;
        const escape = this.text[this.index];
        const simple = {
          "\"": "\"",
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape in simple) {
          result += simple[escape];
          this.index += 1;
        } else if (escape === "u") {
          const hex = this.text.slice(this.index + 1, this.index + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.error("INVALID_JSON_ESCAPE", `Invalid Unicode escape at ${path}.`, path, "four hexadecimal digits", hex);
          }
          result += String.fromCharCode(Number.parseInt(hex, 16));
          this.index += 5;
        } else {
          this.error("INVALID_JSON_ESCAPE", `Invalid JSON escape at ${path}.`, path, "valid JSON escape", escape);
        }
      } else {
        if (character.charCodeAt(0) < 0x20) {
          this.error("JSON_CONTROL_CHARACTER", `Unescaped control character at ${path}.`, path, "escaped control character", character.charCodeAt(0));
        }
        result += character;
        this.index += 1;
      }
      if (result.length > this.limits.maxStringLength) {
        this.error("JSON_STRING_TOO_LONG", `JSON string exceeds ${this.limits.maxStringLength} characters.`, path, `<= ${this.limits.maxStringLength} characters`, result.length);
      }
    }
    this.error("JSON_UNTERMINATED_STRING", `Unterminated JSON string at ${path}.`, path, "closing quote", "end of input");
  }

  parseNumber(path) {
    const start = this.index;
    if (this.text[this.index] === "-") this.index += 1;
    if (this.text[this.index] === "0") {
      this.index += 1;
      if (/[0-9]/.test(this.text[this.index] ?? "")) {
        this.error("INVALID_JSON_NUMBER", `Leading zero in JSON number at ${path}.`, path, "strict JSON number");
      }
    } else if (/[1-9]/.test(this.text[this.index] ?? "")) {
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    } else {
      this.error("INVALID_JSON_NUMBER", `Invalid JSON number at ${path}.`, path, "strict JSON number");
    }
    if (this.text[this.index] === ".") {
      this.index += 1;
      if (!/[0-9]/.test(this.text[this.index] ?? "")) {
        this.error("INVALID_JSON_NUMBER", `JSON fraction needs digits at ${path}.`, path, "digit after decimal point");
      }
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    if (this.text[this.index] === "e" || this.text[this.index] === "E") {
      this.index += 1;
      if (this.text[this.index] === "+" || this.text[this.index] === "-") this.index += 1;
      if (!/[0-9]/.test(this.text[this.index] ?? "")) {
        this.error("INVALID_JSON_NUMBER", `JSON exponent needs digits at ${path}.`, path, "exponent digits");
      }
      while (/[0-9]/.test(this.text[this.index] ?? "")) this.index += 1;
    }
    const token = this.text.slice(start, this.index);
    const value = Number(token);
    if (!Number.isFinite(value)) {
      this.error("NON_FINITE_JSON_NUMBER", `JSON number is not finite at ${path}.`, path, "finite number", token);
    }
    return value;
  }

  parseArray(path, depth) {
    this.index += 1;
    const result = [];
    this.skipWhitespace();
    if (this.text[this.index] === "]") {
      this.index += 1;
      return result;
    }
    let itemIndex = 0;
    while (true) {
      result.push(this.parseValue(`${path}[${itemIndex}]`, depth + 1));
      itemIndex += 1;
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.error("INVALID_JSON_ARRAY", `Expected comma or closing bracket at ${path}.`, path, ", or ]");
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text[this.index] === "]") {
        this.error("JSON_TRAILING_COMMA", `Trailing commas are not valid JSON at ${path}.`, path, "array value");
      }
    }
  }

  parseObject(path, depth) {
    this.index += 1;
    const result = Object.create(null);
    const keys = new Set();
    this.skipWhitespace();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return result;
    }
    while (true) {
      if (this.text[this.index] !== "\"") {
        this.error("JSON_OBJECT_KEY", `JSON object keys must be quoted strings at ${path}.`, path, "quoted string key");
      }
      const key = this.parseString(`${path} key`);
      if (UNSAFE_KEYS.has(key)) {
        this.error("UNSAFE_OBJECT_KEY", `Unsafe object key is forbidden: ${key}.`, `${path}.${key}`, "safe object key", key);
      }
      if (keys.has(key)) {
        this.error("DUPLICATE_JSON_KEY", `Duplicate JSON key at ${path}: ${key}.`, `${path}.${key}`, "unique object key", key);
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.text[this.index] !== ":") {
        this.error("JSON_MISSING_COLON", `Missing colon after key ${key}.`, `${path}.${key}`, ":");
      }
      this.index += 1;
      result[key] = this.parseValue(`${path}.${key}`, depth + 1);
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return result;
      }
      if (this.text[this.index] !== ",") {
        this.error("INVALID_JSON_OBJECT", `Expected comma or closing brace at ${path}.`, path, ", or }");
      }
      this.index += 1;
      this.skipWhitespace();
      if (this.text[this.index] === "}") {
        this.error("JSON_TRAILING_COMMA", `Trailing commas are not valid JSON at ${path}.`, path, "object member");
      }
    }
  }
}

/** Parse strict JSON while detecting duplicate and prototype-pollution keys. */
export function parseJsonStrict(text, options = {}) {
  const limits = mergeLimits(options.limits ?? options);
  checkTextSize(text, limits, "json");
  return new StrictJsonParser(text, limits).parse();
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isRecord(value)) {
    fail("INVALID_OBJECT", `${path} must be a plain object.`, {
      path,
      expected: "plain object",
      actual: value,
    });
  }
  return value;
}

function assertAllowedKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (UNSAFE_KEYS.has(key)) {
      fail("UNSAFE_OBJECT_KEY", `Unsafe object key is forbidden: ${key}.`, {
        path: `${path}.${key}`,
        expected: "safe object key",
        actual: key,
      });
    }
    if (!allowed.has(key)) {
      fail("UNKNOWN_PROPERTY", `Unknown property ${path}.${key}.`, {
        path: `${path}.${key}`,
        expected: [...allowed],
        actual: key,
      });
    }
  }
}

function assertExactString(value, path) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("INVALID_STRING", `${path} must be a non-empty string without surrounding whitespace.`, {
      path,
      expected: "non-empty string without surrounding whitespace",
      actual: value,
    });
  }
  return value;
}

function optionalString(value, path) {
  if (value === undefined) return undefined;
  return assertExactString(value, path);
}

function assertFinite(value, path, minimum = -Infinity) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum) {
    fail("INVALID_NUMBER", `${path} must be a finite number >= ${minimum}.`, {
      path,
      expected: `finite number >= ${minimum}`,
      actual: value,
    });
  }
  return value;
}

function copySafeJson(value, path, limits, state, depth = 0) {
  if (depth > limits.maxDepth) {
    fail("JSON_DEPTH_LIMIT", `${path} exceeds maximum depth ${limits.maxDepth}.`, {
      path,
      expected: `depth <= ${limits.maxDepth}`,
      actual: depth,
    });
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    fail("JSON_NODE_LIMIT", `${path} exceeds the ${limits.maxNodes}-node limit.`, {
      path,
      expected: `<= ${limits.maxNodes} nodes`,
      actual: state.nodes,
    });
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > limits.maxStringLength) {
      fail("JSON_STRING_TOO_LONG", `${path} exceeds ${limits.maxStringLength} characters.`, {
        path,
        expected: `<= ${limits.maxStringLength} characters`,
        actual: value.length,
      });
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("NON_FINITE_JSON_NUMBER", `${path} must be finite.`, {
        path,
        expected: "finite number",
        actual: value,
      });
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => copySafeJson(item, `${path}[${index}]`, limits, state, depth + 1));
  }
  assertRecord(value, path);
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) {
      fail("UNSAFE_OBJECT_KEY", `Unsafe object key is forbidden: ${key}.`, {
        path: `${path}.${key}`,
        expected: "safe object key",
        actual: key,
      });
    }
    if (child === undefined || typeof child === "bigint" || typeof child === "function" || typeof child === "symbol") {
      fail("NON_JSON_VALUE", `${path}.${key} must be JSON-compatible.`, {
        path: `${path}.${key}`,
        expected: "JSON-compatible value",
        actual: typeof child,
      });
    }
    result[key] = copySafeJson(child, `${path}.${key}`, limits, state, depth + 1);
  }
  return result;
}

function normalizeConditions(value, path, limits, state) {
  assertRecord(value, path);
  return copySafeJson(value, path, limits, state);
}

function normalizeBounds(censoring, bounds, path) {
  if (censoring === "none") {
    if (bounds !== null) {
      fail("INVALID_CENSORING_BOUNDS", `${path} must be null when censoring is none.`, {
        path,
        expected: null,
        actual: bounds,
      });
    }
    return null;
  }
  assertRecord(bounds, path);
  const allowed = censoring === "left"
    ? new Set(["upper"])
    : censoring === "right"
      ? new Set(["lower"])
      : new Set(["lower", "upper"]);
  assertAllowedKeys(bounds, allowed, path);
  if (censoring === "left") return { upper: assertFinite(bounds.upper, `${path}.upper`) };
  if (censoring === "right") return { lower: assertFinite(bounds.lower, `${path}.lower`) };
  const lower = assertFinite(bounds.lower, `${path}.lower`);
  const upper = assertFinite(bounds.upper, `${path}.upper`);
  if (lower > upper) {
    fail("INVALID_CENSORING_INTERVAL", `${path}.lower cannot exceed ${path}.upper.`, {
      path,
      expected: "lower <= upper",
      actual: { lower, upper },
    });
  }
  return { lower, upper };
}

function normalizeMetadata(metadata, limits, state) {
  assertRecord(metadata, "dataset.metadata");
  assertAllowedKeys(metadata, METADATA_KEYS, "dataset.metadata");
  const normalized = {
    datasetId: assertExactString(metadata.datasetId, "dataset.metadata.datasetId"),
    title: assertExactString(metadata.title, "dataset.metadata.title"),
  };
  for (const key of ["description", "createdAt", "license"]) {
    const value = optionalString(metadata[key], `dataset.metadata.${key}`);
    if (value !== undefined) normalized[key] = value;
  }
  if (metadata.sourceIds !== undefined) {
    if (!Array.isArray(metadata.sourceIds)) {
      fail("INVALID_SOURCE_IDS", "dataset.metadata.sourceIds must be an array.", {
        path: "dataset.metadata.sourceIds",
        expected: "array of unique non-empty strings",
        actual: metadata.sourceIds,
      });
    }
    const sourceIds = metadata.sourceIds.map((sourceId, index) => assertExactString(sourceId, `dataset.metadata.sourceIds[${index}]`));
    if (new Set(sourceIds).size !== sourceIds.length) {
      fail("DUPLICATE_SOURCE_ID", "dataset.metadata.sourceIds must be unique.", {
        path: "dataset.metadata.sourceIds",
        expected: "unique strings",
        actual: sourceIds,
      });
    }
    normalized.sourceIds = sourceIds;
  }
  if (metadata.conditions !== undefined) {
    normalized.conditions = normalizeConditions(metadata.conditions, "dataset.metadata.conditions", limits, state);
  }
  return normalized;
}

function normalizeObservation(observation, index, limits, state) {
  const path = `dataset.observations[${index}]`;
  assertRecord(observation, path);
  assertAllowedKeys(observation, OBSERVATION_KEYS, path);
  const role = assertExactString(observation.role, `${path}.role`);
  if (!ROLES.has(role)) {
    fail("INVALID_ROLE", `${path}.role is not supported.`, {
      path: `${path}.role`,
      expected: [...ROLES],
      actual: role,
    });
  }
  const measurementType = assertExactString(observation.measurementType, `${path}.measurementType`);
  if (!MEASUREMENT_TYPES.has(measurementType)) {
    fail("INVALID_MEASUREMENT_TYPE", `${path}.measurementType is not supported.`, {
      path: `${path}.measurementType`,
      expected: [...MEASUREMENT_TYPES],
      actual: measurementType,
    });
  }
  const censoring = assertExactString(observation.censoring, `${path}.censoring`);
  if (!CENSORING_TYPES.has(censoring)) {
    fail("INVALID_CENSORING", `${path}.censoring is not supported.`, {
      path: `${path}.censoring`,
      expected: [...CENSORING_TYPES],
      actual: censoring,
    });
  }
  const value = assertFinite(observation.value, `${path}.value`);
  if (measurementType !== "log10_cfu_per_ml" && value < 0) {
    fail("NEGATIVE_MEASUREMENT", `${path}.value cannot be negative for ${measurementType}.`, {
      path: `${path}.value`,
      expected: ">= 0",
      actual: value,
    });
  }
  return {
    observationId: assertExactString(observation.observationId, `${path}.observationId`),
    seriesId: assertExactString(observation.seriesId, `${path}.seriesId`),
    independentUnitId: assertExactString(observation.independentUnitId, `${path}.independentUnitId`),
    role,
    timeHours: assertFinite(observation.timeHours, `${path}.timeHours`, 0),
    drugId: assertExactString(observation.drugId, `${path}.drugId`),
    concentrationMgPerL: assertFinite(observation.concentrationMgPerL, `${path}.concentrationMgPerL`, 0),
    measurementType,
    value,
    censoring,
    censoringBounds: normalizeBounds(censoring, observation.censoringBounds, `${path}.censoringBounds`),
    replicate: assertExactString(observation.replicate, `${path}.replicate`),
    conditions: normalizeConditions(observation.conditions, `${path}.conditions`, limits, state),
  };
}

/**
 * Validate and reconstruct the documented observation dataset. No units are
 * inferred and no measurement type is converted; OD, CFU, replicate and
 * censoring semantics remain explicit.
 */
export function normalizeObservationDataset(input, options = {}) {
  const limits = mergeLimits(options.limits ?? options);
  const state = { nodes: 0 };
  assertRecord(input, "dataset");
  assertAllowedKeys(input, DATASET_KEYS, "dataset");
  if (input.schemaVersion !== "1.0.0") {
    fail("UNSUPPORTED_SCHEMA_VERSION", "dataset.schemaVersion must be 1.0.0.", {
      path: "dataset.schemaVersion",
      expected: "1.0.0",
      actual: input.schemaVersion,
    });
  }
  if (input.kind !== "observation-dataset") {
    fail("INVALID_DATASET_KIND", "dataset.kind must be observation-dataset.", {
      path: "dataset.kind",
      expected: "observation-dataset",
      actual: input.kind,
    });
  }
  if (!Array.isArray(input.observations)) {
    fail("INVALID_OBSERVATIONS", "dataset.observations must be an array.", {
      path: "dataset.observations",
      expected: "array",
      actual: input.observations,
    });
  }
  if (input.observations.length > limits.blockRows) {
    fail("TOO_MANY_OBSERVATIONS", `Dataset exceeds ${limits.blockRows} observations.`, {
      path: "dataset.observations",
      expected: `<= ${limits.blockRows} observations`,
      actual: input.observations.length,
    });
  }
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: normalizeMetadata(input.metadata, limits, state),
    observations: input.observations.map((observation, index) => normalizeObservation(observation, index, limits, state)),
  };
}

function parseCsvNumber(value, path) {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value)) {
    fail("INVALID_CSV_NUMBER", `${path} must contain a strict finite decimal number.`, {
      path,
      expected: "strict finite decimal number",
      actual: value,
    });
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    fail("INVALID_CSV_NUMBER", `${path} must contain a finite number.`, {
      path,
      expected: "finite number",
      actual: value,
    });
  }
  return number;
}

function datasetFromCsvRows(rows, metadata, limits) {
  if (rows.length === 0) {
    fail("EMPTY_CSV", "CSV must contain a header row.", {
      path: "csv",
      expected: "header row",
      actual: "empty input",
    });
  }
  const headers = rows[0];
  if (headers.some((header) => header === "")) {
    fail("EMPTY_CSV_HEADER", "CSV headers cannot be empty.", {
      path: "csv.headers",
      expected: CSV_HEADERS,
      actual: headers,
    });
  }
  if (new Set(headers).size !== headers.length) {
    fail("DUPLICATE_CSV_HEADER", "CSV headers must be unique.", {
      path: "csv.headers",
      expected: "unique headers",
      actual: headers,
    });
  }
  const missing = CSV_HEADERS.filter((header) => !headers.includes(header));
  const unknown = headers.filter((header) => !OBSERVATION_KEYS.has(header));
  if (missing.length > 0 || unknown.length > 0) {
    fail("INVALID_CSV_HEADERS", "CSV must use the documented observation columns exactly.", {
      path: "csv.headers",
      expected: CSV_HEADERS,
      actual: { missing, unknown },
    });
  }
  const positions = Object.fromEntries(headers.map((header, index) => [header, index]));
  const observations = rows.slice(1).map((row, rowIndex) => {
    const path = `csv.rows[${rowIndex + 1}]`;
    if (row.length !== headers.length) {
      fail("CSV_COLUMN_COUNT_MISMATCH", `${path} has ${row.length} columns; expected ${headers.length}.`, {
        path,
        expected: headers.length,
        actual: row.length,
      });
    }
    const get = (header) => row[positions[header]];
    let conditions;
    let censoringBounds;
    try {
      conditions = parseJsonStrict(get("conditions"), { limits });
    } catch (error) {
      if (error instanceof DatasetImportError) error.path = `${path}.conditions${error.path === "$" ? "" : `.${error.path}`}`;
      throw error;
    }
    try {
      censoringBounds = parseJsonStrict(get("censoringBounds"), { limits });
    } catch (error) {
      if (error instanceof DatasetImportError) error.path = `${path}.censoringBounds${error.path === "$" ? "" : `.${error.path}`}`;
      throw error;
    }
    return {
      observationId: get("observationId"),
      seriesId: get("seriesId"),
      independentUnitId: get("independentUnitId"),
      role: get("role"),
      timeHours: parseCsvNumber(get("timeHours"), `${path}.timeHours`),
      drugId: get("drugId"),
      concentrationMgPerL: parseCsvNumber(get("concentrationMgPerL"), `${path}.concentrationMgPerL`),
      measurementType: get("measurementType"),
      value: parseCsvNumber(get("value"), `${path}.value`),
      censoring: get("censoring"),
      censoringBounds,
      replicate: get("replicate"),
      conditions,
    };
  });
  return normalizeObservationDataset({
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata,
    observations,
  }, { limits });
}

/** Import strict JSON text, CSV text, or an already parsed object. */
export function importObservationDataset(input, options = {}) {
  const limits = mergeLimits(options.limits ?? {});
  let format = options.format ?? "auto";
  if (!new Set(["auto", "json", "csv", "object"]).has(format)) {
    fail("INVALID_IMPORT_FORMAT", "format must be auto, json, csv, or object.", {
      path: "format",
      expected: ["auto", "json", "csv", "object"],
      actual: format,
    });
  }
  if (format === "auto") {
    if (typeof input === "string") {
      const first = input.replace(/^\ufeff/, "").trimStart()[0];
      format = first === "{" || first === "[" ? "json" : "csv";
    } else format = "object";
  }

  let dataset;
  let warnings = [];
  let stats;
  if (format === "object") {
    dataset = normalizeObservationDataset(input, { limits });
    stats = { bytes: null, rowCount: dataset.observations.length, columnCount: null };
  } else if (format === "json") {
    const bytes = checkTextSize(input, limits, "json");
    const parsed = parseJsonStrict(input, { limits });
    dataset = normalizeObservationDataset(parsed, { limits });
    if (bytes > limits.warningBytes) {
      warnings.push(warning("LARGE_INPUT", `JSON exceeds the ${limits.warningBytes}-byte warning threshold.`, { bytes }));
    }
    if (dataset.observations.length > limits.warningRows) {
      warnings.push(warning("MANY_ROWS", `Dataset exceeds the ${limits.warningRows}-observation warning threshold.`, { rows: dataset.observations.length }));
    }
    stats = { bytes, rowCount: dataset.observations.length, columnCount: null };
  } else {
    const parsed = parseCsv(input, { limits, delimiter: options.delimiter ?? "," });
    dataset = datasetFromCsvRows(parsed.rows, options.datasetMetadata, limits);
    warnings = parsed.warnings;
    stats = {
      bytes: parsed.stats.bytes,
      rowCount: dataset.observations.length,
      columnCount: parsed.stats.columnCount,
      bomRemoved: parsed.stats.bomRemoved,
    };
  }

  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset-import-result",
    format,
    dataset,
    warnings,
    stats,
  };
}

export const importDataset = importObservationDataset;
