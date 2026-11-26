import { dispatchTask } from "../app/workers/analysis-worker.js";
import { assertTask } from "../app/workers/task-protocol.js";
import { CLI_SCHEMA_VERSION, cliError, progressFromArgs, readJsonInput } from "./io.js";

/**
 * Raw task passthrough: the same validated worker protocol the browser app uses,
 * executed in this process. Input is a task object ({kind, payload}) or a run
 * envelope ({type: "run", taskId, task}).
 */
export async function runTaskCommand({ taskPath = null, reportProgress }) {
  if (taskPath === null) throw cliError("CLI_TASK_INPUT", "task requires --task <file|->.");
  const { value, source } = await readJsonInput(taskPath, { label: "task" });
  const task = value !== null && typeof value === "object" && !Array.isArray(value)
    && value.task !== null && typeof value.task === "object"
    ? value.task
    : value;
  assertTask(task);
  const result = await dispatchTask(task, {
    reportProgress: progressFromArgs(reportProgress),
  });
  return {
    kind: "ecolab.cli.task",
    schemaVersion: CLI_SCHEMA_VERSION,
    input: { path: source.path, stdin: source.stdin },
    taskKind: task.kind,
    result,
  };
}
