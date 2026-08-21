import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { importObservationDataset } from "../analysis/dataset-import.js";
import { extractFigshareDataset } from "../../scripts/extract-figshare-bw25113.js";
import { columnNumberToName, readXlsx, worksheetRecords } from "../../scripts/lib/xlsx-reader.js";

const projectRoot = new URL("../../", import.meta.url);
const rawDirectory = new URL("data/raw/figshare-bw25113-growth-v1/", projectRoot);
const bundledDirectory = new URL("data/datasets/figshare-bw25113-growth-v1/", projectRoot);
const labels = Array.from({ length: 12 }, (_, index) => `Curve${String(index + 25).padStart(5, "0")}`);
const trainingLabels = labels.slice(0, 8);
const validationLabels = labels.slice(8);
const times = Array.from({ length: 44 }, (_, index) => (index + 1) / 2);
const expectedNormalizedSha256 = "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function valueMap(records, workbookName) {
  const result = new Map();
  for (const { rowNumber, values } of records) {
    assert.equal(typeof values.Label, "string", `${workbookName} row ${rowNumber}`);
    assert.equal(result.has(values.Label), false, `${workbookName} duplicate ${values.Label}`);
    result.set(values.Label, values);
  }
  return result;
}

function labelFromUnitId(unitId) {
  return unitId.split("|")[0];
}

