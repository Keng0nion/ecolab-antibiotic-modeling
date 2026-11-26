import { resolve } from "node:path";
import { APPLICATION_VERSION } from "../app/version.js";
import { loadCatalog } from "./catalog.js";
import { runInfoCommand } from "./info.js";
import {
  cliError,
  createProgressReporter,
  printErrorJson,
  printJson,
} from "./io.js";
import { runQcCommand } from "./qc.js";
import { runReplayCommand } from "./replay.js";
import { runResearchCommand } from "./research.js";
import { DEFAULT_SERVE_PORT, runServeCommand } from "./serve.js";
import { COURSE_PRESET_ACTIONS, runSimulateCommand } from "./simulate.js";
import { runTaskCommand } from "./task.js";

const NO_OPTIONS = Object.freeze({ value: Object.freeze([]), boolean: Object.freeze([]) });

function outputDirectory(options) {
  return options.out === undefined ? null : resolve(process.cwd(), options.out);
}

function timestampOption(value) {
  if (value === undefined) return null;
  if (Number.isNaN(Date.parse(value))) {
    throw cliError("CLI_INVALID_TIMESTAMP", "--created-at must be a valid ISO 8601 timestamp.", { actual: value });
  }
  return value;
}

function portOption(value) {
  if (value === undefined) return DEFAULT_SERVE_PORT;
  const port = Number(value);
  if (!Number.isInteger(port)) {
    throw cliError("CLI_INVALID_PORT", "Port must be an integer from 1 to 65535.", { actual: value });
  }
  return port;
}

function localeOption(value) {
  return value === undefined ? "en" : value;
}

const COMMANDS = Object.freeze([
  {
    name: "info",
    summary: "Print versions, catalog, presets, limits, and the command list as JSON.",
    usage: "ecolab info",
    options: NO_OPTIONS,
    run: async () => runInfoCommand({
      catalog: await loadCatalog(),
      commands: COMMANDS.map(({ name, summary }) => ({ name, summary })),
    }),
  },
  {
    name: "simulate",
    summary: "Run one deterministic simulation from a simulation plan or a Learn-course preset.",
    usage: `ecolab simulate (--plan <file|-> | --preset <${COURSE_PRESET_ACTIONS.join("|")}>) [--out DIR] [--run-id ID] [--created-at ISO]`,
    options: {
      value: Object.freeze(["--plan", "--preset", "--out", "--run-id", "--created-at"]),
      boolean: Object.freeze([]),
    },
    run: async (options) => runSimulateCommand({
      planPath: options.plan ?? null,
      preset: options.preset ?? null,
      outDir: outputDirectory(options),
      runId: options.runId ?? null,
      createdAt: timestampOption(options.createdAt),
      catalog: await loadCatalog(),
      applicationVersion: APPLICATION_VERSION,
    }),
  },
  {
    name: "qc",
    summary: "Import one dataset file, run the strict quality report, and report workflow eligibility.",
    usage: "ecolab qc --dataset <file> [--format auto|json|csv] [--dataset-id ID --title TITLE --license LICENSE] [--locale en|zh-CN] [--out DIR]",
    options: {
      value: Object.freeze(["--dataset", "--format", "--dataset-id", "--title", "--license", "--locale", "--out"]),
      boolean: Object.freeze([]),
    },
    run: async (options) => runQcCommand({
      datasetPath: options.dataset ?? null,
      format: options.format ?? "auto",
      datasetId: options.datasetId ?? null,
      title: options.title ?? null,
      license: options.license ?? null,
      locale: localeOption(options.locale),
      outDir: outputDirectory(options),
      catalog: await loadCatalog(),
    }),
  },
  {
    name: "research",
    summary: "Run the locked Research Workspace workflow on the bundled dataset (development comparison).",
    usage: "ecolab research [--preset small|standard] [--seed N] [--run-id ID] [--created-at ISO] [--locale en|zh-CN] [--out DIR] [--progress]",
    options: {
      value: Object.freeze(["--preset", "--seed", "--run-id", "--created-at", "--locale", "--out"]),
      boolean: Object.freeze(["--progress"]),
    },
    run: async (options) => runResearchCommand({
      preset: options.preset ?? "small",
      seed: options.seed ?? null,
      runId: options.runId ?? null,
      createdAt: timestampOption(options.createdAt),
      locale: localeOption(options.locale),
      outDir: outputDirectory(options),
      reportProgress: createProgressReporter(options.progress === true),
      catalog: await loadCatalog(),
    }),
  },
  {
    name: "replay",
    summary: "Inspect one research package; add --execute for the exact-version built-in replay.",
    usage: "ecolab replay --package <file|-> [--execute] [--progress]",
    options: {
      value: Object.freeze(["--package"]),
      boolean: Object.freeze(["--execute", "--progress"]),
    },
    run: async (options) => runReplayCommand({
      packagePath: options.package ?? null,
      execute: options.execute === true,
      reportProgress: createProgressReporter(options.progress === true),
    }),
  },
  {
    name: "task",
    summary: "Run one raw worker-protocol task ({kind, payload}) and print its result.",
    usage: "ecolab task --task <file|-> [--progress]",
    options: {
      value: Object.freeze(["--task"]),
      boolean: Object.freeze(["--progress"]),
    },
    run: async (options) => runTaskCommand({
      taskPath: options.task ?? null,
      reportProgress: createProgressReporter(options.progress === true),
    }),
  },
  {
    name: "serve",
    summary: "Serve the web application on 127.0.0.1 (dist/web when built, otherwise the source tree).",
    usage: "ecolab serve [--dir PATH] [--port N] [--open]",
    options: {
      value: Object.freeze(["--dir", "--port"]),
      boolean: Object.freeze(["--open"]),
    },
    json: false,
    run: async (options) => runServeCommand({
      dir: options.dir ?? null,
      port: portOption(options.port),
      open: options.open === true,
    }),
  },
]);

