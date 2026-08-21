import {
  assertTask,
  assertWorkerEnvelope,
  createRunMessage,
  serializeError,
} from "./task-protocol.js";

export const DEFAULT_TASK_CONCURRENCY = 2;
export const DEFAULT_TASK_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class TaskCancelledError extends Error {
  constructor(taskId, message = `Task ${taskId} was cancelled.`) {
    super(message);
    this.name = "TaskCancelledError";
    this.code = "TASK_CANCELLED";
    this.taskId = taskId;
  }
}

export class TaskRemoteError extends Error {
  constructor(taskId, serialized) {
    super(serialized.message);
    this.name = serialized.name || "TaskRemoteError";
    this.code = serialized.code ?? "WORKER_TASK_FAILED";
    this.taskId = taskId;
    for (const key of ["path", "offset", "expected", "actual", "details"]) {
      if (Object.hasOwn(serialized, key)) this[key] = serialized[key];
    }
    this.serialized = serialized;
  }
}

export class TaskClientError extends Error {
  constructor(code, message, taskId = null, details = undefined) {
    super(message);
    this.name = "TaskClientError";
    this.code = code;
    this.taskId = taskId;
    if (details !== undefined) this.details = details;
  }
}

class TaskHandle {
  constructor(client, record) {
    this.taskId = record.taskId;
    this.promise = record.promise;
    this.cancel = () => client.cancel(record.taskId);
    Object.freeze(this);
  }

  then(onFulfilled, onRejected) {
    return this.promise.then(onFulfilled, onRejected);
  }

  catch(onRejected) {
    return this.promise.catch(onRejected);
  }

  finally(onFinally) {
    return this.promise.finally(onFinally);
  }
}

function positiveConcurrency(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxConcurrency must be a positive safe integer.");
  }
  return value;
}

function normalizeTimeoutMs(value, label = "timeoutMs") {
  if (value === null || value === 0) return null;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_TIMER_DELAY_MS) {
    throw new TypeError(
      `${label} must be null, 0, or a positive integer no greater than ${MAX_TIMER_DELAY_MS}.`,
    );
  }
  return value;
}

function workerError(taskId, event) {
  const underlying = event?.error ?? event;
  const serialized = serializeError(
    underlying instanceof Error
      ? underlying
      : Object.assign(new Error(event?.message ?? "The Worker failed."), { code: "WORKER_RUNTIME_ERROR" }),
  );
  return new TaskRemoteError(taskId, serialized);
}

function normalizeSubmission(kindOrTask, payloadOrOptions, maybeOptions) {
  if (typeof kindOrTask === "string") {
    return {
      task: { kind: kindOrTask, payload: payloadOrOptions },
      options: maybeOptions ?? {},
    };
  }
  return { task: kindOrTask, options: payloadOrOptions ?? {} };
}

/**
 * Bounded browser task queue. Every active task owns one module Worker, which
 * is terminated after success, failure, protocol violation, or cancellation.
 */