test("verified Figshare BW25113 real-data admission pipeline", async (t) => {
  const [growthWorkbook, compositionWorkbook, evaluationWorkbook] = await Promise.all([
    readXlsx(new URL("BW25113_Growth_Round01.xlsx", rawDirectory)),
    readXlsx(new URL("BW25113_Medium composition.xlsx", rawDirectory)),
    readXlsx(new URL("BW25113_GrowthDataEvaluation.xlsx", rawDirectory)),
  ]);

  const growthSheet = growthWorkbook.getSheet("Sheet1");
  const compositionRows = worksheetRecords(compositionWorkbook.getSheet("Sheet1"));
  const evaluationRows = worksheetRecords(evaluationWorkbook.getSheet("Sheet1"));
  const compositionByLabel = valueMap(compositionRows.records, "composition");
  const evaluationByLabel = valueMap(evaluationRows.records, "evaluation");

  await t.test("reader exposes exact selected workbook cells and source numeric tokens", () => {
    assert.deepEqual(growthWorkbook.sheetNames, ["Sheet1"]);
    assert.equal(growthSheet.getValue("A1"), "Time (h)");
    assert.equal(growthSheet.getValue("Z1"), "Curve00025");
    assert.equal(growthSheet.getValue("AK1"), "Curve00036");
    assert.equal(growthSheet.getCell("Z2").rawValue, "8.3000000000000004E-2");
    assert.equal(growthSheet.getCell("AK2").rawValue, "8.1000000000000003E-2");
    assert.equal(growthSheet.getCell("Z23").rawValue, "0.22700000000000001");
    assert.equal(growthSheet.getCell("AK23").rawValue, "0.23300000000000001");
    assert.equal(growthSheet.getCell("Z45").rawValue, "0.32400000000000001");
    assert.equal(growthSheet.getCell("AK45").rawValue, "0.32100000000000001");
    assert.deepEqual(
      labels.map((label, index) => growthSheet.getValue(`${columnNumberToName(index + 26)}1`)),
      labels,
    );
    assert.deepEqual(times.map((_, index) => growthSheet.getValue(`A${index + 2}`)), times);
    assert.deepEqual(
      labels.map((_, index) => growthSheet.getValue(`${columnNumberToName(index + 26)}2`)),
      [0.083, 0.083, 0.082, 0.081, 0.081, 0.081, 0.083, 0.083, 0.08, 0.081, 0.08, 0.081],
    );
    assert.deepEqual(
      labels.map((_, index) => growthSheet.getValue(`${columnNumberToName(index + 26)}45`)),
      [0.324, 0.327, 0.313, 0.321, 0.311, 0.316, 0.32, 0.325, 0.318, 0.321, 0.314, 0.321],
    );
  });

  await t.test("composition and evaluation join exactly by Label", () => {
    const referenceComposition = compositionByLabel.get(labels[0]);
    assert.ok(referenceComposition);
    assert.equal(Object.hasOwn(referenceComposition, "ZuSO4/7H2O\r\n(mM)"), true);
    assert.equal(referenceComposition["ZuSO4/7H2O\r\n(mM)"], 0.0001);
    assert.equal(referenceComposition["K2HPO4\r\n(mM)"], 61.5);

    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const expectedAssayId = `Round01_${String(index + 25).padStart(4, "0")}`;
      const composition = compositionByLabel.get(label);
      const evaluation = evaluationByLabel.get(label);
      assert.ok(composition, `missing composition ${label}`);
      assert.ok(evaluation, `missing evaluation ${label}`);
      assert.equal(composition["Assay ID"], expectedAssayId);
      assert.equal(evaluation["Assay ID"], expectedAssayId);
      assert.equal(composition["Assay ID"], evaluation["Assay ID"]);
      assert.equal(composition["Condition ID"], "Cond00003");
      assert.equal(evaluation["Condition ID"], "Cond00003");
      assert.equal(composition["K2HPO4\r\n(mM)"], 61.5);
      assert.equal(evaluation.K_info, 0);
      assert.equal(evaluation.r_info, 0);
      assert.equal(Number.isFinite(evaluation.K), true);
      assert.equal(Number.isFinite(evaluation.r), true);
      for (const header of compositionRows.headers.slice(3)) {
        assert.equal(composition[header], referenceComposition[header], `${label} ${header}`);
      }
    }
  });

  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "ecolab-real-dataset-"));
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const extraction = await extractFigshareDataset({
    rawDirectory: fileURLToPath(rawDirectory),
    outputDirectory: temporaryDirectory,
  });

  const [generatedJsonBuffer, generatedCsvBuffer, generatedReadme, generatedChecksums, bundledJsonBuffer] = await Promise.all([
    readFile(extraction.artifacts.json),
    readFile(extraction.artifacts.csv),
    readFile(extraction.artifacts.readme, "utf8"),
    readFile(extraction.artifacts.checksums, "utf8"),
    readFile(new URL("figshare-bw25113-growth-v1.json", bundledDirectory)),
  ]);
  const generatedJson = JSON.parse(generatedJsonBuffer.toString("utf8"));
  const checksums = JSON.parse(generatedChecksums);

  await t.test("independent extraction is deterministic and matches the bundled artifacts", () => {
    assert.equal(extraction.observationCount, 528);
    assert.equal(extraction.trainingObservationCount, 352);
    assert.equal(extraction.validationObservationCount, 176);
    assert.equal(extraction.independentUnitCount, 12);
    assert.equal(sha256(generatedJsonBuffer), expectedNormalizedSha256);
    assert.equal(extraction.normalizedDataSha256, expectedNormalizedSha256);
    assert.equal(checksums.normalizedDataSha256, expectedNormalizedSha256);
    assert.deepEqual(generatedJsonBuffer, bundledJsonBuffer);
    assert.match(generatedReadme, /OD600 is not CFU\/mL/);
    assert.match(generatedReadme, /raw and unblanked|raw, unblanked/i);
    assert.match(generatedReadme, /no OD-to-CFU conversion/i);
    assert.match(generatedReadme, /ZuSO4/);
    assert.match(generatedReadme, /CC BY 4\.0/);
  });

  await t.test("all 528 normalized values are exact source cell parses with no OD-to-CFU conversion", () => {
    assert.equal(generatedJson.schemaVersion, "1.0.0");
    assert.equal(generatedJson.kind, "observation-dataset");
    assert.equal(generatedJson.metadata.datasetId, "figshare-bw25113-growth-v1");
    assert.equal(generatedJson.metadata.license, "CC-BY-4.0");
    assert.deepEqual(generatedJson.metadata.sourceIds, ["figshare-bw25113-growth-v1"]);
    assert.equal(generatedJson.observations.length, 44 * 12);

    for (let labelIndex = 0; labelIndex < labels.length; labelIndex += 1) {
      const label = labels[labelIndex];
      const assayId = `Round01_${String(labelIndex + 25).padStart(4, "0")}`;
      const unitId = `${label}|${assayId}`;
      const series = generatedJson.observations.filter((observation) => observation.independentUnitId === unitId);
      assert.equal(series.length, 44, unitId);
      assert.deepEqual(series.map((observation) => observation.timeHours), times);
      for (let timeIndex = 0; timeIndex < times.length; timeIndex += 1) {
        const sourceCell = growthSheet.getCell(`${columnNumberToName(labelIndex + 26)}${timeIndex + 2}`);
        const observation = series[timeIndex];
        assert.equal(observation.value, Number(sourceCell.rawValue), `${label} at ${times[timeIndex]} h`);
        assert.equal(observation.measurementType, "od600");
        assert.notEqual(observation.measurementType, "cfu_per_ml");
        assert.notEqual(observation.measurementType, "log10_cfu_per_ml");
        assert.equal(observation.drugId, "none");
        assert.equal(observation.concentrationMgPerL, 0);
        assert.equal(observation.censoring, "none");
        assert.equal(observation.censoringBounds, null);
        assert.equal(observation.seriesId, unitId);
        assert.equal(observation.replicate, unitId);
      }
    }
  });

  await t.test("complete independent units are split without leakage", () => {
    const roleByUnit = new Map();
    for (const observation of generatedJson.observations) {
      const previous = roleByUnit.get(observation.independentUnitId);
      if (previous) assert.equal(previous, observation.role, observation.independentUnitId);
      roleByUnit.set(observation.independentUnitId, observation.role);
    }
    assert.equal(roleByUnit.size, 12);
    assert.equal(generatedJson.observations.filter(({ role }) => role === "training").length, 352);
    assert.equal(generatedJson.observations.filter(({ role }) => role === "validation").length, 176);
    assert.deepEqual(
      [...roleByUnit].filter(([, role]) => role === "training").map(([unitId]) => labelFromUnitId(unitId)),
      trainingLabels,
    );
    assert.deepEqual(
      [...roleByUnit].filter(([, role]) => role === "validation").map(([unitId]) => labelFromUnitId(unitId)),
      validationLabels,
    );
  });

  await t.test("conditions preserve the full source composition and explicit experimental semantics", () => {
    const conditions = generatedJson.metadata.conditions;
    assert.equal(conditions.organism, "Escherichia coli");
    assert.equal(conditions.strain, "BW25113");
    assert.equal(conditions.medium.type, "chemically defined medium");
    assert.equal(conditions.medium.conditionId, "Cond00003");
    assert.equal(conditions.medium.compositionUnit, "mM");
    assert.equal(conditions.temperatureC, 37);
    assert.equal(conditions.plateFormat, "96-well plate");
    assert.equal(conditions.workingVolumeUl, 200);
    assert.equal(conditions.shakingRpm, 567);
    assert.equal(conditions.inoculationDilution, "1:1000");
    assert.equal(conditions.plateReader, "Epoch2");
    assert.equal(conditions.samplingIntervalMinutes, 30);
    assert.equal(conditions.treatment, "untreated");
    assert.equal(conditions.antibioticExposure, false);
    assert.equal(conditions.rawOdBlankCorrection, "none; source OD600 values are unblanked");

    const expectedComposition = compositionRows.headers.slice(3).map((sourceHeader) => ({
      component: sourceHeader.slice(0, -"\r\n(mM)".length),
      sourceHeader,
      concentrationMm: compositionByLabel.get("Curve00025")[sourceHeader],
    }));
    assert.deepEqual(conditions.medium.composition, expectedComposition);
    assert.equal(conditions.medium.composition.length, 44);
    assert.deepEqual(
      conditions.medium.composition.find(({ sourceHeader }) => sourceHeader === "ZuSO4/7H2O\r\n(mM)"),
      {
        component: "ZuSO4/7H2O",
        sourceHeader: "ZuSO4/7H2O\r\n(mM)",
        concentrationMm: 0.0001,
      },
    );
    for (const observation of generatedJson.observations) assert.deepEqual(observation.conditions, conditions);
  });

  await t.test("generated JSON and CSV independently pass the strict importer and are identical", () => {
    const jsonImport = importObservationDataset(generatedJsonBuffer.toString("utf8"), { format: "json" });
    const csvImport = importObservationDataset(generatedCsvBuffer.toString("utf8"), {
      format: "csv",
      datasetMetadata: generatedJson.metadata,
    });
    assert.equal(jsonImport.warnings.length, 0);
    assert.equal(csvImport.warnings.length, 0);
    assert.deepEqual(csvImport.dataset, jsonImport.dataset);
  });
});
