import { resolveModelFromRegistries } from "../model.js";

const MAX_RESOURCE_BYTES = 2_000_000;
export const DEFAULT_CATALOG_TIMEOUT_MS = 10_000;

const urls = Object.freeze({
  modelRegistry: new URL("../../data/registry/model-definitions.json", import.meta.url),
  parameterRegistry: new URL("../../data/registry/parameter-sets.json", import.meta.url),
  sourceRegistry: new URL("../../data/registry/sources.json", import.meta.url),
  datasetRegistry: new URL("../../data/registry/datasets.json", import.meta.url),
  drugRegistry: new URL("../../data/registry/drugs.json", import.meta.url),
});

async function fetchRegistry(name, url, fetchImpl, signal) {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error(`CATALOG_HTTP_ERROR:${name}:${response.status}`);
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESOURCE_BYTES) {
    throw new Error(`CATALOG_RESOURCE_TOO_LARGE:${name}`);
  }
  const text = await response.text();
  if (text.length > MAX_RESOURCE_BYTES) throw new Error(`CATALOG_RESOURCE_TOO_LARGE:${name}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`CATALOG_INVALID_JSON:${name}`);
  }
  if (!value || value.schemaVersion !== "1.0.0" || !Array.isArray(value.records)) {
    throw new Error(`CATALOG_INVALID_ENVELOPE:${name}`);
  }
  return value;
}

export async function loadScientificCatalog(
  fetchImpl = fetch,
  { timeoutMs = DEFAULT_CATALOG_TIMEOUT_MS } = {},
) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("Catalog timeout must be a positive integer.");
  }
  const controller = new AbortController();
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort("CATALOG_TIMEOUT");
      reject(new Error("CATALOG_TIMEOUT"));
    }, timeoutMs);
  });
  try {
    const [modelRegistry, parameterRegistry, sourceRegistry, datasetRegistry, drugRegistry] =
      await Promise.race([
        Promise.all(
          Object.entries(urls).map(([name, url]) => fetchRegistry(name, url, fetchImpl, controller.signal)),
        ),
        timeout,
      ]);
    const modelRef = modelRegistry.records[0];
    const parameterSetRef = parameterRegistry.records[0];
    const resolvedModel = resolveModelFromRegistries({
      modelRegistry,
      parameterRegistry,
      sourceRegistry,
      modelRef: { id: modelRef.id, version: modelRef.version },
      parameterSetRef: { id: parameterSetRef.id, version: parameterSetRef.version },
    });
    return {
      modelRegistry,
      parameterRegistry,
      sourceRegistry,
      datasetRegistry,
      drugRegistry,
      resolvedModel,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("CATALOG_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
