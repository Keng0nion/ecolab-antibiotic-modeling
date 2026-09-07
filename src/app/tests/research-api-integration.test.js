import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolveModelFromRegistries } from "../../model.js";
import { sha256HexFallback } from "../../analysis/fingerprint.js";
import { runEcolabResearchWorkflow } from "../../analysis/research-upgrade.js";
import { inspectResearchPackage, replayResearchPackage } from "../../analysis/research-replay.js";
import { MESSAGES, createI18n } from "../i18n.js";
import { buildResearchWorkflowOptions, captureResearchRun, createResearchState } from "../research/state.js";
import { renderResearchWorkspace } from "../research/view.js";
import { serializeResearchDashboard } from "../research/charts.js";
import { analysisManifestJson, predictionsMetricsToCsv, researchMethodsText, researchPackageJson } from "../research/export.js";
import { createCatalogFixture, createDatasetRecord } from "./research-test-fixtures.js";

const root = new URL("../../../", import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), "utf8"));

test("browser small preset works with actual v2 API, bilingual presentation and exact package replay", { timeout: 30000 }, async () => {
  const [sourceText, modelRegistry, parameterRegistry, sourceRegistry] = await Promise.all([
    readFile(new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", root), "utf8"),
    json("data/registry/model-definitions.json"), json("data/registry/parameter-sets.json"), json("data/registry/sources.json"),
  ]);
  const resolvedModel = resolveModelFromRegistries({
    modelRegistry, parameterRegistry, sourceRegistry,
    modelRef: { id: "ecolab.single-population.regoes-logistic", version: "1.0.0" },
    parameterSetRef: { id: "ecolab.bw25113-m9-regoes-transferred", version: "1.0.0" },
  });
  const dataset = createDatasetRecord({ sourceText, contentHash: sha256HexFallback(sourceText), normalizedDataset: JSON.parse(sourceText) });
  const run = captureResearchRun({ dataset, seed: 9127, preset: "small", applicationVersion: "6.0.0", now: () => new Date("2026-09-07T12:00:00Z") });
  const options = buildResearchWorkflowOptions({ run, dataset, resolvedModel });
  const phases = new Set();
  const result = await runEcolabResearchWorkflow({ ...options, runtime: { yieldControl: async () => {} }, onProgress: ({ phase }) => phases.add(phase.replace(/[-:]/g, "_")) });
  assert.equal(result.kind, "ecolab-development-research-workflow");
  assert.equal(result.researchAssessment.completed, true);
  assert.equal(result.growthComparison.bootstrap.requestedSamples, 20);
  assert.equal(result.validation.observationRoleUsed, "validation");
  assert.deepEqual(result.growthComparison.configuration.bounds, options.growthComparison.bounds);
  assert.equal(result.growthComparison.configuration.optimizer.differentialEvolutionMaxEvaluations, 120);
  const normalized = result.researchPackage.contents.artifacts["normalized-observation-dataset"];
  const originalResult = JSON.stringify(result);
  const originalPackage = researchPackageJson(result);
  assert.equal(analysisManifestJson(result), JSON.stringify(result.manifest, null, 2));
  assert.deepEqual(inspectResearchPackage(originalPackage).reasons, []);
  assert.equal(inspectResearchPackage(originalPackage).replayable, true);
  const replay = await replayResearchPackage(originalPackage, { runtime: { yieldControl: async () => {} } });
  assert.equal(replay.matched, true);
  assert.equal(replay.comparison.mismatchCount, 0);

  const catalog = { ...createCatalogFixture(), resolvedModel };
  const state = createResearchState();
  state.activeSection = "results";
  state.selectedDataset = { ...dataset, normalizedDataset: normalized };
  state.result = result;
  state.selectedValidationUnit = result.validation.independentUnits.validation[0];
  for (const locale of ["en", "zh-CN"]) {
    const i18n = createI18n(locale);
    const render = () => renderResearchWorkspace({ state, catalog, registryRecord: catalog.datasetRegistry.records[0], sourceRecord: catalog.sourceRegistry.records[0], t: (key, params) => i18n.t(key, params), locale });
    const html = render();
    assert.match(html, /logistic/);
    assert.match(html, /gompertz/);
    assert.match(html, /20/);
    assert.doesNotMatch(html, /Locked validation|锁定验证|\[object Object\]|NaN/);
    assert.match(html, /OD.*nuisance.*reoptimized/i);
    const csv = predictionsMetricsToCsv(normalized, result, locale);
    assert.match(csv, /prediction,development,/);
    assert.match(csv, /growth\.cv\.training_mean\.macroRmse/);
    assert.match(csv, /source_role/);
    const svg = serializeResearchDashboard({ dataset: normalized, result, selectedValidationUnit: state.selectedValidationUnit, locale });
    assert.match(svg, /Sobol S1:/);
    assert.doesNotMatch(svg, /NaN|width="-/);
    assert.match(researchMethodsText(result, locale), locale === "en" ? /previously viewed development/ : /已查看的开发/);
    for (const phase of phases) assert.equal(typeof MESSAGES[locale][`research.progress.${phase}`], "string", `${locale}: ${phase}`);
    state.activeSection = "analysis";
    state.replayPreview = { ...inspectResearchPackage(originalPackage), input: originalPackage, ...replay, status: "matched" };
    state.selectedDataset = null;
    state.selectedAnalysis = null;
    state.result = null;
    assert.match(render(), locale === "en" ? /Replay matched/ : /重放匹配/);
    assert.match(render(), locale === "en" ? /Replay preview metrics/ : /重放预览指标/);
    state.activeSection = "results";
    state.selectedDataset = { ...dataset, normalizedDataset: normalized };
    state.result = result;
  }
  assert.equal(JSON.stringify(result), originalResult);
  assert.equal(researchPackageJson(result), originalPackage);
});
