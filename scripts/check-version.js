import { readFile } from "node:fs/promises";
import * as analysis from "../src/analysis/version.js";
import { ENGINE_VERSION, IMPLEMENTATION_ID, MODEL_ID } from "../src/model/version.js";


const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const versionSource = await readFile(new URL("src/app/version.js", root), "utf8");
const match = versionSource.match(/export\s+const\s+APPLICATION_VERSION\s*=\s*["']([^"']+)["']\s*;/u);

if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  throw new Error("package.json must declare a valid semantic version.");
}
if (!match) throw new Error("src/app/version.js must export a literal APPLICATION_VERSION.");
if (match[1] !== packageJson.version) {
  throw new Error(`Application version mismatch: package.json=${packageJson.version}, src/app/version.js=${match[1]}.`);
}
if (packageJson.version !== "6.0.0") {
  throw new Error(`Stage 6 requires application version 6.0.0; found ${packageJson.version}.`);
}

if (analysis.ANALYSIS_ENGINE_VERSION !== "2.0.0") {
  throw new Error(`Stage 6 requires analysis 2.0.0; found ${analysis.ANALYSIS_ENGINE_VERSION}.`);
}
if ([analysis.ANALYSIS_ENGINE_ID, analysis.ANALYSIS_ENGINE_STABLE_ID, analysis.ANALYSIS_STABLE_ID]
  .some((id) => id !== "ecolab.stage4.analysis")) {
  throw new Error("The stable analysis engine ID and aliases must remain ecolab.stage4.analysis.");
}
if ([analysis.ANALYSIS_IMPLEMENTATION_ID, analysis.ANALYSIS_ENGINE_IMPLEMENTATION_ID]
  .some((id) => id !== "ecolab-research-analysis-v2")) {
  throw new Error("Stage 6 requires analysis implementation ecolab-research-analysis-v2 and matching aliases.");
}
if (ENGINE_VERSION !== "2.0.0") throw new Error("The teaching scientific core must remain 2.0.0.");
const models = JSON.parse(await readFile(new URL("data/registry/model-definitions.json", root), "utf8"));
const teachingModel = models.records.find(({ id }) => id === MODEL_ID);
if (MODEL_ID !== "ecolab.single-population.regoes-logistic" || teachingModel?.version !== "1.0.0"
  || IMPLEMENTATION_ID !== "regoes-logistic-piecewise-analytic-v1" || teachingModel.implementationId !== IMPLEMENTATION_ID) {
  throw new Error("The teaching model must remain ecolab.single-population.regoes-logistic 1.0.0 with regoes-logistic-piecewise-analytic-v1.");
}

console.log(`Application version ${packageJson.version} is consistent; package.json is authoritative. Analysis ${analysis.ANALYSIS_ENGINE_VERSION} (${analysis.ANALYSIS_IMPLEMENTATION_ID}); core ${ENGINE_VERSION}; model ${teachingModel.version}.`);
