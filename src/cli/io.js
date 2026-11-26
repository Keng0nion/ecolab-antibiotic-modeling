import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { serializeError } from "../app/workers/task-protocol.js";

export const CLI_SCHEMA_VERSION = "1.0.0";

export function cliError(code, message, details = {}) {
  const error = new Error(message);
  error.name = "EcolabCliError";
  error.code = code;
  if (typeof details.path === "string") error.path = details.path;
  if (details.expected !== undefined) error.expected = details.expected;
  if (details.actual !== undefined) error.actual = details.actual;
  return error;
}

/** Read UTF-8 text from a path, or from stdin when the path is "-". */
export async function readTextInput(pathOrDash, { label = "input file" } = {}) {
  if (pathOrDash === "-") {
    return { text: await readStdin(), path: null, stdin: true };
  }
  if (typeof pathOrDash !== "string" || pathOrDash.length === 0) {
    throw cliError("CLI_MISSING_INPUT", `${label} path is required.`);
  }
  const absolute = isAbsolute(pathOrDash) ? pathOrDash : resolve(process.cwd(), pathOrDash);
  try {
    return { text: await readFile(absolute, "utf8"), path: absolute, stdin: false };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw cliError("CLI_INPUT_NOT_FOUND", `${label} not found: ${absolute}`, { path: absolute });
    }
    if (error?.code === "EISDIR") {
      throw cliError("CLI_INPUT_NOT_FILE", `${label} must be a file: ${absolute}`, { path: absolute });
    }
    throw error;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read and parse JSON text from a path or stdin. */
export async function readJsonInput(pathOrDash, { label = "JSON input" } = {}) {
  const source = await readTextInput(pathOrDash, { label });
  let value;
  try {
    value = JSON.parse(source.text);
  } catch (error) {
    throw cliError("CLI_INVALID_JSON", `${label} must be valid JSON: ${error.message}`, { path: source.path });
  }
  return { value, source };
}

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Write one artifact file and return its JSON-safe inventory entry. */
export async function writeArtifact(role, path, text) {
  if (typeof text !== "string") {
    throw cliError("CLI_INVALID_ARTIFACT", `Artifact content for ${role} must be text.`);
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return Object.freeze({
    role,
    path,
    bytes: Buffer.byteLength(text, "utf8"),
    sha256: sha256Text(text),
  });
}

/** The single JSON result document of a successful command. */
export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** One structured CLI failure on stderr; the caller exits with code 1. */
export function printErrorJson(error) {
  const document = {
    kind: "ecolab.cli.error",
    schemaVersion: CLI_SCHEMA_VERSION,
    error: serializeError(error),
  };
  process.stderr.write(`${JSON.stringify(document, null, 2)}\n`);
}

function progressEvent(phase, completed, total, detail) {
  const event = { kind: "ecolab.cli.progress", schemaVersion: CLI_SCHEMA_VERSION, phase };
  if (Number.isFinite(completed)) event.completed = completed;
  if (Number.isFinite(total)) event.total = total;
  if (Number.isFinite(completed) && Number.isFinite(total) && total > 0) {
    event.fraction = completed / total;
  }
  if (detail !== undefined && Object.keys(detail).length > 0) event.detail = detail;
  return event;
}

/** Progress goes to stderr as one JSON line per event so stdout stays a single document. */
export function createProgressReporter(enabled) {
  if (!enabled) return () => {};
  return (event) => {
    let line;
    try {
      line = JSON.stringify(event);
    } catch {
      line = JSON.stringify({
        kind: "ecolab.cli.progress",
        schemaVersion: CLI_SCHEMA_VERSION,
        phase: String(event?.phase ?? "unknown"),
        note: "Progress detail was not JSON-serializable and was omitted.",
      });
    }
    process.stderr.write(`${line}\n`);
  };
}

/** Adapt workflow progress entries ({phase, completed, total, ...detail}) for the reporter. */
export function progressFromEntry(report) {
  return (entry) => {
    if (!entry || typeof entry !== "object") return;
    const { phase, completed, total, ...detail } = entry;
    report(progressEvent(phase, completed, total, detail));
  };
}

/** Adapt dispatchTask reporters (phase, completed, total, detail) for the reporter. */
export function progressFromArgs(report) {
  return (phase, completed, total, detail) => {
    report(progressEvent(phase, completed, total, detail));
  };
}

export function safeFileStem(value) {
  const stem = String(value).replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^[-.]+|[-.]+$/gu, "");
  return stem === "" ? "ecolab-run" : stem;
}
