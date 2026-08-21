import { spawn } from "node:child_process";

const root = new URL("../", import.meta.url);
const serverPort = 4174;
const driverPort = 56123;
const server = spawn(process.execPath, ["scripts/serve-static.js", "dist/web", `--port=${serverPort}`], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
});
const driver = spawn("/System/Cryptexes/App/usr/bin/safaridriver", ["-p", String(driverPort)], {
  stdio: ["ignore", "pipe", "pipe"],
});

let sessionId = null;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(url, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

async function webdriver(path, body) {
  const response = await fetch(`http://127.0.0.1:${driverPort}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    throw new Error(payload.value?.message ?? `WebDriver request failed with ${response.status}.`);
  }
  return payload.value;
}

async function execute(script) {
  return webdriver(`/session/${sessionId}/execute/sync`, { script, args: [] });
}

try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${serverPort}/index.html`, 10_000),
    waitFor(`http://127.0.0.1:${driverPort}/status`, 10_000),
  ]);
  const session = await webdriver("/session", {
    capabilities: { alwaysMatch: { browserName: "safari" } },
  });
  sessionId = session.sessionId;
  await webdriver(`/session/${sessionId}/url`, {
    url: `http://127.0.0.1:${serverPort}/index.html#/learn`,
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const ready = await execute(
      "return Boolean(document.querySelector('[data-linked-charts]')) && !document.querySelector('.fatal-screen');",
    );
    if (ready) break;
    await delay(200);
  }

  await execute("document.querySelector('[data-action=course-next]').click(); return true;");
  await delay(150);
  await execute("document.querySelector('[data-action=course-apply]').click(); return true;");
  await delay(250);
  const beforeLanguageSwitch = await execute(`
    return {
      title: document.title,
      language: document.documentElement.lang,
      chartPanels: document.querySelectorAll('[data-chart-panel]').length,
      tableRows: document.querySelectorAll('.data-table-section tbody tr').length,
      currentTimeText: document.querySelector('.metric-pair')?.textContent || '',
      fatal: Boolean(document.querySelector('.fatal-screen')),
    };
  `);
  await execute("document.querySelector('[data-action=language]').click(); return true;");
  await delay(150);
  const afterLanguageSwitch = await execute("return document.documentElement.lang;");

  if (beforeLanguageSwitch.fatal) throw new Error("Application rendered the fatal screen.");
  if (beforeLanguageSwitch.chartPanels !== 3) throw new Error("Expected exactly three linked chart panels.");
  if (beforeLanguageSwitch.tableRows < 1) throw new Error("Expected trajectory rows after the course preset.");
  if (!beforeLanguageSwitch.currentTimeText.includes("4 h")) throw new Error("Untreated-growth course preset did not advance to four hours.");
  if (beforeLanguageSwitch.language === afterLanguageSwitch) throw new Error("Language switch did not change the document locale.");

  console.log(JSON.stringify({ beforeLanguageSwitch, afterLanguageSwitch }, null, 2));
  console.log("Safari smoke test passed.");
} finally {
  if (sessionId) {
    try {
      await fetch(`http://127.0.0.1:${driverPort}/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // Best-effort browser cleanup.
    }
  }
  server.kill("SIGTERM");
  driver.kill("SIGTERM");
}
