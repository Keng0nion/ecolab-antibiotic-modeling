import test from "node:test";
import assert from "node:assert/strict";
import { parseCsv } from "../lib/csv.js";

test("parses quoted fields, escaped quotes and CRLF line endings", () => {
  const rows = parseCsv('"a","b"\r\n"1","say ""hi"""\r\n');
  assert.deepEqual(rows, [["a", "b"], ["1", 'say "hi"']]);
});

test("preserves empty fields and drops blank lines", () => {
  const rows = parseCsv("a,,c\n\n1,2,3\n");
  assert.deepEqual(rows, [["a", "", "c"], ["1", "2", "3"]]);
});

test("handles a trailing line without a newline", () => {
  assert.deepEqual(parseCsv("x,y\n1,2"), [["x", "y"], ["1", "2"]]);
});
