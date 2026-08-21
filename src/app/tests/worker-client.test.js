import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TASK_TIMEOUT_MS,
  TaskCancelledError,
  TaskClient,
  TaskClientError,
  TaskRemoteError,
} from "../workers/task-client.js";

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

class FakeWorker {
  static instances = [];

  static reset() {
    this.instances.length = 0;
  }

  constructor(url, options) {
    this.url = url;
    this.options = options;
    this.messages = [];
    this.terminated = false;
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    FakeWorker.instances.push(this);
  }

  postMessage(message) {
    this.messages.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  emit(message) {
    this.onmessage?.({ data: message });
  }

  fail(error) {
    this.onerror?.({ error, message: error.message, preventDefault() {} });
  }
}

function taskPayload(value) {
  return {
    kind: "analysis.evaluate",
    payload: {
      evaluator: { kind: "constant", value },
      parameters: {},
    },
  };
}

test("client creates dedicated module Workers, caps concurrency, queues, and recreates", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, workerUrl: "worker.js", maxConcurrency: 2 });
  const first = client.run(taskPayload(1), { taskId: "one" });
  const second = client.run(taskPayload(2), { taskId: "two" });
  const third = client.run(taskPayload(3), { taskId: "three" });

  assert.equal(FakeWorker.instances.length, 2);
  assert.equal(client.activeCount, 2);
  assert.equal(client.queuedCount, 1);
  assert.deepEqual(FakeWorker.instances[0].options, { type: "module" });
  assert.equal(FakeWorker.instances[0].messages[0].taskId, "one");
  assert.equal(FakeWorker.instances[1].messages[0].taskId, "two");

  FakeWorker.instances[0].emit({ type: "result", taskId: "one", result: { value: 1 } });
  assert.deepEqual(await first, { value: 1 });
  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.equal(FakeWorker.instances.length, 3);
  assert.equal(FakeWorker.instances[2].messages[0].taskId, "three");

  FakeWorker.instances[1].emit({ type: "result", taskId: "two", result: { value: 2 } });
  FakeWorker.instances[2].emit({ type: "result", taskId: "three", result: { value: 3 } });
  assert.deepEqual(await Promise.all([second, third]), [{ value: 2 }, { value: 3 }]);
  assert.equal(FakeWorker.instances.every((worker) => worker.terminated), true);
  assert.equal(client.size, 0);
});

test("client reports progress and resolves only validated complete results", async () => {
  FakeWorker.reset();
  const progress = [];
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });
  const handle = client.run("analysis.evaluate", {
    evaluator: { kind: "constant", value: 5 },
    parameters: {},
  }, {
    taskId: "progress-task",
    onProgress: (message) => progress.push(message),
  });
  const worker = FakeWorker.instances[0];
  worker.emit({
    type: "progress",
    taskId: "progress-task",
    phase: "evaluate",
    completed: 1,
    total: 2,
    fraction: 0.5,
    detail: { stage: "half" },
  });
  worker.emit({ type: "result", taskId: "progress-task", result: { answer: 5 } });
  assert.deepEqual(await handle.promise, { answer: 5 });
  assert.equal(progress.length, 1);
  assert.equal(progress[0].detail.stage, "half");
  assert.equal(worker.terminated, true);
});

test("active cancellation terminates immediately and late complete results are ignored", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });
  const handle = client.run(taskPayload(1), { taskId: "cancel-active" });
  const worker = FakeWorker.instances[0];
  const lateHandler = worker.onmessage;

  assert.equal(handle.cancel(), true);
  assert.equal(worker.terminated, true);
  await assert.rejects(handle, (error) => error instanceof TaskCancelledError && error.taskId === "cancel-active");

  lateHandler({ data: { type: "result", taskId: "cancel-active", result: { partial: false } } });
  await tick();
  assert.equal(client.size, 0);
  assert.equal(handle.cancel(), false);
});

test("queued tasks are cancellable without creating a Worker", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });
  const active = client.run(taskPayload(1), { taskId: "active" });
  const queued = client.run(taskPayload(2), { taskId: "queued" });
  assert.equal(FakeWorker.instances.length, 1);
  assert.equal(client.queuedCount, 1);

  assert.equal(client.cancel("queued"), true);
  await assert.rejects(queued, { code: "TASK_CANCELLED", taskId: "queued" });
  assert.equal(FakeWorker.instances.length, 1);
  FakeWorker.instances[0].emit({ type: "result", taskId: "active", result: 1 });
  assert.equal(await active, 1);
});

