import test from "node:test";
import assert from "node:assert/strict";
import { captureScrollPositions, restoreScrollPositions } from "../ui-state.js";

function scrollElement(key, { top = 0, left = 0 } = {}) {
  return {
    dataset: key === null ? {} : { scrollKey: key },
    scrollTop: top,
    scrollLeft: left,
  };
}

function rootWith(elements) {
  return {
    querySelectorAll(selector) {
      assert.equal(selector, "[data-scroll-key]");
      return elements;
    },
  };
}

test("captures vertical and horizontal scroll offsets by semantic key", () => {
  const positions = captureScrollPositions(rootWith([
    scrollElement("experiment-panel", { top: 318, left: 0 }),
    scrollElement("trajectory-table", { top: 2, left: 144 }),
  ]));

  assert.deepEqual([...positions], [
    ["experiment-panel", { top: 318, left: 0 }],
    ["trajectory-table", { top: 2, left: 144 }],
  ]);
});

test("restores matching offsets after scroll containers are recreated", () => {
  const positions = captureScrollPositions(rootWith([
    scrollElement("experiment-panel", { top: 240, left: 3 }),
    scrollElement("trajectory-table", { top: 0, left: 190 }),
  ]));
  const recreated = [
    scrollElement("experiment-panel"),
    scrollElement("trajectory-table"),
  ];

  restoreScrollPositions(rootWith(recreated), positions);

  assert.deepEqual(recreated.map(({ scrollTop, scrollLeft }) => [scrollTop, scrollLeft]), [
    [240, 3],
    [0, 190],
  ]);
});

test("ignores removed keys, new keys, and elements without a key", () => {
  const positions = captureScrollPositions(rootWith([
    scrollElement("removed-panel", { top: 99, left: 88 }),
    scrollElement(null, { top: 77, left: 66 }),
  ]));
  const newElement = scrollElement("new-panel", { top: 7, left: 6 });
  const unkeyed = scrollElement(null, { top: 5, left: 4 });

  restoreScrollPositions(rootWith([newElement, unkeyed]), positions);

  assert.deepEqual([newElement.scrollTop, newElement.scrollLeft], [7, 6]);
  assert.deepEqual([unkeyed.scrollTop, unkeyed.scrollLeft], [5, 4]);
});

test("keeps the first captured position when duplicate keys are present", () => {
  const positions = captureScrollPositions(rootWith([
    scrollElement("duplicate", { top: 10, left: 20 }),
    scrollElement("duplicate", { top: 30, left: 40 }),
  ]));

  assert.deepEqual(positions.get("duplicate"), { top: 10, left: 20 });
});

test("normalizes invalid, negative, and nonfinite offsets to zero", () => {
  const positions = captureScrollPositions(rootWith([
    scrollElement("negative", { top: -1, left: -20 }),
    scrollElement("nonfinite", { top: Number.NaN, left: Number.POSITIVE_INFINITY }),
    scrollElement("nonnumeric", { top: "12", left: null }),
  ]));

  assert.deepEqual([...positions.values()], [
    { top: 0, left: 0 },
    { top: 0, left: 0 },
    { top: 0, left: 0 },
  ]);
});

test("invalid roots and position collections are safe no-ops", () => {
  assert.deepEqual([...captureScrollPositions(null)], []);
  const element = scrollElement("panel", { top: 8, left: 9 });
  restoreScrollPositions(rootWith([element]), null);
  restoreScrollPositions(null, new Map([["panel", { top: 1, left: 2 }]]));
  assert.deepEqual([element.scrollTop, element.scrollLeft], [8, 9]);
});
