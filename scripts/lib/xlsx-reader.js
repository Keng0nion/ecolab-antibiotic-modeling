import { readFile } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const ZIP_SIGNATURES = Object.freeze({
  localFile: 0x04034b50,
  centralDirectory: 0x02014b50,
  endOfCentralDirectory: 0x06054b50,
});
const MAX_ZIP_COMMENT_BYTES = 65_535;
const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function fail(message) {
  throw new Error(`Invalid XLSX: ${message}`);
}

function requireRange(buffer, offset, length, description) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > buffer.length) {
    fail(`${description} is outside the file bounds.`);
  }
}

function readUInt16(buffer, offset, description) {
  requireRange(buffer, offset, 2, description);
  return buffer.readUInt16LE(offset);
}

function readUInt32(buffer, offset, description) {
  requireRange(buffer, offset, 4, description);
  return buffer.readUInt32LE(offset);
}

const CRC32_TABLE = new Uint32Array(256);
for (let value = 0; value < CRC32_TABLE.length; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  CRC32_TABLE[value] = crc >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function decodeZipName(bytes, utf8) {
  if (!utf8 && bytes.some((byte) => byte >= 0x80)) {
    fail("a non-ASCII ZIP entry name does not declare UTF-8 encoding.");
  }
  const name = bytes.toString("utf8");
  if (name.includes("\u0000") || name.includes("\\")) fail(`unsafe ZIP entry path ${JSON.stringify(name)}.`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail(`absolute ZIP entry path ${JSON.stringify(name)}.`);
  const parts = name.split("/");
  if (parts.some((part) => part === "..")) fail(`traversing ZIP entry path ${JSON.stringify(name)}.`);
  const normalized = path.posix.normalize(name);
  if (normalized === "." || normalized.startsWith("../") || normalized !== name.replace(/\/$/, "") && normalized !== name) {
    fail(`non-canonical ZIP entry path ${JSON.stringify(name)}.`);
  }
  return name;
}

function findEndOfCentralDirectory(buffer) {
  const minimumOffset = Math.max(0, buffer.length - (22 + MAX_ZIP_COMMENT_BYTES));
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== ZIP_SIGNATURES.endOfCentralDirectory) continue;
    const commentLength = readUInt16(buffer, offset + 20, "ZIP comment length");
    if (offset + 22 + commentLength !== buffer.length) continue;
    return offset;
  }
  fail("ZIP end-of-central-directory record was not found.");
}

