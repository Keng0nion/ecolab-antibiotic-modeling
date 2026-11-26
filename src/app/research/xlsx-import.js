/**
 * Minimal XLSX reader for the Research Workspace import path.
 *
 * The application has no third-party runtime dependencies, so this module
 * reads the ZIP container and the first worksheet directly. It is deliberately
 * narrow: it converts the first worksheet to CSV text and hands that text to
 * the existing strict observation importer, which owns header, type, range and
 * censoring validation. No value is interpreted as OD, CFU or a drug effect
 * here.
 *
 * Documented limits: only the first worksheet is read; formulas are taken at
 * their cached values; Excel date serials are not converted to dates; styles,
 * merged cells, hidden rows and multiple sheets are ignored. Those limits are
 * reported to the user as an import warning, not silently dropped.
 *
 * Decompression uses `DecompressionStream("deflate-raw")` when available and
 * can be injected for tests. Stored entries (method 0) need no inflater.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY = 0x02014b50;
const LOCAL_FILE = 0x04034b50;
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
// These mirror the strict CSV importer's block limits (100,000 data rows and
// 256 columns) so this layer never rejects a workbook the validator would
// accept. A plate-shaped sheet still converts; the validator then reports the
// header mismatch, which is the actionable error.
const MAX_ROWS = 100_000;
const MAX_COLUMNS = 256;

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function view(bytes) {
  if (!(bytes instanceof Uint8Array)) fail("XLSX_INVALID_INPUT", "XLSX input must be a Uint8Array.");
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function u16(data, offset, label) {
  if (offset < 0 || offset + 2 > data.byteLength) fail("XLSX_TRUNCATED", `${label} is outside the file.`);
  return data.getUint16(offset, true);
}

function u32(data, offset, label) {
  if (offset < 0 || offset + 4 > data.byteLength) fail("XLSX_TRUNCATED", `${label} is outside the file.`);
  return data.getUint32(offset, true);
}

function findEndRecord(data) {
  const minimum = Math.max(0, data.byteLength - (22 + 65_535));
  for (let offset = data.byteLength - 22; offset >= minimum; offset -= 1) {
    if (u32(data, offset, "end record") !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = u16(data, offset + 20, "comment length");
    if (offset + 22 + commentLength === data.byteLength) return offset;
  }
  fail("XLSX_NOT_ZIP", "The file is not a readable XLSX ZIP container.");
}

function decodeName(bytes) {
  const name = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (name.includes("\u0000") || name.includes("\\")) fail("XLSX_UNSAFE_PATH", "The workbook contains an unsafe entry name.");
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail("XLSX_UNSAFE_PATH", "The workbook contains an absolute entry name.");
  if (name.split("/").includes("..")) fail("XLSX_UNSAFE_PATH", "The workbook contains a traversing entry name.");
  return name;
}

function readDirectory(bytes) {
  const data = view(bytes);
  const end = findEndRecord(data);
  const total = u16(data, end + 10, "entry count");
  const size = u32(data, end + 12, "directory size");
  const start = u32(data, end + 16, "directory offset");
  if (total === 0xffff || size === 0xffffffff || start === 0xffffffff) fail("XLSX_ZIP64", "ZIP64 workbooks are not supported.");
  if (start + size > data.byteLength) fail("XLSX_TRUNCATED", "The central directory is outside the file.");
  const entries = new Map();
  let offset = start;
  let totalBytes = 0;
  for (let index = 0; index < total; index += 1) {
    if (u32(data, offset, "central signature") !== CENTRAL_DIRECTORY) fail("XLSX_CORRUPT", "The central directory is corrupt.");
    const flags = u16(data, offset + 8, "flags");
    const method = u16(data, offset + 10, "method");
    const compressedSize = u32(data, offset + 20, "compressed size");
    const uncompressedSize = u32(data, offset + 24, "uncompressed size");
    const nameLength = u16(data, offset + 28, "name length");
    const extraLength = u16(data, offset + 30, "extra length");
    const commentLength = u16(data, offset + 32, "comment length");
    const localOffset = u32(data, offset + 42, "local offset");
    if ((flags & 0x0001) !== 0) fail("XLSX_ENCRYPTED", "Encrypted workbooks are not supported.");
    if (method !== 0 && method !== 8) fail("XLSX_COMPRESSION", `ZIP compression method ${method} is not supported.`);
    if (uncompressedSize > MAX_ENTRY_BYTES) fail("XLSX_TOO_LARGE", "A workbook entry exceeds the size limit.");
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_TOTAL_BYTES) fail("XLSX_TOO_LARGE", "The workbook exceeds the uncompressed size limit.");
    const name = decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { bytes, data, entries };
}

async function readEntry(directory, name, inflateRaw) {
  const entry = directory.entries.get(name);
  if (!entry) return null;
  const data = directory.data;
  if (u32(data, entry.localOffset, "local signature") !== LOCAL_FILE) fail("XLSX_CORRUPT", `Entry ${name} has no local header.`);
  const nameLength = u16(data, entry.localOffset + 26, "local name length");
  const extraLength = u16(data, entry.localOffset + 28, "local extra length");
  const start = entry.localOffset + 30 + nameLength + extraLength;
  if (start + entry.compressedSize > data.byteLength) fail("XLSX_TRUNCATED", `Entry ${name} is truncated.`);
  const compressed = directory.bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) fail("XLSX_CORRUPT", `Entry ${name} has an inconsistent stored size.`);
    return compressed;
  }
  if (typeof inflateRaw !== "function") fail("XLSX_INFLATE_REQUIRED", "This environment cannot inflate the workbook.");
  let inflated;
  try {
    inflated = await inflateRaw(compressed);
  } catch {
    fail("XLSX_CORRUPT", `Entry ${name} could not be inflated; the workbook may be damaged or truncated.`);
  }
  if (!(inflated instanceof Uint8Array) || inflated.length !== entry.uncompressedSize) {
    fail("XLSX_CORRUPT", `Entry ${name} has an inconsistent inflated size.`);
  }
  return inflated;
}

function decodeXmlEntities(text) {
  return text.replace(/&(#(?:x[0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]*);/g, (entity, body) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return "\"";
    if (body === "apos") return "'";
    if (!body.startsWith("#")) return entity;
    const codePoint = body[1]?.toLowerCase() === "x"
      ? Number.parseInt(body.slice(2), 16)
      : Number.parseInt(body.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function textOf(xml) {
  return decodeXmlEntities([...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1]).join(""));
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((match) => textOf(match[1]));
}

function columnIndex(reference) {
  const letters = /^([A-Z]+)/u.exec(reference ?? "")?.[1];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function rowIndex(reference) {
  const digits = /(\d+)$/u.exec(reference ?? "")?.[1];
  return digits ? Number.parseInt(digits, 10) - 1 : null;
}

function attributes(source) {
  const result = Object.create(null);
  for (const match of source.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    result[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? "");
  }
  return result;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = attributes(match[1]);
    const row = rowIndex(attrs.r);
    const column = columnIndex(attrs.r);
    if (row === null || column === null) continue;
    if (row >= MAX_ROWS || column >= MAX_COLUMNS) {
      fail(
        "XLSX_TOO_WIDE",
        `The first worksheet exceeds ${MAX_ROWS} rows or ${MAX_COLUMNS} columns. `
          + "The observation format needs one row per observation; reshape wide plate layouts to that long format first.",
      );
    }
    const body = match[2] ?? "";
    let value = "";
    if (attrs.t === "s") {
      const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/u.exec(body)?.[1] ?? "", 10);
      value = Number.isInteger(index) ? sharedStrings[index] ?? "" : "";
    } else if (attrs.t === "inlineStr") {
      value = textOf(body);
    } else {
      value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/u.exec(body)?.[1] ?? "");
    }
    if (!rows[row]) rows[row] = [];
    rows[row][column] = value;
  }
  return rows.map((row) => Array.from(row ?? [], (cell) => cell ?? ""));
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function rowsToCsv(rows) {
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  return rows.map((row) => Array.from({ length: width }, (_, index) => csvCell(row[index])).join(",")).join("\r\n");
}

/**
 * Default inflater for browser and Node 18+ runtimes. `deflate-raw` is the
 * format ZIP entries use; it is supported by Chrome 103+, Edge 103+, Safari
 * 16.4+, Firefox 113+ and Node 21+.
 */
