const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const TASK_KINDS = Object.freeze([
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
]);

export const TASK_KIND_SET = new Set(TASK_KINDS);
export const TASK_MESSAGE_TYPES = Object.freeze([
  "run",
  "progress",
  "result",
  "error",
  "cancelled",
]);

export class TaskProtocolError extends TypeError {
  constructor(code, message, path = null, actual = undefined) {
    super(message);
    this.name = "TaskProtocolError";
    this.code = code;
    this.path = path;
    this.actual = actual;
  }
}

function fail(code, message, path, actual) {
  throw new TaskProtocolError(code, message, path, actual);
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertRecord(value, path) {
  if (!isPlainObject(value)) {
    fail("INVALID_ENVELOPE_OBJECT", `${path} must be a plain object.`, path, value);
  }
  return value;
}

function assertExactKeys(value, required, optional, path) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    fail(
      "INVALID_ENVELOPE_KEYS",
      `${path} has invalid keys.`,
      path,
      { missing, unknown },
    );
  }
}

function assertTaskId(taskId, path = "taskId") {
  if (typeof taskId !== "string" || taskId.length === 0 || taskId !== taskId.trim()) {
    fail("INVALID_TASK_ID", `${path} must be a non-empty string without surrounding whitespace.`, path, taskId);
  }
  return taskId;
}

function assertType(value, expected, path = "type") {
  if (value !== expected) {
    fail("INVALID_MESSAGE_TYPE", `${path} must be ${expected}.`, path, value);
  }
}

/** Assert that a value is deterministic JSON data: finite numbers, arrays, and plain objects only. */
export function assertJsonSafe(value, path = "$", stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("NON_JSON_NUMBER", `${path} must be finite.`, path, value);
    return value;
  }
  if (typeof value !== "object") {
    fail("NON_JSON_VALUE", `${path} must be JSON-safe.`, path, typeof value);
  }
  if (stack.has(value)) fail("CYCLIC_VALUE", `${path} cannot contain a cycle.`, path);
  stack.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) fail("SPARSE_ARRAY", `${path} cannot be sparse.`, path, index);
      assertJsonSafe(value[index], `${path}[${index}]`, stack);
    }
  } else {
    if (!isPlainObject(value)) {
      fail("NON_JSON_OBJECT", `${path} must contain only plain objects.`, path, value);
    }
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) fail("UNSAFE_OBJECT_KEY", `${path}.${key} is unsafe.`, `${path}.${key}`, key);
      assertJsonSafe(value[key], `${path}.${key}`, stack);
    }
  }
  stack.delete(value);
  return value;
}

export function assertTask(task, path = "task") {
  assertRecord(task, path);
  assertExactKeys(task, ["kind", "payload"], [], path);
  if (!TASK_KIND_SET.has(task.kind)) {
    fail("UNSUPPORTED_TASK_KIND", `${path}.kind is unsupported.`, `${path}.kind`, task.kind);
  }
  assertJsonSafe(task.payload, `${path}.payload`);
  return task;
}

export function assertRunEnvelope(message) {
  assertRecord(message, "message");
  assertExactKeys(message, ["type", "taskId", "task"], [], "message");
  assertType(message.type, "run");
  assertTaskId(message.taskId);
  assertTask(message.task);
  return message;
}

function assertCount(value, path, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    fail("INVALID_PROGRESS_COUNT", `${path} must be a ${positive ? "positive" : "non-negative"} safe integer.`, path, value);
  }
  return value;
}