function parseZip(buffer) {
  if (!Buffer.isBuffer(buffer)) fail("input is not a Buffer.");
  if (buffer.length < 22) fail("file is too short to be a ZIP archive.");

  const endOffset = findEndOfCentralDirectory(buffer);
  const diskNumber = readUInt16(buffer, endOffset + 4, "ZIP disk number");
  const centralDisk = readUInt16(buffer, endOffset + 6, "ZIP central-directory disk");
  const diskEntries = readUInt16(buffer, endOffset + 8, "ZIP disk entry count");
  const totalEntries = readUInt16(buffer, endOffset + 10, "ZIP entry count");
  const centralSize = readUInt32(buffer, endOffset + 12, "ZIP central-directory size");
  const centralOffset = readUInt32(buffer, endOffset + 16, "ZIP central-directory offset");

  if (diskNumber !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) fail("multi-disk ZIP archives are not supported.");
  if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) fail("ZIP64 archives are not supported.");
  requireRange(buffer, centralOffset, centralSize, "ZIP central directory");
  if (centralOffset + centralSize !== endOffset) fail("central-directory bounds do not meet the end record.");

  const entries = new Map();
  let offset = centralOffset;
  let totalUncompressedBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (readUInt32(buffer, offset, "central-directory signature") !== ZIP_SIGNATURES.centralDirectory) {
      fail(`central-directory entry ${index + 1} has an invalid signature.`);
    }
    const flags = readUInt16(buffer, offset + 8, "ZIP flags");
    const method = readUInt16(buffer, offset + 10, "ZIP compression method");
    const expectedCrc = readUInt32(buffer, offset + 16, "ZIP CRC-32");
    const compressedSize = readUInt32(buffer, offset + 20, "ZIP compressed size");
    const uncompressedSize = readUInt32(buffer, offset + 24, "ZIP uncompressed size");
    const nameLength = readUInt16(buffer, offset + 28, "ZIP entry name length");
    const extraLength = readUInt16(buffer, offset + 30, "ZIP extra-field length");
    const commentLength = readUInt16(buffer, offset + 32, "ZIP entry comment length");
    const diskStart = readUInt16(buffer, offset + 34, "ZIP entry disk");
    const localOffset = readUInt32(buffer, offset + 42, "ZIP local-header offset");
    const recordLength = 46 + nameLength + extraLength + commentLength;
    requireRange(buffer, offset, recordLength, `central-directory entry ${index + 1}`);

    if ((flags & 0x0001) !== 0) fail("encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) fail(`compression method ${method} is not supported.`);
    if (diskStart !== 0) fail("multi-disk ZIP entries are not supported.");
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) fail("ZIP64 entries are not supported.");
    if (uncompressedSize > MAX_ENTRY_BYTES) fail(`an entry exceeds the ${MAX_ENTRY_BYTES}-byte safety limit.`);
    totalUncompressedBytes += uncompressedSize;
    if (totalUncompressedBytes > MAX_TOTAL_UNCOMPRESSED_BYTES) fail(`entries exceed the ${MAX_TOTAL_UNCOMPRESSED_BYTES}-byte safety limit.`);

    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    if (entries.has(name)) fail(`duplicate ZIP entry ${JSON.stringify(name)}.`);
    entries.set(name, {
      name,
      flags,
      method,
      expectedCrc,
      compressedSize,
      uncompressedSize,
      localOffset,
      content: null,
    });
    offset += recordLength;
  }
  if (offset !== centralOffset + centralSize) fail("central-directory entry count does not match its declared size.");

  function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) fail(`required ZIP entry ${JSON.stringify(name)} is missing.`);
    if (entry.content) return entry.content;
    const localOffset = entry.localOffset;
    if (readUInt32(buffer, localOffset, "local-file signature") !== ZIP_SIGNATURES.localFile) fail(`entry ${JSON.stringify(name)} has an invalid local-header signature.`);
    const localFlags = readUInt16(buffer, localOffset + 6, "local ZIP flags");
    const localMethod = readUInt16(buffer, localOffset + 8, "local ZIP compression method");
    const localNameLength = readUInt16(buffer, localOffset + 26, "local ZIP name length");
    const localExtraLength = readUInt16(buffer, localOffset + 28, "local ZIP extra-field length");
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    requireRange(buffer, localOffset, 30 + localNameLength + localExtraLength, `local header for ${JSON.stringify(name)}`);
    requireRange(buffer, dataOffset, entry.compressedSize, `compressed data for ${JSON.stringify(name)}`);
    if (localFlags !== entry.flags || localMethod !== entry.method) fail(`entry ${JSON.stringify(name)} has inconsistent local and central headers.`);
    const localName = decodeZipName(buffer.subarray(localOffset + 30, localOffset + 30 + localNameLength), (localFlags & 0x0800) !== 0);
    if (localName !== name) fail(`entry ${JSON.stringify(name)} has an inconsistent local name.`);

    const compressed = buffer.subarray(dataOffset, dataOffset + entry.compressedSize);
    let content;
    try {
      content = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
    } catch (error) {
      fail(`entry ${JSON.stringify(name)} could not be inflated: ${error.message}`);
    }
    if (content.length !== entry.uncompressedSize) fail(`entry ${JSON.stringify(name)} has an incorrect uncompressed size.`);
    if (crc32(content) !== entry.expectedCrc) fail(`entry ${JSON.stringify(name)} failed CRC-32 verification.`);
    entry.content = content;
    return content;
  }

  return { entries, readEntry };
}

