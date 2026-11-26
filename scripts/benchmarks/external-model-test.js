import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, sha256HexFallback } from "../../src/analysis/fingerprint.js";
import { runGrowthModelComparison } from "../../src/analysis/growth-comparison.js";
import { researchPreset } from "../../src/app/research/state.js";
import { assertKnownOptions, resolveFileOption, slashPath } from "../lib/release-utils.js";
import { parseCsv } from "./lib/csv.js";

const rootPath = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
assertKnownOptions(args, ["--json-out"]);
const jsonPath = resolveFileOption(args, "--json-out", "data/derived/external-model-test.json", rootPath);
const seed = 3817;
const preset = "small";
const createdAt = "2026-11-26T00:00:00.000Z";
const budgets = researchPreset(preset).growthComparison;

function observationsFor(rows, conditions, roleOf) {
  return rows.map(({ unitId, timeHours, value }) => ({
    observationId: `${unitId}|timeHours=${timeHours}`,
    seriesId: unitId,
    independentUnitId: unitId,
    role: roleOf(unitId),
    timeHours,
    drugId: "none",
    concentrationMgPerL: 0,
    measurementType: "od600",
    value,
    censoring: "none",
    censoringBounds: null,
    replicate: unitId,
    conditions,
  }));
}

function datasetDocument({ datasetId, title, description, license, sourceIds, conditions, observations }) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId, title, description, createdAt, license, sourceIds, conditions },
    observations,
  };
}

function splitFor(dataset) {
  const roles = { training: { independentUnitIds: [], observationIds: [] }, validation: { independentUnitIds: [], observationIds: [] }, development: { independentUnitIds: [], observationIds: [] } };
  for (const row of dataset.observations) {
    const entry = roles[row.role];
    if (!entry.independentUnitIds.includes(row.independentUnitId)) entry.independentUnitIds.push(row.independentUnitId);
    entry.observationIds.push(row.observationId);
  }
  for (const entry of Object.values(roles)) {
    entry.independentUnitIds.sort();
    entry.observationIds.sort();
  }
  const split = { strategy: "external_holdout_by_independent_unit", sourceDatasetId: dataset.metadata.datasetId, roles };
  return { ...split, splitFingerprint: sha256HexFallback(canonicalJson(split)) };
}

async function runDataset(dataset) {
  return runGrowthModelComparison({
    dataset,
    split: splitFor(dataset),
    developmentRole: "validation",
    seed,
    bounds: budgets.bounds,
    optimizer: budgets.optimizer,
    crossValidation: budgets.crossValidation,
    bootstrap: budgets.bootstrap,
  });
}

function bandCoverage(result, validationRows, level = "0.8") {
  const band = result.trajectoryPrediction?.bands?.[level];
  if (!band || band.status !== "available" || !Number.isFinite(band.radius)) {
    return { available: false, status: band?.status ?? "missing", radius: null, curves: [] };
  }
  const predictions = new Map(band.predictions.map(({ timeHours, predicted }) => [timeHours, predicted]));
  const byUnit = new Map();
  for (const row of validationRows) {
    if (!predictions.has(row.timeHours)) continue;
    if (!byUnit.has(row.unitId)) byUnit.set(row.unitId, []);
    byUnit.get(row.unitId).push(row);
  }
  const curves = [...byUnit].map(([unitId, rows]) => {
    let maximum = 0;
    for (const row of rows) {
      const residual = Math.abs(row.value - predictions.get(row.timeHours));
      if (residual > maximum) maximum = residual;
    }
    return { unitId, pointCount: rows.length, maximumAbsoluteResidual: maximum, covered: maximum <= band.radius };
  });
  return {
    available: true,
    status: band.status,
    radius: band.radius,
    calibrationUnitCount: result.trajectoryPrediction.calibration.calibrationUnitCount,
    curves,
  };
}

