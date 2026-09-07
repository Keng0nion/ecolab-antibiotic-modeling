import test from "node:test";
import assert from "node:assert/strict";
import {
  TASK_KINDS,
  TaskProtocolError,
  assertRunEnvelope,
  assertWorkerEnvelope,
  createCancelledMessage,
  createErrorMessage,
  createProgressMessage,
  createResultMessage,
  createRunMessage,
  serializeError,
} from "../workers/task-protocol.js";

const expectedKinds = [
  "dataset.parse",
  "dataset.quality-check",
  "analysis.parameter-scan",
  "analysis.monte-carlo",
  "analysis.sensitivity-local",
  "analysis.sensitivity-morris",
  "analysis.sensitivity-sobol",
  "analysis.fit",
  "analysis.evaluate",
  "analysis.research-workflow",
  "research.package-inspect",
  "research.package-replay",
];

test("worker protocol exposes the exact Stage 4 task kinds and deterministic envelopes", () => {
  assert.deepEqual(TASK_KINDS, expectedKinds);
  assert.deepEqual(
    createRunMessage("task-1", { kind: "analysis.evaluate", payload: { parameters: { x: 2 } } }),
    {
      type: "run",
      taskId: "task-1",
      task: { kind: "analysis.evaluate", payload: { parameters: { x: 2 } } },
    },
  );
  assert.deepEqual(
    createProgressMessage("task-1", "evaluate", 1, 4, 0.25, { series: "a" }),
    {
      type: "progress",
      taskId: "task-1",
      phase: "evaluate",
      completed: 1,
      total: 4,
      fraction: 0.25,
      detail: { series: "a" },
    },
  );
  assert.deepEqual(createResultMessage("task-1", { answer: 4 }), {
    type: "result",
    taskId: "task-1",
    result: { answer: 4 },
  });
  assert.deepEqual(createCancelledMessage("task-1"), { type: "cancelled", taskId: "task-1" });
});

test("run and worker envelopes are strict and JSON-safe", () => {
  assert.throws(
    () => assertRunEnvelope({
      type: "run",
      taskId: "task-1",
      task: { kind: "analysis.evaluate", payload: {} },
      extra: true,
    }),
    { code: "INVALID_ENVELOPE_KEYS" },
  );
  assert.throws(
    () => assertRunEnvelope({
      type: "run",
      taskId: "task-1",
      task: { kind: "analysis.unknown", payload: {} },
    }),
    { code: "UNSUPPORTED_TASK_KIND" },
  );
  assert.throws(
    () => assertRunEnvelope({
      type: "run",
      taskId: "task-1",
      task: { kind: "analysis.evaluate", payload: { evaluator: () => 1 } },
    }),
    { code: "NON_JSON_VALUE" },
  );
  assert.throws(
    () => assertWorkerEnvelope({
      type: "progress",
      taskId: "task-1",
      phase: "evaluate",
      completed: 1,
      total: 2,
      fraction: 0.75,
    }),
    { code: "INCONSISTENT_PROGRESS_FRACTION" },
  );
  assert.throws(
    () => assertWorkerEnvelope({ type: "result", taskId: "task-1", result: Number.NaN }),
    { code: "NON_JSON_NUMBER" },
  );
  assert.throws(
    () => assertWorkerEnvelope({
      type: "result",
      taskId: "task-1",
      result: { status: "partial", rows: [] },
    }),
    { code: "INCOMPLETE_TASK_RESULT" },
  );
  assert.throws(
    () => assertWorkerEnvelope({
      type: "error",
      taskId: "task-1",
      error: { name: "Error", message: "bad", stack: "not allowed" },
    }),
    { code: "INVALID_ENVELOPE_KEYS" },
  );
});

test("serialized errors omit stacks and normalize non-JSON details", () => {
  const error = Object.assign(new Error("broken"), {
    code: "BROKEN",
    path: "payload.x",
    offset: 7,
    expected: { finite: true },
    actual: Number.POSITIVE_INFINITY,
    details: { callback: () => 1, nested: { value: 2 } },
  });
  error.stack = "secret stack";
  const serialized = serializeError(error);
  assert.deepEqual(serialized, {
    name: "Error",
    message: "broken",
    code: "BROKEN",
    path: "payload.x",
    offset: 7,
    expected: { finite: true },
    actual: "Infinity",
    details: { callback: "() => 1", nested: { value: 2 } },
  });
  assert.equal(Object.hasOwn(serialized, "stack"), false);
  assert.doesNotThrow(() => JSON.stringify(serialized));
  assert.deepEqual(createErrorMessage("task-1", error), {
    type: "error",
    taskId: "task-1",
    error: serialized,
  });
});

test("protocol rejects cycles, sparse arrays, unsafe keys, and invalid task IDs", () => {
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => createRunMessage("task-1", { kind: "analysis.evaluate", payload: cyclic }),
    { code: "CYCLIC_VALUE" },
  );
  const sparse = [];
  sparse[1] = 1;
  assert.throws(
    () => createResultMessage("task-1", sparse),
    { code: "SPARSE_ARRAY" },
  );
  const unsafe = Object.create(null);
  Object.defineProperty(unsafe, "__proto__", { value: 1, enumerable: true });
  assert.throws(
    () => createResultMessage("task-1", unsafe),
    { code: "UNSAFE_OBJECT_KEY" },
  );
  assert.throws(
    () => createCancelledMessage(" task-1 "),
    (error) => error instanceof TaskProtocolError && error.code === "INVALID_TASK_ID",
  );
});
