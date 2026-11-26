#!/usr/bin/env node
import { runCli } from "../src/cli/main.js";

// A downstream pipe that closes early (for example `ecolab info | head`) must
// end the process quietly instead of crashing with an unhandled EPIPE.
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error?.code === "EPIPE") process.exit(0);
    throw error;
  });
}

process.exitCode = await runCli(process.argv.slice(2));