export function assertProgressEnvelope(message) {
  assertRecord(message, "message");
  assertExactKeys(
    message,
    ["type", "taskId", "phase", "completed", "total", "fraction"],
    ["detail"],
    "message",
  );
  assertType(message.type, "progress");
  assertTaskId(message.taskId);
  if (typeof message.phase !== "string" || message.phase.length === 0 || message.phase !== message.phase.trim()) {
    fail("INVALID_PROGRESS_PHASE", "phase must be a non-empty string without surrounding whitespace.", "phase", message.phase);
  }
  assertCount(message.completed, "completed");
  assertCount(message.total, "total", { positive: true });
  if (message.completed > message.total) {
    fail("INVALID_PROGRESS_RANGE", "completed cannot exceed total.", "completed", message.completed);
  }
  if (typeof message.fraction !== "number" || !Number.isFinite(message.fraction) || message.fraction < 0 || message.fraction > 1) {
    fail("INVALID_PROGRESS_FRACTION", "fraction must be finite and within [0, 1].", "fraction", message.fraction);
  }
  const expected = message.completed / message.total;
  if (Math.abs(message.fraction - expected) > Number.EPSILON * Math.max(4, message.total)) {
    fail(
      "INCONSISTENT_PROGRESS_FRACTION",
      "fraction must equal completed / total.",
      "fraction",
      { actual: message.fraction, expected },
    );
  }
  if (Object.hasOwn(message, "detail")) assertJsonSafe(message.detail, "detail");
  return message;
}

function isIncompleteResult(result) {
  if (!isPlainObject(result)) return false;
  const status = typeof result.status === "string" ? result.status.toLowerCase() : null;
  return result.partial === true
    || result.cancelled === true
    || result.complete === false
    || status === "partial"
    || status === "cancelled"
    || status === "incomplete";
}

export function assertResultEnvelope(message) {
  assertRecord(message, "message");
  assertExactKeys(message, ["type", "taskId", "result"], [], "message");
  assertType(message.type, "result");
  assertTaskId(message.taskId);
  assertJsonSafe(message.result, "result");
  if (isIncompleteResult(message.result)) {
    fail(
      "INCOMPLETE_TASK_RESULT",
      "Partial, cancelled, or incomplete task output cannot use a result envelope.",
      "result",
      message.result,
    );
  }
  return message;
}

const ERROR_OPTIONAL_KEYS = Object.freeze([
  "code",
  "path",
  "offset",
  "expected",
  "actual",
  "details",
]);

export function assertSerializedError(value, path = "error") {
  assertRecord(value, path);
  assertExactKeys(value, ["name", "message"], ERROR_OPTIONAL_KEYS, path);
  if (typeof value.name !== "string" || value.name.length === 0) {
    fail("INVALID_SERIALIZED_ERROR", `${path}.name must be a non-empty string.`, `${path}.name`, value.name);
  }
  if (typeof value.message !== "string") {
    fail("INVALID_SERIALIZED_ERROR", `${path}.message must be a string.`, `${path}.message`, value.message);
  }
  if (Object.hasOwn(value, "code") && typeof value.code !== "string") {
    fail("INVALID_SERIALIZED_ERROR", `${path}.code must be a string.`, `${path}.code`, value.code);
  }
  if (Object.hasOwn(value, "path") && value.path !== null && typeof value.path !== "string") {
    fail("INVALID_SERIALIZED_ERROR", `${path}.path must be a string or null.`, `${path}.path`, value.path);
  }
  if (Object.hasOwn(value, "offset") && value.offset !== null && !Number.isSafeInteger(value.offset)) {
    fail("INVALID_SERIALIZED_ERROR", `${path}.offset must be a safe integer or null.`, `${path}.offset`, value.offset);
  }
  for (const key of ["expected", "actual", "details"]) {
    if (Object.hasOwn(value, key)) assertJsonSafe(value[key], `${path}.${key}`);
  }
  return value;
}

export function assertErrorEnvelope(message) {
  assertRecord(message, "message");
  assertExactKeys(message, ["type", "taskId", "error"], [], "message");
  assertType(message.type, "error");
  assertTaskId(message.taskId);
  assertSerializedError(message.error);
  return message;
}

export function assertCancelledEnvelope(message) {
  assertRecord(message, "message");
  assertExactKeys(message, ["type", "taskId"], [], "message");
  assertType(message.type, "cancelled");
  assertTaskId(message.taskId);
  return message;
}

