import test from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { rowsToCsv, xlsxToCsv } from "../research/xlsx-import.js";
import { buildXlsx, columnLetters, workbookEntries } from "./xlsx-fixture.js";

const SHEET = `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>`
  + `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>`
  + `<row r="2"><c r="A2"><v>0.5</v></c><c r="C2" t="inlineStr"><is><t>inline</t></is></c></row>`
  + `<row r="3"><c r="A3" t="s"><v>2</v></c><c r="B3"><v>0.125</v></c></row>`
  + `</sheetData></worksheet>`;

function standardWorkbook(options = {}) {
  return workbookEntries({
    sheetXml: SHEET,
    sharedStrings: ["time_hours", "od600", "A &amp; B"],
    sheetNames: ["Observations", "Ignored"],
    extraSheets: { ignored: `<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1"><v>999</v></c></row></sheetData></worksheet>` },
    ...options,
  });
}

function firstCentralEntryOffset(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) return offset;
  }
  return -1;
}

test("xlsxToCsv converts shared strings, inline strings, numbers, entities and sparse cells", async () => {
  const converted = await xlsxToCsv(buildXlsx(standardWorkbook()), { inflateRaw: null });
  assert.equal(converted.csv, [
    "time_hours,od600,",
    "0.5,,inline",
    "A & B,0.125,",
  ].join("\r\n"));
  assert.equal(converted.worksheetName, "Observations");
  assert.equal(converted.worksheetCount, 2);
  assert.equal(converted.rowCount, 3);
  assert.equal(converted.columnCount, 3);
});

test("rows are padded to a rectangle so the strict CSV importer sees one column count", async () => {
  const cells = `<c r="A1" t="inlineStr"><is><t>a</t></is></c><c r="${columnLetters(26)}3"><v>1</v></c>`;
  const converted = await xlsxToCsv(buildXlsx(workbookEntries({
    sheetXml: `<worksheet><sheetData><row r="1">${cells}</row><row r="2"><c r="A2"><v>2</v></c></row></sheetData></worksheet>`,
  })), { inflateRaw: null });
  const rows = converted.csv.split("\r\n");
  assert.equal(converted.columnCount, 27);
  assert.ok(rows.every((row) => row.split(",").length === 27));
  assert.match(rows[0], /^a,{26}$/u);
  assert.match(rows[1], /^2,{26}$/u);
});

test("deflated entries inflate to the same CSV as stored entries", async () => {
  const stored = await xlsxToCsv(buildXlsx(standardWorkbook()), { inflateRaw: null });
  const deflated = await xlsxToCsv(buildXlsx(standardWorkbook(), { deflate: true }), { inflateRaw: inflateRawSync });
  assert.deepEqual(deflated, stored);
});

test("the default inflater handles deflated workbooks without injection", async () => {
  const converted = await xlsxToCsv(buildXlsx(standardWorkbook(), { deflate: true }));
  assert.match(converted.csv, /^time_hours,od600,/u);
});

test("rowsToCsv quotes separators, quotes and newlines", () => {
  assert.equal(rowsToCsv([["a,b", 'say "hi"', "line\nbreak"]]), '"a,b","say ""hi""","line\nbreak"');
});

test("non-ZIP input is rejected with a stable code", async () => {
  await assert.rejects(xlsxToCsv(new Uint8Array([1, 2, 3, 4])), (error) => error.code === "XLSX_NOT_ZIP");
});

test("encrypted workbooks are rejected", async () => {
  const bytes = buildXlsx(standardWorkbook(), { flags: 0x0001 });
  await assert.rejects(xlsxToCsv(bytes, { inflateRaw: null }), (error) => error.code === "XLSX_ENCRYPTED");
});

test("unsupported compression methods are rejected", async () => {
  const bytes = buildXlsx(standardWorkbook(), { methodOverride: 12 });
  await assert.rejects(xlsxToCsv(bytes, { inflateRaw: null }), (error) => error.code === "XLSX_COMPRESSION");
});

test("unsafe entry names are rejected", async () => {
  const entries = standardWorkbook();
  entries.set("../evil.xml", "<x/>");
  await assert.rejects(xlsxToCsv(buildXlsx(entries), { inflateRaw: null }), (error) => error.code === "XLSX_UNSAFE_PATH");
});

test("ZIP64 markers are rejected instead of being misread", async () => {
  const bytes = buildXlsx(standardWorkbook());
  const patched = Uint8Array.from(bytes);
  new DataView(patched.buffer).setUint16(patched.length - 22 + 10, 0xffff, true);
  await assert.rejects(xlsxToCsv(patched, { inflateRaw: null }), (error) => error.code === "XLSX_ZIP64");
});

test("worksheets wider than the import grid are rejected", async () => {
  const cells = Array.from({ length: 257 }, (_, index) => `<c r="${columnLetters(index)}1"><v>${index}</v></c>`).join("");
  const bytes = buildXlsx(workbookEntries({ sheetXml: `<worksheet><sheetData><row r="1">${cells}</row></sheetData></worksheet>` }));
  await assert.rejects(xlsxToCsv(bytes, { inflateRaw: null }), (error) => error.code === "XLSX_TOO_WIDE");
});

test("workbooks without a worksheet are rejected", async () => {
  const entries = new Map([["xl/workbook.xml", "<workbook><sheets/></workbook>"]]);
  await assert.rejects(xlsxToCsv(buildXlsx(entries), { inflateRaw: null }), (error) => error.code === "XLSX_NO_WORKSHEET");
});

test("an empty worksheet is rejected", async () => {
  const bytes = buildXlsx(workbookEntries({ sheetXml: "<worksheet><sheetData></sheetData></worksheet>" }));
  await assert.rejects(xlsxToCsv(bytes, { inflateRaw: null }), (error) => error.code === "XLSX_EMPTY");
});

test("a deflated entry whose declared size disagrees with its payload is rejected", async () => {
  const bytes = buildXlsx(standardWorkbook(), { deflate: true });
  const patched = Uint8Array.from(bytes);
  const central = firstCentralEntryOffset(patched);
  assert.ok(central > 0);
  // Claim one compressed byte while the payload is longer: the inflated length
  // then cannot match the declared uncompressed size.
  new DataView(patched.buffer).setUint32(central + 20, 1, true);
  await assert.rejects(
    xlsxToCsv(patched, { inflateRaw: inflateRawSync }),
    (error) => ["XLSX_CORRUPT", "XLSX_TRUNCATED"].includes(error.code),
  );
});