function summarize(result, coverage) {
  const selected = result.development?.selected?.metrics;
  const baseline = result.development?.baseline?.metrics;
  return {
    selectedModel: result.selection?.selectedModel ?? null,
    selectedScore: result.selection?.selectedScore ?? null,
    crossValidation: Object.fromEntries(Object.entries(result.crossValidation?.candidates ?? {})
      .map(([name, candidate]) => [name, candidate.score])),
    development: {
      selectedMacroRmse: selected?.macroRmse ?? null,
      baselineMacroRmse: baseline?.macroRmse ?? null,
      deltaMacroRmseVsBaseline: result.development?.deltaMacroRmseVsBaseline ?? null,
    },
    trainingFits: Object.fromEntries(Object.entries(result.trainingFits ?? {})
      .map(([name, fit]) => [name, { converged: fit.converged, finite: fit.finite, status: fit.status }])),
    band: coverage.available
      ? { available: true, radius: coverage.radius, calibrationUnitCount: coverage.calibrationUnitCount }
      : { available: false, status: coverage.status },
    bandCoverage: coverage.available
      ? { curves: coverage.curves.length, covered: coverage.curves.filter((curve) => curve.covered).length }
      : null,
    warningCodes: [...new Set((result.warnings ?? []).map((warning) => warning.code ?? String(warning).slice(0, 60)))],
  };
}

const packageJson = JSON.parse(await readFile(resolve(rootPath, "package.json"), "utf8"));

// A. Independent laboratory: five untreated positive-control wells, leave-one-well-out.
const externalCsv = parseCsv(await readFile(resolve(rootPath, "data/external/elkaroui-2024/positive-controls.csv"), "utf8"));
const externalRows = externalCsv.slice(1).map(([well, timeHours, value]) => ({
  unitId: `elkaroui-${well}`, timeHours: Number(timeHours), value: Number(value),
}));
const externalUnits = [...new Set(externalRows.map(({ unitId }) => unitId))];
const externalConditions = {
  organism: "Escherichia coli",
  strain: "SJR206 (K-12 MG1655 background)",
  medium: { type: "M9-based fast-growth medium (glucose + amino acids)", conditionId: "elkaroui-GluAA" },
  temperatureC: 37,
  plateFormat: "96-well plate",
  workingVolumeUl: 200,
  samplingIntervalMinutes: 7,
  treatment: "untreated",
  antibioticExposure: false,
  rawOdBlankCorrection: "blank-corrected by the source by subtracting the initial sterile-medium OD",
};
const externalFolds = [];
for (const heldOut of externalUnits) {
  const validationRows = externalRows.filter(({ unitId }) => unitId === heldOut);
  const dataset = datasetDocument({
    datasetId: `zenodo-elkaroui-checkerboard-${heldOut}`,
    title: `External checkerboard positive controls, held out ${heldOut}`,
    description: "Five untreated positive-control wells from the El Karoui 2024 checkerboard plate; one well held out per fold.",
    license: "CC0-1.0",
    sourceIds: ["zenodo-15311905"],
    conditions: externalConditions,
    observations: observationsFor(externalRows, externalConditions, (unitId) => unitId === heldOut ? "validation" : "training"),
  });
  const result = await runDataset(dataset);
  externalFolds.push({ heldOut, ...summarize(result, bandCoverage(result, validationRows)) });
}