export function decodeXmlEntities(text) {
  return text.replace(/&(#(?:x[0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]*);/g, (entity, body) => {
    if (body === "amp") return "&";
    if (body === "lt") return "<";
    if (body === "gt") return ">";
    if (body === "quot") return "\"";
    if (body === "apos") return "'";
    if (!body.startsWith("#")) fail(`unknown XML entity &${body};.`);
    const codePoint = body[1]?.toLowerCase() === "x" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      fail(`invalid XML character reference &${body};.`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function parseAttributes(source) {
  const attributes = Object.create(null);
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (Object.hasOwn(attributes, name)) fail(`duplicate XML attribute ${JSON.stringify(name)}.`);
    attributes[name] = decodeXmlEntities(match[2] ?? match[3]);
  }
  return attributes;
}

function textElements(xml, localName) {
  const pattern = new RegExp(`<${localName}\\b[^>]*>([\\s\\S]*?)<\\/${localName}>`, "g");
  const values = [];
  let match;
  while ((match = pattern.exec(xml)) !== null) values.push(decodeXmlEntities(match[1]));
  return values;
}

function resolvePackageTarget(sourcePart, target) {
  if (!target || target.includes("\u0000") || target.includes("\\")) fail(`unsafe relationship target ${JSON.stringify(target)}.`);
  const targetWithoutRoot = target.startsWith("/") ? target.slice(1) : path.posix.join(path.posix.dirname(sourcePart), target);
  const normalized = path.posix.normalize(targetWithoutRoot);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    fail(`relationship target escapes the package: ${JSON.stringify(target)}.`);
  }
  return normalized;
}

function parseRelationships(xml, sourcePart) {
  const relationships = new Map();
  const pattern = /<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.Id || !attributes.Target) fail("a workbook relationship is missing Id or Target.");
    if (attributes.TargetMode === "External") fail(`external workbook relationship ${attributes.Id} is not supported.`);
    if (relationships.has(attributes.Id)) fail(`duplicate workbook relationship ${attributes.Id}.`);
    relationships.set(attributes.Id, {
      type: attributes.Type ?? null,
      target: resolvePackageTarget(sourcePart, attributes.Target),
    });
  }
  return relationships;
}

function parseSharedStrings(xml) {
  const strings = [];
  const pattern = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) strings.push(textElements(match[1], "t").join(""));
  return strings;
}

function parseWorkbookSheets(xml, relationships) {
  const sheets = [];
  const names = new Set();
  const pattern = /<sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/sheet>)/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1]);
    const name = attributes.name;
    const relationshipId = attributes["r:id"];
    if (!name || !relationshipId) fail("a workbook sheet is missing name or r:id.");
    if (names.has(name)) fail(`duplicate worksheet name ${JSON.stringify(name)}.`);
    const relationship = relationships.get(relationshipId);
    if (!relationship) fail(`worksheet ${JSON.stringify(name)} references missing relationship ${relationshipId}.`);
    names.add(name);
    sheets.push({ name, relationshipId, path: relationship.target });
  }
  if (sheets.length === 0) fail("workbook contains no worksheets.");
  return sheets;
}

export function columnNameToNumber(name) {
  if (!/^[A-Z]+$/.test(name)) throw new Error(`Invalid XLSX column name: ${name}`);
  let number = 0;
  for (const character of name) number = number * 26 + character.charCodeAt(0) - 64;
  return number;
}

