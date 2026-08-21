import test from "node:test";
import assert from "node:assert/strict";
import {
  RNG_ALGORITHM,
  createRandom,
  createSubstream,
  deriveSeed,
} from "../random.js";

test("xoshiro128ss-splitmix32-v1 has a locked uint32 golden sequence", () => {
  const random = createRandom(0);
  assert.equal(RNG_ALGORITHM, "xoshiro128ss-splitmix32-v1");
  assert.deepEqual(
    Array.from({ length: 8 }, () => random.nextUint32()),
    [
      1789933344,
      44971166,
      2521387044,
      3848737593,
      1138324114,
      749234105,
      1899511038,
      1995189375,
    ],
  );
  assert.equal(deriveSeed(123, "sample", 7, "x"), 4286573223);
});

test("same seed repeats exactly and different seeds differ", () => {
  const first = createRandom(4);
  const second = createRandom(4);
  const third = createRandom(5);
  const a = Array.from({ length: 20 }, () => first.nextUint32());
  const b = Array.from({ length: 20 }, () => second.nextUint32());
  const c = Array.from({ length: 20 }, () => third.nextUint32());
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("indexed substreams are invariant to chunking and processing order", () => {
  const direct = Array.from({ length: 30 }, (_, index) =>
    createSubstream(99, "sample", index, "parameter-a").nextUint32(),
  );
  const order = [11, 4, 29, 0, 13, 2, 23, 8, 7, 19, 5, 16, 1, 3, 27, 6, 9, 10, 12, 14, 15, 17, 18, 20, 21, 22, 24, 25, 26, 28];
  const reordered = new Array(30);
  for (const index of order) {
    reordered[index] = createSubstream(99, "sample", index, "parameter-a").nextUint32();
  }
  const chunked = [];
  for (let start = 0; start < 30; start += 7) {
    for (let index = start; index < Math.min(30, start + 7); index += 1) {
      chunked[index] = createSubstream(99, "sample", index, "parameter-a").nextUint32();
    }
  }
  assert.deepEqual(reordered, direct);
  assert.deepEqual(chunked, direct);
});
