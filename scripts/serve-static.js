import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const requestedRoot = process.argv[2] ?? ".";
const root = resolve(requestedRoot);
const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice(7) ?? 4173);
const shouldOpenBrowser = process.argv.includes("--open");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Port must be an integer from 1 to 65535.");
}
await access(root);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
]);

function sendError(response, statusCode, message) {
  response.writeHead(statusCode, { "content-type": "text/plain; charset=utf-8" });
  response.end(message);
}

function safePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const relative = decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relative || "index.html");
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;
  return candidate;
}

function openBrowser(url) {
  const platformCommands = {
    darwin: ["open", [url]],
    linux: ["xdg-open", [url]],
    win32: ["cmd", ["/c", "start", "", url]],
  };
  const command = platformCommands[process.platform];
  if (!command) {
    console.log(`Open ${url} in your browser.`);
    return;
  }

  const child = spawn(command[0], command[1], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    console.log(`Could not open a browser automatically. Open ${url} manually.`);
  });
  child.unref();
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendError(response, 405, "Method not allowed");
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  let filename = safePath(url.pathname);
  if (!filename) {
    sendError(response, 400, "Invalid path");
    return;
  }

  try {
    const metadata = await stat(filename);
    if (metadata.isDirectory()) filename = resolve(filename, "index.html");
    const fileMetadata = await stat(filename);
    if (!fileMetadata.isFile()) throw new Error("Not a file");

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-length": fileMetadata.size,
      "content-type": mimeTypes.get(extname(filename)) ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filename).pipe(response);
  } catch {
    sendError(response, 404, "Not found");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use. Stop the other process or choose another port.`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${port}`;
  console.log(`Serving ${root} at ${url}`);
  console.log("Press Ctrl+C to stop Ecolab.");
  if (shouldOpenBrowser) openBrowser(url);
});
