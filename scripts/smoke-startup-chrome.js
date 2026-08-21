import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const serverPort = 4175;
const driverPort = 9224;
const chromePath = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profilePath = "/tmp/ecolab-startup-smoke-chrome";
const server = spawn(process.execPath, ["scripts/serve-static.js", "dist/web", `--port=${serverPort}`], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
const chrome = spawn(chromePath, [
  "--headless=new",
  "--disable-gpu",
  "--no-first-run",
  "--disable-background-networking",
  `--remote-debugging-port=${driverPort}`,
  `--user-data-dir=${profilePath}`,
  "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForResponse(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function waitForJson(url, timeoutMilliseconds) {
  return (await waitForResponse(url, timeoutMilliseconds)).json();
}

async function connect() {
  const targets = await waitForJson(`http://127.0.0.1:${driverPort}/json/list`, 10_000);
  const target = targets.find((candidate) => candidate.type === "page");
  if (!target) throw new Error("Chrome DevTools did not expose a page target.");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await Promise.all([send("Page.enable"), send("Runtime.enable"), send("Network.enable")]);
  return { socket, send };
}

async function evaluate(send, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function waitForApplication(send, timeoutMilliseconds = 10_000) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    const state = await evaluate(send, `JSON.stringify({
      loaded: Boolean(document.querySelector('[data-linked-charts]')),
      fatal: Boolean(document.querySelector('.fatal-screen')),
      memoryWarning: Boolean(document.querySelector('.memory-banner')),
      title: document.title
    })`);
    const parsed = JSON.parse(state);
    if (parsed.loaded || parsed.fatal) return parsed;
    await delay(100);
  }
  throw new Error("Application remained on the loading screen.");
}

try {
  await waitForResponse(`http://127.0.0.1:${serverPort}/index.html`, 10_000);
  const { socket, send } = await connect();
  const appBaseUrl = `http://127.0.0.1:${serverPort}/index.html`;

  await send("Page.navigate", { url: `${appBaseUrl}#/learn` });
  const normal = await waitForApplication(send);
  if (!normal.loaded || normal.fatal) throw new Error("Normal startup failed.");

  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: null });`,
  });
  await send("Page.navigate", { url: `${appBaseUrl}?storage=disabled#/learn` });
  const withoutStorage = await waitForApplication(send);
  if (!withoutStorage.loaded || withoutStorage.fatal || !withoutStorage.memoryWarning) {
    throw new Error("Startup did not degrade safely when IndexedDB was unavailable.");
  }

  await send("Network.setBlockedURLs", { urls: ["*src/app/main.js*"] });
  await send("Page.navigate", { url: `${appBaseUrl}?main=blocked#/learn` });
  await delay(16_000);
  const watchdog = JSON.parse(await evaluate(send, `JSON.stringify({
    fatal: Boolean(document.querySelector('.fatal-screen')),
    reload: Boolean(document.querySelector('[data-boot-reload]')),
    text: document.querySelector('#app')?.textContent || ''
  })`));
  if (!watchdog.fatal || !watchdog.reload || !watchdog.text.includes("Startup is taking too long")) {
    throw new Error("Boot watchdog did not replace a permanently pending startup.");
  }

  console.log(JSON.stringify({ normal, withoutStorage, watchdog: { fatal: watchdog.fatal, reload: watchdog.reload } }, null, 2));
  console.log("Chrome startup smoke test passed.");
  socket.close();
} finally {
  server.kill("SIGTERM");
  chrome.kill("SIGTERM");
  await rm(profilePath, { recursive: true, force: true });
}
