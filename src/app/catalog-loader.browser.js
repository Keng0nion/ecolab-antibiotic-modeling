import { resolveModelFromRegistries } from "../model.js";

const MAX_RESOURCE_BYTES = 2_000_000;

const urls = Object.freeze({
  modelRegistry: new URL("../../data/registry/model-definitions.json", import.meta.url),
  parameterRegistry: new URL("../../data/registry/parameter-sets.json", import.meta.url),
  sourceRegistry: new URL("../../data/registry/sources.json", import.meta.url),
  datasetRegistry: new URL("../../data/registry/datasets.json", import.meta.url),
  drugRegistry: new URL("../../data/registry/drugs.json", import.meta.url),
});

async function fetchRegistry(name, url, fetchImpl) {
  const response = await fetchImpl(url);
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

export async function loadScientificCatalog(fetchImpl = fetch) {
  const [modelRegistry, parameterRegistry, sourceRegistry, datasetRegistry, drugRegistry] =
    await Promise.all(
      Object.entries(urls).map(([name, url]) => fetchRegistry(name, url, fetchImpl)),
    );
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
}
