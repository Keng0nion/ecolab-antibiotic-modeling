/**
 * Test-only XLSX builder. It writes a real ZIP container (local headers,
 * central directory, end record) so the reader is exercised against the same
 * structures Excel produces, without adding a spreadsheet dependency.
 */
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeU32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

export function columnLetters(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

export function buildXlsx(entries, { deflate = false, flags = 0, methodOverride = null } = {}) {
  const files = [...entries.entries()].map(([name, text]) => {
    const nameBytes = Buffer.from(name, "utf8");
    const raw = Buffer.isBuffer(text) ? text : Buffer.from(text, "utf8");
    const method = methodOverride ?? (deflate ? 8 : 0);
    const payload = method === 8 ? deflateRawSync(raw) : raw;
    return { nameBytes, raw, payload, method, crc: crc32(raw) };
  });
  const localParts = [];
  let localOffset = 0;
  for (const file of files) {
    const header = Buffer.alloc(30);
    writeU32(header, 0, 0x04034b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, flags);
    writeU16(header, 8, file.method);
    writeU32(header, 14, file.crc);
    writeU32(header, 18, file.payload.length);
    writeU32(header, 22, file.raw.length);
    writeU16(header, 26, file.nameBytes.length);
    file.localOffset = localOffset;
    localParts.push(header, file.nameBytes, file.payload);
    localOffset += header.length + file.nameBytes.length + file.payload.length;
  }
  const centralParts = [];
  let centralSize = 0;
  for (const file of files) {
    const header = Buffer.alloc(46);
    writeU32(header, 0, 0x02014b50);
    writeU16(header, 4, 20);
    writeU16(header, 6, 20);
    writeU16(header, 8, flags);
    writeU16(header, 10, file.method);
    writeU32(header, 16, file.crc);
    writeU32(header, 20, file.payload.length);
    writeU32(header, 24, file.raw.length);
    writeU16(header, 28, file.nameBytes.length);
    writeU32(header, 42, file.localOffset);
    centralParts.push(header, file.nameBytes);
    centralSize += header.length + file.nameBytes.length;
  }
  const end = Buffer.alloc(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 8, files.length);
  writeU16(end, 10, files.length);
  writeU32(end, 12, centralSize);
  writeU32(end, 16, localOffset);
  return new Uint8Array(Buffer.concat([...localParts, ...centralParts, end]));
}

export function workbookEntries({ sheetXml, sharedStrings = null, sheetNames = ["Observations"], extraSheets = {} }) {
  const entries = new Map();
  entries.set(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">`
      + `<sheets>${sheetNames.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join("")}</sheets>`
      + `</workbook>`,
  );
  if (sharedStrings) {
    entries.set("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8"?><sst>${sharedStrings.map((value) => `<si><t>${value}</t></si>`).join("")}</sst>`);
  }
  entries.set("xl/worksheets/sheet1.xml", sheetXml);
  let index = 2;
  for (const xml of Object.values(extraSheets)) {
    entries.set(`xl/worksheets/sheet${index}.xml`, xml);
    index += 1;
  }
  return entries;
}