// B. Same laboratory, new media: 12 conditions with 8 training and 4 held-out curves each.
const expandedCsv = parseCsv(await readFile(resolve(rootPath, "data/derived/figshare-bw25113-expanded-validation/observations.csv"), "utf8"));
const header = expandedCsv[0];
const column = Object.fromEntries(header.map((name, index) => [name, index]));
const expandedRows = expandedCsv.slice(1).map((row) => ({
  conditionId: row[column.conditionId],
  unitId: `expanded-${row[column.conditionId]}-${row[column.curveLabel]}`,
  role: row[column.role] === "training" ? "training" : "validation",
  timeHours: Number(row[column.timeHours]),
  value: Number(row[column.value]),
})).filter(({ conditionId }) => conditionId !== "Cond00003");
const conditionIds = [...new Set(expandedRows.map(({ conditionId }) => conditionId))].sort();
const expandedConditions = (conditionId) => ({
  organism: "Escherichia coli",
  strain: "BW25113",
  medium: { type: "chemically defined medium", conditionId },
  temperatureC: 37,
  plateFormat: "96-well plate",
  workingVolumeUl: 200,
  samplingIntervalMinutes: 30,
  treatment: "untreated",
  antibioticExposure: false,
  rawOdBlankCorrection: "unblanked source OD600",
});
const expandedConditionsResults = [];
for (const conditionId of conditionIds) {
  const rows = expandedRows.filter((row) => row.conditionId === conditionId);
  const validationRows = rows.filter(({ role }) => role === "validation");
  const roleByUnit = new Map(rows.map((row) => [row.unitId, row.role]));
  const conditions = expandedConditions(conditionId);
  const dataset = datasetDocument({
    datasetId: `figshare-bw25113-expanded-${conditionId}`,
    title: `Expanded BW25113 condition ${conditionId}`,
    description: "Independent conditions from the same public BW25113 growth study; 8 training and 4 previously held-out curves.",
    license: "CC-BY-4.0",
    sourceIds: ["figshare-28342064"],
    conditions,
    observations: observationsFor(rows, conditions, (unitId) => roleByUnit.get(unitId)),
  });
  const result = await runDataset(dataset);
  const coverage = bandCoverage(result, validationRows);
  expandedConditionsResults.push({
    conditionId,
    ...summarize(result, coverage),
    coverageDetail: coverage.available
      ? { available: true, radius: coverage.radius, curves: coverage.curves }
      : { available: false, status: coverage.status },
  });
}

const allCoveredCurves = expandedConditionsResults.flatMap(({ coverageDetail }) => coverageDetail.curves ?? []);
const coveredCount = allCoveredCurves.filter(({ covered }) => covered).length;
const report = {
  schemaVersion: "1.0.0",
  kind: "ecolab.external-model-test",
  generatedFrom: { applicationVersion: packageJson.version, preset, seed, createdAt },
  externalLaboratory: {
    source: {
      dataset: "El Karoui lab checkerboard assay (2024)",
      doi: "10.5281/zenodo.15311905",
      license: "CC0-1.0",
      path: "data/external/elkaroui-2024/positive-controls.csv",
      note: "Five untreated positive-control wells from one plate; technical, not biological, replication.",
    },
    folds: externalFolds,
  },
  sameLaboratoryNewConditions: {
    source: {
      dataset: "Aida & Ying BW25113 expanded validation",
      doi: "10.6084/m9.figshare.28342064.v1",
      license: "CC-BY-4.0",
      path: "data/derived/figshare-bw25113-expanded-validation/observations.csv",
      note: "12 conditions with 8 training and 4 held-out curves each; same laboratory and plate-reader pipeline as the bundled data.",
    },
    conditions: expandedConditionsResults,
    bandCoverage: {
      conditionsWithBand: expandedConditionsResults.filter(({ coverageDetail }) => coverageDetail.available).length,
      curves: allCoveredCurves.length,
      covered: coveredCount,
      coverage: allCoveredCurves.length ? coveredCount / allCoveredCurves.length : null,
      perCondition: expandedConditionsResults.map(({ conditionId, coverageDetail }) => ({
        conditionId,
        radius: coverageDetail.radius ?? null,
        curves: coverageDetail.curves?.length ?? 0,
        covered: coverageDetail.curves?.filter(({ covered }) => covered).length ?? 0,
      })),
    },
  },
  interpretation: [
    "The external-laboratory set has only five wells from one plate, so its leave-one-well-out folds test schema, units and prediction behaviour, not biological generalisation.",
    "Four training curves yield two calibration units, below the four required for an 80% conformal band; the comparison should report the band as unavailable instead of a number.",
    "The same-laboratory new-condition set is the only part with enough curves for a real band check; it shares the plate-reader pipeline with the bundled data, so it is not independent external validation.",
  ],
};
await mkdir(dirname(jsonPath), { recursive: true });
await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
  output: slashPath(relative(rootPath, jsonPath)),
  externalFolds: externalFolds.map(({ heldOut, selectedModel, development, band }) => ({ heldOut, selectedModel, development, band })),
  bandCoverage: report.sameLaboratoryNewConditions.bandCoverage,
}, null, 2));