test("worker errors, protocol violations, and cancelled envelopes reject and terminate", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });

  const remote = client.run(taskPayload(1), { taskId: "remote-error" });
  FakeWorker.instances[0].emit({
    type: "error",
    taskId: "remote-error",
    error: { name: "RangeError", message: "bad range", code: "BAD_RANGE", path: "x" },
  });
  await assert.rejects(remote, (error) => error instanceof TaskRemoteError && error.code === "BAD_RANGE" && error.path === "x");
  assert.equal(FakeWorker.instances[0].terminated, true);

  const invalid = client.run(taskPayload(2), { taskId: "invalid-message" });
  FakeWorker.instances[1].emit({ type: "result", taskId: "other", result: 2 });
  await assert.rejects(invalid, (error) => error instanceof TaskClientError && error.code === "TASK_ID_MISMATCH");
  assert.equal(FakeWorker.instances[1].terminated, true);

  const partial = client.run(taskPayload(3), { taskId: "partial-result" });
  FakeWorker.instances[2].emit({
    type: "result",
    taskId: "partial-result",
    result: { status: "partial", rows: [] },
  });
  await assert.rejects(partial, (error) => error instanceof TaskClientError && error.code === "INVALID_WORKER_MESSAGE");
  assert.equal(FakeWorker.instances[2].terminated, true);

  const cancelled = client.run(taskPayload(4), { taskId: "worker-cancelled" });
  FakeWorker.instances[3].emit({ type: "cancelled", taskId: "worker-cancelled" });
  await assert.rejects(cancelled, { code: "TASK_CANCELLED" });
  assert.equal(FakeWorker.instances[3].terminated, true);
});

test("close rejects queued and active tasks and leaves no indefinite resources", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });
  const active = client.run(taskPayload(1), { taskId: "active-close" });
  const queued = client.run(taskPayload(2), { taskId: "queued-close" });
  client.close();

  await Promise.all([
    assert.rejects(active, { code: "TASK_CANCELLED" }),
    assert.rejects(queued, { code: "TASK_CANCELLED" }),
  ]);
  assert.equal(FakeWorker.instances[0].terminated, true);
  assert.equal(client.size, 0);
  assert.throws(() => client.run(taskPayload(3)), { code: "TASK_CLIENT_CLOSED" });
});

test("AbortSignal cancellation uses the same terminate guarantee", async () => {
  FakeWorker.reset();
  const controller = new AbortController();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1 });
  const handle = client.run(taskPayload(1), { taskId: "abort", signal: controller.signal });
  controller.abort();
  await assert.rejects(handle, { code: "TASK_CANCELLED" });
  assert.equal(FakeWorker.instances[0].terminated, true);
});

test("timeouts default to five minutes and accept only explicit positive integers, 0, or null", () => {
  FakeWorker.reset();
  assert.equal(DEFAULT_TASK_TIMEOUT_MS, 300_000);
  assert.equal(new TaskClient({ Worker: FakeWorker }).timeoutMs, DEFAULT_TASK_TIMEOUT_MS);
  assert.equal(new TaskClient({ Worker: FakeWorker, timeoutMs: 0 }).timeoutMs, null);
  assert.equal(new TaskClient({ Worker: FakeWorker, timeoutMs: null }).timeoutMs, null);

  for (const timeoutMs of [-1, 1.5, "10", false, Number.NaN, 2_147_483_648]) {
    assert.throws(
      () => new TaskClient({ Worker: FakeWorker, timeoutMs }),
      { name: "TypeError" },
    );
  }

  const client = new TaskClient({ Worker: FakeWorker });
  for (const timeoutMs of [-1, 1.5, "10", false]) {
    assert.throws(
      () => client.run(taskPayload(1), { timeoutMs }),
      { name: "TypeError" },
    );
  }
  assert.equal(FakeWorker.instances.length, 0);
});

test("a timed-out task terminates its Worker, releases the slot, and lets the queue continue", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1, timeoutMs: 25 });
  const timedOut = client.run(taskPayload(1), { taskId: "timed-out" });
  const queued = client.run(taskPayload(2), { taskId: "after-timeout", timeoutMs: null });
  const firstWorker = FakeWorker.instances[0];

  await assert.rejects(
    timedOut,
    (error) => error instanceof TaskClientError &&
      error.code === "TASK_TIMEOUT" &&
      error.taskId === "timed-out" &&
      error.details.timeoutMs === 25,
  );
  assert.equal(firstWorker.terminated, true);
  assert.equal(FakeWorker.instances.length, 2);
  assert.equal(FakeWorker.instances[1].messages[0].taskId, "after-timeout");
  assert.equal(client.activeCount, 1);
  assert.equal(client.queuedCount, 0);

  FakeWorker.instances[1].emit({
    type: "result",
    taskId: "after-timeout",
    result: { value: 2 },
  });
  assert.deepEqual(await queued, { value: 2 });
  assert.equal(client.size, 0);
});

test("per-task 0 and null disable an otherwise configured timeout", async () => {
  FakeWorker.reset();
  const client = new TaskClient({ Worker: FakeWorker, maxConcurrency: 1, timeoutMs: 5 });

  const zeroDisabled = client.run(taskPayload(1), { taskId: "zero-disabled", timeoutMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(FakeWorker.instances[0].terminated, false);
  FakeWorker.instances[0].emit({ type: "result", taskId: "zero-disabled", result: 1 });
  assert.equal(await zeroDisabled, 1);

  const nullDisabled = client.run(taskPayload(2), { taskId: "null-disabled", timeoutMs: null });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(FakeWorker.instances[1].terminated, false);
  FakeWorker.instances[1].emit({ type: "result", taskId: "null-disabled", result: 2 });
  assert.equal(await nullDisabled, 2);
});
