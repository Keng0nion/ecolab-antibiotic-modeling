import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadScientificCatalog } from "../catalog-loader.browser.js";

function responseFor(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(Buffer.byteLength(text)) }),
    async text() {
      return text;
    },
  };
}

test("browser catalog loader fetches registries and resolves the scientific model", async () => {
  const requested = [];
  const catalog = await loadScientificCatalog(async (url) => {
    requested.push(url.pathname);
    return responseFor(await readFile(url, "utf8"));
  });

  assert.equal(requested.length, 5);
  assert.equal(catalog.drugRegistry.records.length, 4);
  assert.equal(catalog.resolvedModel.ref.parameterSetId, "ecolab.bw25113-m9-regoes-transferred");
  assert.equal(catalog.resolvedModel.parameters.drugs.ciprofloxacin.zMicMgPerL, 0.017);
});

test("browser catalog loader rejects an invalid registry envelope", async () => {
  await assert.rejects(
    loadScientificCatalog(async () => responseFor('{"records":[]}')),
    /CATALOG_INVALID_ENVELOPE/,
  );
});

test("browser catalog loader times out suspended requests instead of leaving startup pending", async () => {
  await assert.rejects(
    loadScientificCatalog(() => new Promise(() => {}), { timeoutMs: 20 }),
    /CATALOG_TIMEOUT/,
  );
});

test("browser catalog loader passes one abort signal to every registry request", async () => {
  const signals = [];
  await loadScientificCatalog(async (url, options) => {
    signals.push(options.signal);
    return responseFor(await readFile(url, "utf8"));
  }, { timeoutMs: 1_000 });

  assert.equal(signals.length, 5);
  assert.equal(new Set(signals).size, 1);
  assert.equal(signals[0].aborted, false);
});
