import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cliError } from "./io.js";

const repositoryRootPath = fileURLToPath(new URL("../../", import.meta.url));
const serverModuleUrl = new URL("../../scripts/serve-static.js", import.meta.url);
export const DEFAULT_SERVE_PORT = 4173;

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Serve the web application through the repository's own static server module,
 * bound to the loopback address. Without --dir the built application (dist/web)
 * is served when present; otherwise the source tree is served in development
 * mode. The server module is evaluated in this process with a temporary argv,
 * exactly as `node scripts/serve-static.js <dir> --port=<n>` would run it, so
 * there is one server implementation and no subprocess.
 */
export async function runServeCommand({ dir = null, port = DEFAULT_SERVE_PORT, open = false }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw cliError("CLI_INVALID_PORT", "Port must be an integer from 1 to 65535.", { actual: port });
  }
  let target;
  let mode;
  if (dir !== null) {
    target = resolve(process.cwd(), dir);
    mode = "directory";
  } else if (await exists(resolve(repositoryRootPath, "dist/web/index.html"))) {
    target = resolve(repositoryRootPath, "dist/web");
    mode = "build";
  } else {
    target = repositoryRootPath;
    mode = "development";
  }
  if (!await exists(target)) {
    throw cliError("CLI_SERVE_DIRECTORY_MISSING", `Serve directory does not exist: ${target}`, { path: target });
  }
  if (mode === "development") {
    process.stderr.write("dist/web is missing; serving the source tree in development mode. Run \"npm run build\" for the production build.\n");
  }

  const previousArgv = process.argv;
  process.argv = [
    process.execPath,
    serverModuleUrl.pathname,
    target,
    `--port=${port}`,
    ...(open ? ["--open"] : []),
  ];
  try {
    await import(serverModuleUrl.href);
  } finally {
    process.argv = previousArgv;
  }
  // The static server keeps the event loop alive; this process now serves until
  // it is stopped, so there is no JSON document and no further CLI work to do.
  return null;
}
