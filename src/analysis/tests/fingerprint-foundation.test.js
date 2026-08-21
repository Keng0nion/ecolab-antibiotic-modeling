import test from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  fingerprintJson,
  fingerprintSplit,
  sha256Hex,
  sha256HexFallback,
} from "../fingerprint.js";

test("canonical JSON sorts object keys recursively while preserving arrays", () => {
  const left = { z: 1, a: { y: 2, x: [3, { b: 4, a: 5 }] } };
  const right = { a: { x: [3, { a: 5, b: 4 }], y: 2 }, z: 1 };
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(left), '{"a":{"x":[3,{"a":5,"b":4}],"y":2},"z":1}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("canonical JSON rejects non-JSON values, sparse arrays, cycles, and unsafe keys", () => {
  assert.throws(() => canonicalJson({ value: NaN }), { code: "NON_FINITE_NUMBER" });
  assert.throws(() => canonicalJson({ value: undefined }), { code: "NON_JSON_VALUE" });
  const sparse = [];
  sparse[1] = "value";
  assert.throws(() => canonicalJson(sparse), { code: "SPARSE_ARRAY" });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), { code: "CYCLIC_VALUE" });
  const unsafe = Object.create(null);
  Object.defineProperty(unsafe, "__proto__", { value: 1, enumerable: true });
  assert.throws(() => canonicalJson(unsafe), { code: "UNSAFE_OBJECT_KEY" });
});

test("pure-JS SHA-256 matches standard vectors including UTF-8", () => {
  assert.equal(
    sha256HexFallback(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  assert.equal(
    sha256HexFallback("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(
    sha256HexFallback("你好"),
    "670d9743542cae3ea7ebe36af56bd53648b0a1126162e78d81a32934a711302e",
  );
});

test("async SHA-256 and forced fallback are deterministic and equal", async () => {
  const input = "browser and node compatible";
  const automatic = await sha256Hex(input);
  const fallback = await sha256Hex(input, { forceFallback: true });
  assert.equal(automatic, fallback);
  assert.equal(automatic, sha256HexFallback(input));
});

test("JSON fingerprint is independent of object insertion order", async () => {
  assert.equal(
    await fingerprintJson({ b: 2, a: { d: 4, c: 3 } }),
    await fingerprintJson({ a: { c: 3, d: 4 }, b: 2 }),
  );
});

test("split fingerprint excludes the splitFingerprint field and detects material changes", async () => {
  const split = {
    schemaVersion: "1.0.0",
    kind: "observation-dataset-split",
    sourceDatasetId: "d",
    sourceDatasetFingerprint: "a".repeat(64),
    strategy: "declared_roles_by_independent_unit",
    lockedValidation: true,
    roles: {
      training: { independentUnitIds: ["u1"] },
      development: { independentUnitIds: [] },
      validation: { independentUnitIds: ["u2"] },
    },
  };
  const fingerprint = await fingerprintSplit(split);
  assert.equal(await fingerprintSplit({ ...split, splitFingerprint: "b".repeat(64) }), fingerprint);
  assert.notEqual(
    await fingerprintSplit({ ...split, lockedValidation: false }),
    fingerprint,
  );
});