export class TaskClient {
  constructor(options = {}) {
    if (typeof options === "number") options = { maxConcurrency: options };
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("TaskClient options must be an object.");
    }
    this.maxConcurrency = positiveConcurrency(options.maxConcurrency ?? DEFAULT_TASK_CONCURRENCY);
    this.timeoutMs = options.timeoutMs === undefined
      ? DEFAULT_TASK_TIMEOUT_MS
      : normalizeTimeoutMs(options.timeoutMs);
    this.workerUrl = options.workerUrl ?? new URL("./analysis-worker.js", import.meta.url);
    this.WorkerClass = options.Worker ?? options.WorkerClass ?? globalThis.Worker;
    this.workerFactory = options.workerFactory ?? null;
    if (this.workerFactory !== null && typeof this.workerFactory !== "function") {
      throw new TypeError("workerFactory must be a function.");
    }
    if (this.workerFactory === null && typeof this.WorkerClass !== "function") {
      throw new TaskClientError("WORKER_UNAVAILABLE", "Browser Worker support is unavailable.");
    }
    this.queue = [];
    this.active = new Map();
    this.records = new Map();
    this.sequence = 0;
    this.closed = false;
  }

  get activeCount() {
    return this.active.size;
  }

  get queuedCount() {
    return this.queue.length;
  }

  get size() {
    return this.active.size + this.queue.length;
  }

  run(kindOrTask, payloadOrOptions = {}, maybeOptions = {}) {
    if (this.closed) {
      throw new TaskClientError("TASK_CLIENT_CLOSED", "This TaskClient is closed.");
    }
    const { task, options } = normalizeSubmission(kindOrTask, payloadOrOptions, maybeOptions);
    assertTask(task);
    if (options === null || typeof options !== "object" || Array.isArray(options)) {
      throw new TypeError("Task run options must be an object.");
    }
    if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
      throw new TypeError("onProgress must be a function.");
    }
    const timeoutMs = options.timeoutMs === undefined
      ? this.timeoutMs
      : normalizeTimeoutMs(options.timeoutMs, "Task timeoutMs");
    const taskId = options.taskId ?? `task-${++this.sequence}`;
    const envelope = createRunMessage(taskId, task);
    if (this.records.has(taskId)) {
      throw new TaskClientError("DUPLICATE_TASK_ID", `Task ID ${taskId} is already in use.`, taskId);
    }

    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const record = {
      taskId,
      envelope,
      onProgress: options.onProgress,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      worker: null,
      status: "queued",
      settled: false,
      signal: options.signal,
      abortListener: null,
      timeoutMs,
      timeoutTimer: null,
    };
    this.records.set(taskId, record);
    this.queue.push(record);
    const handle = new TaskHandle(this, record);

    if (record.signal !== undefined) {
      if (!record.signal || typeof record.signal.addEventListener !== "function") {
        this.records.delete(taskId);
        this.queue.pop();
        throw new TypeError("signal must be an AbortSignal.");
      }
      record.abortListener = () => this.cancel(taskId);
      record.signal.addEventListener("abort", record.abortListener, { once: true });
      if (record.signal.aborted) this.cancel(taskId);
    }

    this.#pump();
    return handle;
  }

  runTask(kindOrTask, payloadOrOptions = {}, maybeOptions = {}) {
    return this.run(kindOrTask, payloadOrOptions, maybeOptions);
  }

  enqueue(kindOrTask, payloadOrOptions = {}, maybeOptions = {}) {
    return this.run(kindOrTask, payloadOrOptions, maybeOptions);
  }

  submit(kindOrTask, payloadOrOptions = {}, maybeOptions = {}) {
    return this.run(kindOrTask, payloadOrOptions, maybeOptions);
  }

  cancelTask(taskId) {
    return this.cancel(taskId);
  }

  cancel(taskId) {
    const record = this.records.get(taskId);
    if (!record || record.settled) return false;
    if (record.status === "queued") {
      const index = this.queue.indexOf(record);
      if (index >= 0) this.queue.splice(index, 1);
    }
    this.#finalize(record, "cancelled", new TaskCancelledError(taskId));
    this.#pump();
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const record of [...this.queue, ...this.active.values()]) {
      if (!record.settled) this.#finalize(record, "cancelled", new TaskCancelledError(record.taskId));
    }
    this.queue.length = 0;
  }

  dispose() {
    this.close();
  }

  #createWorker(record) {
    if (this.workerFactory) return this.workerFactory(this.workerUrl, { type: "module" }, record.taskId);
    return new this.WorkerClass(this.workerUrl, { type: "module" });
  }

  #pump() {
    while (!this.closed && this.active.size < this.maxConcurrency && this.queue.length > 0) {
      const record = this.queue.shift();
      if (record.settled) continue;
      let worker;
      try {
        worker = this.#createWorker(record);
        if (!worker || typeof worker.postMessage !== "function" || typeof worker.terminate !== "function") {
          throw new TypeError("workerFactory must return a Worker-like object.");
        }
      } catch (error) {
        this.#finalize(
          record,
          "failed",
          new TaskClientError("WORKER_CREATION_FAILED", error.message, record.taskId, serializeError(error)),
        );
        continue;
      }
      record.worker = worker;
      record.status = "running";
      this.active.set(record.taskId, record);
      worker.onmessage = (event) => this.#onMessage(record, event?.data);
      worker.onerror = (event) => {
        event?.preventDefault?.();
        if (!record.settled) this.#finalize(record, "failed", workerError(record.taskId, event));
        this.#pump();
      };
      worker.onmessageerror = (event) => {
        if (!record.settled) {
          this.#finalize(
            record,
            "failed",
            new TaskClientError("WORKER_MESSAGE_ERROR", "The Worker emitted an unreadable message.", record.taskId, serializeError(event)),
          );
        }
        this.#pump();
      };
      if (record.timeoutMs !== null) {
        record.timeoutTimer = setTimeout(() => {
          if (record.settled || record.status !== "running") return;
          this.#finalize(
            record,
            "failed",
            new TaskClientError(
              "TASK_TIMEOUT",
              `Task ${record.taskId} exceeded its ${record.timeoutMs} ms timeout.`,
              record.taskId,
              { timeoutMs: record.timeoutMs },
            ),
          );
          this.#pump();
        }, record.timeoutMs);
      }
      try {
        worker.postMessage(record.envelope);
      } catch (error) {
        this.#finalize(
          record,
          "failed",
          new TaskClientError("WORKER_POST_FAILED", error.message, record.taskId, serializeError(error)),
        );
      }
    }
  }

  #onMessage(record, message) {
    if (record.settled || record.status !== "running") return;
    try {
      assertWorkerEnvelope(message);
      if (message.taskId !== record.taskId) {
        throw new TaskClientError(
          "TASK_ID_MISMATCH",
          `Worker message for ${message.taskId} does not match ${record.taskId}.`,
          record.taskId,
        );
      }
    } catch (error) {
      this.#finalize(
        record,
        "failed",
        error instanceof TaskClientError
          ? error
          : new TaskClientError("INVALID_WORKER_MESSAGE", error.message, record.taskId, serializeError(error)),
      );
      this.#pump();
      return;
    }

    if (message.type === "progress") {
      if (record.onProgress) {
        try {
          record.onProgress(message);
        } catch {
          // UI callback failures must not orphan or change the scientific task.
        }
      }
      return;
    }
    if (message.type === "result") this.#finalize(record, "completed", message.result);
    else if (message.type === "error") this.#finalize(record, "failed", new TaskRemoteError(record.taskId, message.error));
    else this.#finalize(record, "cancelled", new TaskCancelledError(record.taskId));
    this.#pump();
  }

  #finalize(record, status, value) {
    if (record.settled) return false;
    record.settled = true;
    record.status = status;
    this.records.delete(record.taskId);
    this.active.delete(record.taskId);
    if (record.signal && record.abortListener) {
      record.signal.removeEventListener?.("abort", record.abortListener);
    }
    if (record.timeoutTimer !== null) {
      clearTimeout(record.timeoutTimer);
      record.timeoutTimer = null;
    }
    if (record.worker) {
      record.worker.onmessage = null;
      record.worker.onerror = null;
      record.worker.onmessageerror = null;
      try {
        record.worker.terminate();
      } catch {
        // The task is already settled; termination is best-effort at this point.
      }
      record.worker = null;
    }
    if (status === "completed") record.resolve(value);
    else record.reject(value);
    return true;
  }
}

export function createTaskClient(options = {}) {
  return new TaskClient(options);
}

export const BrowserTaskClient = TaskClient;