function camelOption(name) {
  return name.slice(2).replace(/-([a-z])/gu, (_match, letter) => letter.toUpperCase());
}

function parseOptions(args, spec) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }
    if (!argument.startsWith("--") || argument.length < 3) {
      throw cliError("CLI_UNEXPECTED_ARGUMENT", `Unexpected argument: ${argument}`, { actual: argument });
    }
    const separator = argument.indexOf("=");
    const name = separator === -1 ? argument : argument.slice(0, separator);
    const inlineValue = separator === -1 ? null : argument.slice(separator + 1);
    if (spec.boolean.includes(name)) {
      if (inlineValue !== null) {
        throw cliError("CLI_UNEXPECTED_VALUE", `${name} does not take a value.`, { actual: inlineValue });
      }
      options[camelOption(name)] = true;
      continue;
    }
    if (!spec.value.includes(name)) {
      throw cliError("CLI_UNKNOWN_OPTION", `Unknown option for this command: ${name}`, { actual: name });
    }
    let value = inlineValue;
    if (value === null) {
      const next = args[index + 1];
      if (next === undefined || (next.startsWith("--") && next.length > 2)) {
        throw cliError("CLI_MISSING_OPTION_VALUE", `${name} requires a value.`, { actual: name });
      }
      value = next;
      index += 1;
    }
    if (value === "") {
      throw cliError("CLI_EMPTY_OPTION_VALUE", `${name} requires a non-empty value.`, { actual: name });
    }
    options[camelOption(name)] = value;
  }
  return options;
}

const BEHAVIOR_LINES = Object.freeze([
  'Each command prints exactly one JSON document to stdout with "kind": "ecolab.cli.<command>".',
  "Failures print one JSON error document on stderr and exit with code 1; nothing is repaired silently.",
  '"-" as an input path reads that input from stdin.',
  "--out DIR writes files and lists each one under artifacts with bytes and SHA-256.",
  "--progress streams JSON progress lines on stderr; stdout stays a single document.",
  "All computation is local: no network access, no account, and no browser required.",
]);

function commandHelpText(registered) {
  const optionLines = [
    ...registered.options.value.map((name) => `  ${name} <value>`),
    ...registered.options.boolean.map((name) => `  ${name}`),
    "  --help",
  ];
  return [
    `ecolab ${registered.name}`,
    "",
    registered.summary,
    "",
    "Usage:",
    `  ${registered.usage}`,
    "",
    "Options:",
    ...optionLines,
  ].join("\n");
}

export function helpText(commandName = null) {
  if (commandName !== null) {
    const registered = COMMANDS.find(({ name }) => name === commandName);
    if (registered) return `${commandHelpText(registered)}\n`;
  }
  const width = Math.max(...COMMANDS.map(({ name }) => name.length));
  return [
    `Ecolab terminal front end — application ${APPLICATION_VERSION}`,
    "",
    "Usage:",
    "  ecolab <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map(({ name, summary }) => `  ${name.padEnd(width)}  ${summary}`),
    `  ${"help".padEnd(width)}  Print this help, or "ecolab help <command>" for one command.`,
    "",
    "Behavior:",
    ...BEHAVIOR_LINES.map((line) => `  ${line}`),
    "",
    "Examples:",
    "  ecolab info",
    "  ecolab simulate --preset run-washout --out /tmp/ecolab-sim",
    "  ecolab research --preset small --out /tmp/ecolab-research",
    "  ecolab replay --package /tmp/ecolab-research/research-v2-*.research-package.json",
    "",
  ].join("\n");
}

/** Parse argv, run one command, and return the process exit code. */
export async function runCli(argv) {
  try {
    const [command, ...rest] = argv;
    if (command === undefined || command === "help" || command === "--help" || command === "-h") {
      const requested = command === "help" ? rest[0] ?? null : null;
      if (requested !== null && !COMMANDS.some(({ name }) => name === requested)) {
        throw cliError("CLI_UNKNOWN_COMMAND", `Unknown command: ${requested}.`, { actual: requested });
      }
      process.stdout.write(helpText(requested));
      return 0;
    }
    const registered = COMMANDS.find(({ name }) => name === command);
    if (!registered) {
      throw cliError("CLI_UNKNOWN_COMMAND", `Unknown command: ${command}. Run "ecolab help" for usage.`, { actual: command });
    }
    const options = parseOptions(rest, registered.options);
    if (options.help === true) {
      process.stdout.write(helpText(registered.name));
      return 0;
    }
    const output = await registered.run(options);
    if (registered.json === false) {
      return Number.isInteger(output) ? output : 0;
    }
    printJson(output);
    return 0;
  } catch (error) {
    printErrorJson(error);
    return 1;
  }
}