async function defaultInflateRaw(compressed) {
  if (typeof DecompressionStream !== "function") {
    fail(
      "XLSX_INFLATE_UNAVAILABLE",
      "This browser cannot decompress XLSX files. Re-export the sheet as CSV and import that file instead.",
    );
  }
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    fail(
      "XLSX_INFLATE_UNAVAILABLE",
      "This browser cannot decompress XLSX files. Re-export the sheet as CSV and import that file instead.",
    );
  }
}

function firstWorksheetName(xml) {
  if (!xml) return null;
  const sheet = /<sheet\b([^>]*?)\/?>/u.exec(xml);
  if (!sheet) return null;
  const name = attributes(sheet[1]).name;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Convert the first worksheet of an XLSX byte array to CSV text.
 * `inflateRaw` may be supplied to override decompression; deflated entries need
 * an inflater, stored entries do not.
 */
export async function xlsxToCsv(bytes, { inflateRaw = defaultInflateRaw } = {}) {
  const directory = readDirectory(bytes);
  const sheetNames = [...directory.entries.keys()]
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name))
    .sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
  if (sheetNames.length === 0) fail("XLSX_NO_WORKSHEET", "The workbook has no readable worksheet.");
  const [workbookXml, sharedXml, sheetXml] = await Promise.all([
    readEntry(directory, "xl/workbook.xml", inflateRaw),
    readEntry(directory, "xl/sharedStrings.xml", inflateRaw),
    readEntry(directory, sheetNames[0], inflateRaw),
  ]);
  if (!sheetXml) fail("XLSX_NO_WORKSHEET", "The first worksheet could not be read.");
  const decoder = new TextDecoder("utf-8");
  const sharedStrings = parseSharedStrings(sharedXml ? decoder.decode(sharedXml) : null);
  const rows = parseSheet(decoder.decode(sheetXml), sharedStrings);
  if (rows.length === 0) fail("XLSX_EMPTY", "The first worksheet is empty.");
  return {
    csv: rowsToCsv(rows),
    worksheetName: firstWorksheetName(workbookXml ? decoder.decode(workbookXml) : null),
    worksheetCount: sheetNames.length,
    rowCount: rows.length,
    columnCount: rows.reduce((maximum, row) => Math.max(maximum, row.length), 0),
  };
}
