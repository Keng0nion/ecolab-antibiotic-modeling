import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries } from "../../registry/resolve.js";

const root = new URL("../../../", import.meta.url);

export async function readProjectJson(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

export async function loadResolvedModel() {
  const [modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
    readProjectJson("data/registry/model-definitions.json"),
    readProjectJson("data/registry/parameter-sets.json"),
    readProjectJson("data/registry/sources.json"),
  ]);
  return resolveModelFromRegistries({
    modelRegistry,
    parameterRegistry,
    sourceRegistry,
    modelRef: {
      id: "ecolab.single-population.regoes-logistic",
      version: "1.0.0",
    },
    parameterSetRef: {
      id: "ecolab.bw25113-m9-regoes-transferred",
      version: "1.0.0",
    },
  });
}