export function columnNumberToName(number) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid XLSX column number: ${number}`);
  let result = "";
  let remaining = number;
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + remaining % 26) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function parseCellReference(reference) {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(reference);
  if (!match) fail(`invalid worksheet cell reference ${JSON.stringify(reference)}.`);
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row)) fail(`worksheet row is not a safe integer in ${reference}.`);
  return { column: columnNameToNumber(match[1]), row };
}

function firstElementText(xml, localName) {
  const match = new RegExp(`<${localName}\\b[^>]*>([\\s\\S]*?)<\\/${localName}>`).exec(xml);
  return match ? decodeXmlEntities(match[1]) : null;
}

function parseWorksheet(xml, sharedStrings, metadata) {
  const cells = new Map();
  let maxRow = 0;
  let maxColumn = 0;
  const pattern = /<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = parseAttributes(match[1]);
    if (!attributes.r) fail("a worksheet cell is missing its reference.");
    const reference = attributes.r.toUpperCase();
    if (cells.has(reference)) fail(`duplicate worksheet cell ${reference}.`);
    const { row, column } = parseCellReference(reference);
    const body = match[2] ?? "";
    const formula = firstElementText(body, "f");
    const type = attributes.t ?? "n";
    const valueText = firstElementText(body, "v");
    let value = null;
    let rawValue = valueText;

    if (type === "inlineStr") {
      value = textElements(body, "t").join("");
      rawValue = value;
    } else if (type === "s") {
      if (valueText === null || !/^(?:0|[1-9][0-9]*)$/.test(valueText.trim())) fail(`shared-string cell ${reference} has an invalid index.`);
      const index = Number(valueText.trim());
      if (index >= sharedStrings.length) fail(`shared-string cell ${reference} references missing string ${index}.`);
      value = sharedStrings[index];
    } else if (type === "b") {
      if (valueText !== "0" && valueText !== "1") fail(`boolean cell ${reference} must contain 0 or 1.`);
      value = valueText === "1";
    } else if (type === "str" || type === "e" || type === "d") {
      value = valueText;
    } else if (type === "n") {
      if (valueText !== null && valueText.trim() !== "") {
        rawValue = valueText.trim();
        value = Number(rawValue);
        if (!Number.isFinite(value)) fail(`numeric cell ${reference} is not finite.`);
      }
    } else {
      fail(`worksheet cell ${reference} uses unsupported type ${JSON.stringify(type)}.`);
    }

    cells.set(reference, Object.freeze({ reference, row, column, type, value, rawValue, formula }));
    maxRow = Math.max(maxRow, row);
    maxColumn = Math.max(maxColumn, column);
  }

  return Object.freeze({
    ...metadata,
    cells,
    maxRow,
    maxColumn,
    getCell(reference) {
      return cells.get(String(reference).toUpperCase()) ?? null;
    },
    getValue(reference) {
      return cells.get(String(reference).toUpperCase())?.value ?? null;
    },
  });
}

export function openXlsx(buffer) {
  const zip = parseZip(buffer);
  const workbookPath = "xl/workbook.xml";
  const relationshipsPath = "xl/_rels/workbook.xml.rels";
  const workbookXml = zip.readEntry(workbookPath).toString("utf8");
  const relationshipsXml = zip.readEntry(relationshipsPath).toString("utf8");
  const relationships = parseRelationships(relationshipsXml, workbookPath);
  const sheetDefinitions = parseWorkbookSheets(workbookXml, relationships);
  const sharedStrings = zip.entries.has("xl/sharedStrings.xml")
    ? parseSharedStrings(zip.readEntry("xl/sharedStrings.xml").toString("utf8"))
    : [];
  const sheetCache = new Map();

  return Object.freeze({
    sheetNames: Object.freeze(sheetDefinitions.map((sheet) => sheet.name)),
    sharedStringCount: sharedStrings.length,
    getSheet(name) {
      const definition = sheetDefinitions.find((sheet) => sheet.name === name);
      if (!definition) throw new Error(`XLSX worksheet not found: ${name}`);
      if (!sheetCache.has(name)) {
        const xml = zip.readEntry(definition.path).toString("utf8");
        sheetCache.set(name, parseWorksheet(xml, sharedStrings, definition));
      }
      return sheetCache.get(name);
    },
  });
}

export async function readXlsx(source) {
  const buffer = Buffer.isBuffer(source) ? source : await readFile(source);
  return openXlsx(buffer);
}

export function worksheetRecords(sheet, options = {}) {
  const headerRow = options.headerRow ?? 1;
  if (!Number.isSafeInteger(headerRow) || headerRow < 1) throw new Error("headerRow must be a positive safe integer.");
  const headers = [];
  const seen = new Set();
  for (let column = 1; column <= sheet.maxColumn; column += 1) {
    const value = sheet.getValue(`${columnNumberToName(column)}${headerRow}`);
    if (value === null || value === "") continue;
    const header = String(value);
    if (seen.has(header)) throw new Error(`Duplicate worksheet header: ${header}`);
    seen.add(header);
    headers.push({ column, header });
  }
  const records = [];
  for (let row = headerRow + 1; row <= sheet.maxRow; row += 1) {
    const record = Object.create(null);
    let hasValue = false;
    for (const { column, header } of headers) {
      const cell = sheet.getCell(`${columnNumberToName(column)}${row}`);
      record[header] = cell?.value ?? null;
      if (cell?.value !== null && cell?.value !== "") hasValue = true;
    }
    if (hasValue) records.push({ rowNumber: row, values: record });
  }
  return { headers: headers.map(({ header }) => header), records };
}
