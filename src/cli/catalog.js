import { readFile } from "node:fs/promises";
import { sha256Hex } from "../analysis/index.js";
import { loadScientificCatalog as loadCatalogWithFetch } from "../app/catalog-loader.browser.js";
import {
  bundledDatasetRecord,
  fetchBundledDatasetText,
} from "../app/research/dataset-loader.js";
import { cliError } from "./io.js";

/**
 * A fetch-shaped adapter that reads repository files. The catalog loader and the
 * bundled-dataset reader are otherwise the exact browser modules, so the CLI
 * performs no network I/O and reuses the same registry validation.
 */
export function fileFetch(url) {
  return readFile(url, "utf8").then(
    (text) => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => text,
    }),
    (error) => {
      throw cliError("CLI_CATALOG_FILE_UNAVAILABLE", `Repository file not found: ${String(url)}`, {
        actual: error?.code ?? null,
      });
    },
  );
}

export async function loadCatalog() {
  return loadCatalogWithFetch(fileFetch);
}

/** Read and verify the bundled normalized dataset through its registry record. */
export async function readBundledDataset(catalog) {
  const registryRecord = bundledDatasetRecord(catalog.datasetRegistry);
  const { text, contentHash } = await fetchBundledDatasetText({
    registryRecord,
    fetchImpl: fileFetch,
    hashImpl: sha256Hex,
  });
  return { registryRecord, text, contentHash };
}