export function assertWorkerEnvelope(message) {
  if (!isPlainObject(message)) {
    fail("INVALID_ENVELOPE_OBJECT", "message must be a plain object.", "message", message);
  }
  switch (message.type) {
    case "progress": return assertProgressEnvelope(message);
    case "result": return assertResultEnvelope(message);
    case "error": return assertErrorEnvelope(message);
    case "cancelled": return assertCancelledEnvelope(message);
    default:
      fail("INVALID_MESSAGE_TYPE", "Worker message type is unsupported.", "type", message.type);
  }
}

function cloneJson(value, path = "$", stack = new Set()) {
  assertJsonSafe(value, path, stack);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((child, index) => cloneJson(child, `${path}[${index}]`));
  const result = {};
  for (const key of Object.keys(value)) result[key] = cloneJson(value[key], `${path}.${key}`);
  return result;
}

function safeErrorValue(value, stack = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function" || value === undefined) {
    return String(value);
  }
  if (stack.has(value)) return "[Circular]";
  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((child) => safeErrorValue(child, stack));
  } else if (value instanceof Date) {
    result = Number.isNaN(value.getTime()) ? "Invalid Date" : value.toISOString();
  } else if (value instanceof Error) {
    result = { name: value.name || "Error", message: String(value.message ?? "") };
  } else {
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (UNSAFE_KEYS.has(key)) continue;
      result[key] = safeErrorValue(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

/** Serialize thrown values without stack traces, functions, cycles, or non-finite JSON numbers. */
export function serializeError(error) {
  const source = error && (typeof error === "object" || typeof error === "function") ? error : null;
  const serialized = {
    name: typeof source?.name === "string" && source.name.length > 0 ? source.name : "Error",
    message: typeof source?.message === "string" ? source.message : String(error),
  };
  if (typeof source?.code === "string") serialized.code = source.code;
  if (source && Object.hasOwn(source, "path") && (source.path === null || typeof source.path === "string")) {
    serialized.path = source.path;
  }
  if (source && Object.hasOwn(source, "offset") && (source.offset === null || Number.isSafeInteger(source.offset))) {
    serialized.offset = source.offset;
  }
  for (const key of ["expected", "actual", "details"]) {
    if (source && Object.hasOwn(source, key) && source[key] !== undefined) {
      serialized[key] = safeErrorValue(source[key]);
    }
  }
  assertSerializedError(serialized);
  return Object.freeze(serialized);
}

export function createRunMessage(taskId, task) {
  assertTaskId(taskId);
  assertTask(task);
  const message = { type: "run", taskId, task: cloneJson(task, "task") };
  assertRunEnvelope(message);
  return message;
}

export function createProgressMessage(taskId, phase, completed, total, fraction, detail = undefined) {
  const message = { type: "progress", taskId, phase, completed, total, fraction };
  if (detail !== undefined) message.detail = cloneJson(detail, "detail");
  assertProgressEnvelope(message);
  return message;
}

export function createResultMessage(taskId, result) {
  assertTaskId(taskId);
  assertJsonSafe(result, "result");
  const message = { type: "result", taskId, result: cloneJson(result, "result") };
  assertResultEnvelope(message);
  return message;
}

export function createErrorMessage(taskId, error) {
  const message = { type: "error", taskId, error: serializeError(error) };
  assertErrorEnvelope(message);
  return message;
}

export function createCancelledMessage(taskId) {
  const message = { type: "cancelled", taskId };
  assertCancelledEnvelope(message);
  return message;
}

export const createRunEnvelope = createRunMessage;
export const createProgressEnvelope = createProgressMessage;
export const createResultEnvelope = createResultMessage;
export const createErrorEnvelope = createErrorMessage;
export const createCancelledEnvelope = createCancelledMessage;
export const serializeTaskError = serializeError;
export const validateRunEnvelope = assertRunEnvelope;
export const validateProgressEnvelope = assertProgressEnvelope;
export const validateResultEnvelope = assertResultEnvelope;
export const validateErrorEnvelope = assertErrorEnvelope;
export const validateCancelledEnvelope = assertCancelledEnvelope;
export const validateWorkerEnvelope = assertWorkerEnvelope;
