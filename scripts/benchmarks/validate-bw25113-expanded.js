import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_FILES, SOURCE_METADATA, verifySourceBuffer } from "../acquire-figshare-bw25113.js";
import { openXlsx, worksheetRecords } from "../lib/xlsx-reader.js";
import { createRandom, deriveSeed } from "../../src/analysis/random.js";
import { normalizeObservationDataset } from "../../src/analysis/dataset-import.js";
import { createDatasetSplit } from "../../src/analysis/split.js";
import { runGrowthModelComparison } from "../../src/analysis/growth-comparison.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "../..");
const SELECTED_CONDITION_IDS = Object.freeze([
  "Cond00042", "Cond00045", "Cond00054", "Cond00057", "Cond00070", "Cond00072",
  "Cond00090", "Cond00092", "Cond00097", "Cond00126", "Cond00130", "Cond00137",
]);
const LARGE_COHORT = Object.freeze({ conditionId: "Cond00003", trainingCount: 48, developmentCount: 12 });
const EXCLUDED_PREVIOUSLY_ANALYZED_LABELS = new Set(
  Array.from({ length: 12 }, (_, index) => `Curve${String(index + 25).padStart(5, "0")}`),
);
const BOUNDS = Object.freeze({
  baselineOd: Object.freeze([0, 0.3]),
  amplitudeOd: Object.freeze([0.001, 1]),
  ratePerHour: Object.freeze([0.001, 4]),
  timingHours: Object.freeze([0, 30]),
});
const OPTIMIZER = Object.freeze({
  restarts: 1,
  populationSize: 64,
  differentialEvolutionMaxEvaluations: 1200,
  nelderMeadMaxEvaluations: 1200,
  tolerance: 1e-7,
  objectiveTolerance: 1e-12,
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function compareText(left, right) {
  return left.localeCompare(right, "en", { numeric: true });
}

function conditionOrder(left, right) {
  return compareText(left.conditionId, right.conditionId);
}

export function selectEvenlySpaced(items, count) {
  if (!Array.isArray(items) || !Number.isSafeInteger(count) || count < 1) {
    throw new TypeError("items must be an array and count must be a positive safe integer.");
  }
  if (count > items.length) throw new RangeError(`The ordered cohort has ${items.length} entries; at least ${count} are required.`);
  if (count === 1) return [items[Math.floor((items.length - 1) / 2)]];
  return Array.from({ length: count }, (_, index) => items[Math.floor(index * (items.length - 1) / (count - 1))]);
}

export function splitCurveLabels(labels, trainingCount, seed, splitId) {
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== "string" || !label)
    || new Set(labels).size !== labels.length) throw new TypeError("labels must be unique non-empty strings.");
  if (!Number.isSafeInteger(trainingCount) || trainingCount < 1 || trainingCount >= labels.length) {
    throw new RangeError("trainingCount must be positive and smaller than the curve count.");
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff
    || typeof splitId !== "string" || !splitId) throw new TypeError("seed and splitId must identify a reproducible split.");
  const shuffled = [...labels].sort(compareText);
  const random = createRandom(deriveSeed(seed, "figshare-bw25113-role-split-v1", splitId));
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random.next() * (index + 1));
    [shuffled[index], shuffled[selected]] = [shuffled[selected], shuffled[index]];
  }
  return {
    training: shuffled.slice(0, trainingCount).sort(compareText),
    development: shuffled.slice(trainingCount).sort(compareText),
  };
}

function commonTimes(curves) {
  if (!curves.length) return [];
  const otherTimes = curves.slice(1).map((curve) => new Set(curve.points.map(({ timeHours }) => timeHours)));
  return curves[0].points.map(({ timeHours }) => timeHours)
    .filter((timeHours) => otherTimes.every((times) => times.has(timeHours)))
    .sort((left, right) => left - right);
}

/** Select balanced source-quality-passing cohorts with a shared exact-time grid. */
export function selectEligibleConditionCohorts(curves, options = {}) {
  const {
    conditionsToSelect = 12,
    replicateCount = 12,
    minimumCommonTimepoints = 48,
    excludedConditionIds = [],
    excludedLabels = [],
  } = options;
  for (const [name, value] of Object.entries({ conditionsToSelect, replicateCount, minimumCommonTimepoints })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  }
  if (!Array.isArray(curves)) throw new TypeError("curves must be an array.");
  if (!Array.isArray(excludedConditionIds) || !Array.isArray(excludedLabels)) {
    throw new TypeError("excludedConditionIds and excludedLabels must be arrays.");
  }

  const excludedConditions = new Set(excludedConditionIds);
  const excludedCurveLabels = new Set(excludedLabels);
  const grouped = new Map();
  for (const curve of curves) {
    if (!curve || typeof curve.label !== "string" || !curve.label
      || typeof curve.conditionId !== "string" || !curve.conditionId
      || typeof curve.qualityPass !== "boolean" || !Array.isArray(curve.points)) {
      throw new TypeError("Each curve requires label, conditionId, qualityPass, and points.");
    }
    if (!curve.qualityPass || excludedConditions.has(curve.conditionId) || excludedCurveLabels.has(curve.label)) continue;
    const seenTimes = new Set();
    const points = curve.points.map((point) => {
      if (!point || typeof point.timeHours !== "number" || !Number.isFinite(point.timeHours)
        || typeof point.value !== "number" || !Number.isFinite(point.value) || seenTimes.has(point.timeHours)) {
        throw new TypeError(`${curve.label} must contain finite values at unique times.`);
      }
      seenTimes.add(point.timeHours);
      return { timeHours: point.timeHours, value: point.value };
    }).sort((left, right) => left.timeHours - right.timeHours);
    if (points.length < minimumCommonTimepoints) continue;
    if (!grouped.has(curve.conditionId)) grouped.set(curve.conditionId, []);
    grouped.get(curve.conditionId).push({ label: curve.label, conditionId: curve.conditionId, qualityPass: true, points });
  }

  const eligible = [];
  for (const [conditionId, candidates] of grouped) {
    candidates.sort((left, right) => compareText(left.label, right.label));
    if (candidates.length < replicateCount) continue;
    const selected = candidates.slice(0, replicateCount);
    const timeHours = commonTimes(selected);
    if (timeHours.length < minimumCommonTimepoints) continue;
    const support = new Set(timeHours.slice(0, minimumCommonTimepoints));
    eligible.push({
      conditionId,
      timeHours: [...support].sort((left, right) => left - right),
      curves: selected.map((curve) => ({
        ...curve,
        points: curve.points.filter(({ timeHours: time }) => support.has(time)),
      })),
    });
  }
  eligible.sort(conditionOrder);
  if (eligible.length < conditionsToSelect) {
    throw new Error(`Only ${eligible.length} eligible conditions; ${conditionsToSelect} were requested.`);
  }
  return selectEvenlySpaced(eligible, conditionsToSelect);
}

function uniqueMap(records, key, workbookName) {
  const rows = new Map();
  for (const record of records) {
    const id = record.values[key];
    assert(typeof id === "string" && id.length > 0, `${workbookName} row ${record.rowNumber} is missing ${key}.`);
    assert(!rows.has(id), `${workbookName} has duplicate ${key} ${id}.`);
    rows.set(id, record.values);
  }
  return rows;
}

async function readVerifiedSource(sourceDirectory) {
  const workbooks = [];
  const fingerprints = [];
  for (const specification of SOURCE_FILES) {
    const buffer = await readFile(path.join(sourceDirectory, specification.name));
    fingerprints.push({ name: specification.name, ...verifySourceBuffer(buffer, specification) });
    workbooks.push(openXlsx(buffer));
  }
  const growth = worksheetRecords(workbooks[0].getSheet("Sheet1"));
  const composition = worksheetRecords(workbooks[1].getSheet("Sheet1"));
  const evaluation = worksheetRecords(workbooks[2].getSheet("Sheet1"));
  const timeHeader = growth.headers[0];
  assert(timeHeader === "Time (h)", `Unexpected source time header ${JSON.stringify(timeHeader)}.`);
  const times = growth.records.map(({ values }) => values[timeHeader]);
  assert(times.length === 97 && times.every((time, index) =>
    Number.isFinite(time) && time === (index + 1) / 2), "The source time grid must be 0.5 to 48.5 h in 0.5 h steps.");
  const compositionByLabel = uniqueMap(composition.records, "Label", "composition workbook");
  const evaluationByLabel = uniqueMap(evaluation.records, "Label", "evaluation workbook");
  const labels = growth.headers.slice(1);
  assert(labels.length === 2628, `Expected 2,628 growth curves; found ${labels.length}.`);
  const curves = labels.map((label) => {
    const compositionRow = compositionByLabel.get(label);
    const evaluationRow = evaluationByLabel.get(label);
    assert(compositionRow && evaluationRow, `${label} is missing a metadata join.`);
    assert(compositionRow["Condition ID"] === evaluationRow["Condition ID"]
      && compositionRow["Assay ID"] === evaluationRow["Assay ID"], `${label} metadata keys disagree.`);
    const points = growth.records.flatMap(({ values }) => {
      const value = values[label];
      return value === null || value === "" ? [] : [{ timeHours: values[timeHeader], value }];
    });
    return {
      label,
      conditionId: compositionRow["Condition ID"],
      assayId: compositionRow["Assay ID"],
      qualityPass: Number(evaluationRow.K_info) === 0 && Number(evaluationRow.r_info) === 0,
      points,
    };
  });
  const byCondition = new Map();
  for (const curve of curves) {
    if (!byCondition.has(curve.conditionId)) byCondition.set(curve.conditionId, []);
    byCondition.get(curve.conditionId).push(curve);
  }
  let eligibleConditionCount = 0;
  for (const [conditionId, conditionCurves] of byCondition) {
    if (conditionId === LARGE_COHORT.conditionId) continue;
    const passing = conditionCurves.filter((curve) => curve.qualityPass && curve.points.length >= 48)
      .sort((left, right) => compareText(left.label, right.label)).slice(0, 12);
    if (passing.length === 12 && commonTimes(passing).length >= 48) eligibleConditionCount += 1;
  }
  const qualityPassCount = curves.filter(({ qualityPass }) => qualityPass).length;
  return {
    curves,
    fingerprints,
    curveCount: labels.length,
    timepointCount: times.length,
    metadataJoinCount: curves.length,
    conditionCount: byCondition.size,
    sourceQuality: { pass: qualityPassCount, fail: curves.length - qualityPassCount },
    eligibleConditionCount,
  };
}

function observationsForCohort(cohort, trainingLabels) {
  const training = new Set(trainingLabels);
  return cohort.curves.flatMap((curve) => curve.points.map(({ timeHours, value }, index) => ({
    observationId: `${curve.label}|${timeHours}`,
    seriesId: curve.label,
    independentUnitId: curve.label,
    role: training.has(curve.label) ? "training" : "development",
    timeHours,
    drugId: "none",
    concentrationMgPerL: 0,
    measurementType: "od600",
    value,
    censoring: "none",
    censoringBounds: null,
    replicate: curve.label,
    conditions: { conditionId: cohort.conditionId },
    pointIndex: index,
  })));
}

async function normalizedCohort(cohort, trainingLabels, datasetId) {
  const observations = observationsForCohort(cohort, trainingLabels);
  const result = normalizeObservationDataset({
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: {
      datasetId,
      title: "Authoritative untreated BW25113 direct OD600 curves",
      sourceIds: [SOURCE_METADATA.datasetDoi, SOURCE_METADATA.articleDoi],
      conditions: { conditionId: cohort.conditionId, measurementType: "raw OD600" },
    },
    observations: observations.map(({ pointIndex, ...row }) => row),
  });
  const dataset = result.dataset ?? result;
  return { dataset, split: await createDatasetSplit(dataset), observations };
}

export function growthComparisonOptions(normalized, overrides = {}) {
  const options = {
    dataset: normalized.dataset,
    split: normalized.split,
    seed: overrides.seed ?? 3817,
    bounds: structuredClone(BOUNDS),
    optimizer: structuredClone(overrides.optimizer ?? OPTIMIZER),
    bootstrap: { samples: 0, intervalLevel: 0.95 },
    runtime: { yieldControl: async () => {} },
  };
  if (overrides.folds) options.crossValidation = { folds: overrides.folds };
  return options;
}

function rmseFor(rows) {
  return Math.sqrt(rows.reduce((sum, row) => sum + row.residual ** 2, 0) / rows.length);
}

function developmentScores(predictions) {
  const grouped = new Map();
  for (const prediction of predictions) {
    if (!grouped.has(prediction.independentUnitId)) grouped.set(prediction.independentUnitId, []);
    grouped.get(prediction.independentUnitId).push(prediction);
  }
  const perCurve = [...grouped].map(([curveLabel, rows]) => ({ curveLabel, rmse: rmseFor(rows) }));
  return {
    perCurve,
    macroRmse: perCurve.reduce((sum, row) => sum + row.rmse, 0) / perCurve.length,
    pooledRmse: rmseFor([...grouped.values()].flat()),
  };
}

function summarizeRun(cohort, result) {
  const selectedPredictions = result.development.selected.predictions;
  const baselinePredictions = result.development.baseline.predictions;
  const prediction = result.trajectoryPrediction;
  const levelCoverage = Object.fromEntries(Object.entries(prediction.bands).map(([level, band]) => {
    if (band.status !== "available") return [level, { status: band.status, count: 0, coverage: null }];
    const byTime = new Map(band.predictions.map((row) => [row.timeHours, row]));
    const developmentRows = result.development.selected.predictions;
    const covered = developmentRows.filter((row) => {
      const interval = byTime.get(row.timeHours);
      return interval && row.observed >= interval.lower && row.observed <= interval.upper;
    }).length;
    const completeCurves = new Map();
    for (const row of developmentRows) {
      const interval = byTime.get(row.timeHours);
      if (!completeCurves.has(row.independentUnitId)) completeCurves.set(row.independentUnitId, true);
      if (!interval || row.observed < interval.lower || row.observed > interval.upper) completeCurves.set(row.independentUnitId, false);
    }
    return [level, {
      status: band.status,
      radius: band.radius,
      pointCount: developmentRows.length,
      pointCoverage: covered / developmentRows.length,
      completeTrajectoryCount: completeCurves.size,
      completeTrajectoryCoverage: [...completeCurves.values()].filter(Boolean).length / completeCurves.size,
      calibrationCount: prediction.calibration.calibrationUnitCount ?? 0,
    }];
  }));
  return {
    conditionId: cohort.conditionId,
    timepointCount: cohort.timeHours.length,
    trainingTrajectoryCount: result.dataset.trainingIndependentUnitIds.length,
    developmentTrajectoryCount: result.development.independentUnitIds.length,
    selectedModel: result.selection.selectedModel,
    candidates: Object.fromEntries(Object.entries(result.crossValidation.candidates).map(([id, row]) => [id, {
      eligible: row.eligible,
      macroRmse: row.score,
    }])),
    development: {
      selected: developmentScores(selectedPredictions),
      trainingMean: developmentScores(baselinePredictions),
    },
    trajectoryPrediction: {
      status: prediction.status,
      model: prediction.fit.model,
      calibrationCount: prediction.calibration.calibrationUnitCount ?? 0,
      bands: levelCoverage,
    },
    warningCodes: result.warnings.map(({ code }) => code).sort(),
  };
}

function foldsOfEight(labels) {
  assert(labels.length === 48, "The large cohort training set must contain 48 trajectories.");
  return Array.from({ length: 6 }, (_, fold) => labels.filter((_, index) => index % 6 === fold));
}

async function runCohort(cohort, trainingCount, datasetId, options = {}) {
  const labels = cohort.curves.map(({ label }) => label);
  const roleSplit = options.trainingLabels
    ? { training: [...options.trainingLabels].sort(compareText), development: labels.filter((label) => !options.trainingLabels.includes(label)).sort(compareText) }
    : splitCurveLabels(labels, trainingCount, options.seed ?? 3817, datasetId);
  assert(roleSplit.training.length === trainingCount && roleSplit.training.every((label) => labels.includes(label))
    && roleSplit.development.length === labels.length - trainingCount
    && roleSplit.development.every((label) => labels.includes(label)), "Role assignment must cover the cohort without overlap.");
  const trainingLabels = roleSplit.training;
  const folds = options.folds ?? trainingLabels.map((label) => [label]);
  const foldByLabel = new Map(folds.flatMap((ids, index) => ids.map((label) => [label, index + 1])));
  const normalized = await normalizedCohort(cohort, trainingLabels, datasetId);
  const runOptions = growthComparisonOptions(normalized, { ...options, folds });
  const result = await runGrowthModelComparison(runOptions);
  return { normalized, result, summary: summarizeRun(cohort, result), trainingLabels,
    developmentLabels: roleSplit.development, foldByLabel };
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function csv(rows, headers) {
  return [headers.map(csvCell).join(","), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(","))].join("\n") + "\n";
}

function serializeRun(run, cohortKind, cohortIndex = "") {
  return run.normalized.observations.map(({ pointIndex, ...row }) => ({
    cohortKind,
    cohortIndex,
    conditionId: run.summary.conditionId,
    curveLabel: row.independentUnitId,
    role: row.role,
    timeHours: row.timeHours,
    value: row.value,
    foldId: row.role === "training" ? run.foldByLabel.get(row.independentUnitId) : "",
  }));
}

async function writeOutputs(outputDirectory, source, conditionRuns, largeRun) {
  await mkdir(outputDirectory, { recursive: true });
  const observations = [
    ...conditionRuns.flatMap((run, index) => serializeRun(run, "condition", index + 1)),
    ...serializeRun(largeRun, "large_condition"),
  ];
  const scoreRows = [];
  const trajectoryRows = [];
  for (const run of [...conditionRuns, largeRun]) {
    const summary = run.summary;
    for (const [model, candidate] of Object.entries(summary.candidates)) {
      scoreRows.push({
        conditionId: summary.conditionId,
        model,
        cvMacroRmse: candidate.macroRmse,
        selectedModel: summary.selectedModel,
        selectedHeldoutMacroRmse: summary.development.selected.macroRmse,
        selectedHeldoutPooledRmse: summary.development.selected.pooledRmse,
        trainingMeanHeldoutMacroRmse: summary.development.trainingMean.macroRmse,
      });
    }
    for (const row of summary.development.selected.perCurve) {
      trajectoryRows.push({ conditionId: summary.conditionId, model: summary.selectedModel, curveLabel: row.curveLabel, rmse: row.rmse });
    }
  }
  const scoreCsv = csv(scoreRows, ["conditionId", "model", "cvMacroRmse", "selectedModel", "selectedHeldoutMacroRmse", "selectedHeldoutPooledRmse", "trainingMeanHeldoutMacroRmse"]);
  const trajectoryCsv = csv(trajectoryRows, ["conditionId", "model", "curveLabel", "rmse"]);
  const observationsCsv = csv(observations, ["cohortKind", "cohortIndex", "conditionId", "curveLabel", "role", "timeHours", "value", "foldId"]);
  const report = {
    schemaVersion: "1.0.0",
    source: {
      dataset: SOURCE_METADATA.datasetDoi,
      article: SOURCE_METADATA.articleDoi,
      title: SOURCE_METADATA.title,
      license: SOURCE_METADATA.license.id,
      verifiedFiles: source.fingerprints,
      curveCount: source.curveCount,
      metadataJoinCount: source.metadataJoinCount,
      uniqueConditionCount: source.conditionCount,
      sourceQualityFlagCounts: source.sourceQuality,
      eligibleConditionCountExcludingLargeCohort: source.eligibleConditionCount,
      sourceTimepointCount: source.timepointCount,
    },
    selection: {
      method: "source-quality-passing curves; condition IDs evenly spaced after minimum shared time support; exact curves are retained in the adjacent CSV",
      selectedConditionIds: conditionRuns.map(({ summary }) => summary.conditionId),
      cohortCounts: { conditions: conditionRuns.length, trajectoriesPerCondition: 12, trainingPerCondition: 8, developmentPerCondition: 4, sharedTimepointsPerCondition: 48 },
      splitMethod: "deterministic seeded random assignment of whole curves before fitting",
      largeCondition: { conditionId: largeRun.summary.conditionId, excludedPreviouslyAnalyzedLabels: [...EXCLUDED_PREVIOUSLY_ANALYZED_LABELS], training: 48, development: 12, sharedTimepoints: largeRun.summary.timepointCount },
    },
    configuration: {
      seed: 3817,
      bounds: BOUNDS,
      optimizer: OPTIMIZER,
      independentUnit: "complete curve",
      conditionCohortTimeSupportHours: [0.5, 24],
      largeConditionTimeSupportHours: [0.5, 18],
    },
    conditionResults: conditionRuns.map(({ summary }) => summary),
    largeConditionResult: largeRun.summary,
    outputs: { observationsCsv: "observations.csv", modelScoresCsv: "model-scores.csv", heldoutTrajectoriesCsv: "heldout-trajectories.csv" },
  };
  await Promise.all([
    writeFile(path.join(outputDirectory, "observations.csv"), observationsCsv),
    writeFile(path.join(outputDirectory, "model-scores.csv"), scoreCsv),
    writeFile(path.join(outputDirectory, "heldout-trajectories.csv"), trajectoryCsv),
    writeFile(path.join(outputDirectory, "ecolab-results.json"), `${JSON.stringify({
      ...report,
      outputs: {
        observationsCsv: "observations.csv",
        observationsCsvSha256: createHash("sha256").update(observationsCsv).digest("hex"),
        modelScoresCsv: "model-scores.csv",
        modelScoresCsvSha256: createHash("sha256").update(scoreCsv).digest("hex"),
        heldoutTrajectoriesCsv: "heldout-trajectories.csv",
        heldoutTrajectoriesCsvSha256: createHash("sha256").update(trajectoryCsv).digest("hex"),
      },
    }, null, 2)}\n`),
  ]);
  return report;
}

export async function runExpandedBenchmark(options = {}) {
  const sourceDirectory = path.resolve(options.sourceDirectory
    ?? path.join(projectRoot, "data/raw/figshare-bw25113-growth-v1"));
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(projectRoot, "tmp/bw25113-expanded-benchmark"));
  const source = await readVerifiedSource(sourceDirectory);
  const cohorts = selectEligibleConditionCohorts(source.curves, {
    conditionsToSelect: SELECTED_CONDITION_IDS.length,
    replicateCount: 12,
    minimumCommonTimepoints: 48,
    excludedConditionIds: [LARGE_COHORT.conditionId],
    excludedLabels: [...EXCLUDED_PREVIOUSLY_ANALYZED_LABELS],
  });
  assert(cohorts.every((cohort, index) => cohort.conditionId === SELECTED_CONDITION_IDS[index]),
    "Source data no longer match the predeclared evenly spaced condition cohort.");
  const conditionRuns = [];
  for (const cohort of cohorts) {
    conditionRuns.push(await runCohort(cohort, 8, `bw25113-${cohort.conditionId.toLowerCase()}`));
  }

  const largeCandidates = source.curves
    .filter((curve) => curve.conditionId === LARGE_COHORT.conditionId
      && curve.qualityPass && !EXCLUDED_PREVIOUSLY_ANALYZED_LABELS.has(curve.label))
    .sort((left, right) => compareText(left.label, right.label));
  assert(largeCandidates.length >= LARGE_COHORT.trainingCount + LARGE_COHORT.developmentCount,
    "The large-condition cohort no longer has enough source-quality-passing curves.");
  const sufficientSupport = largeCandidates.filter((curve) => curve.points.length >= 36);
  const largeCurves = selectEvenlySpaced(sufficientSupport,
    LARGE_COHORT.trainingCount + LARGE_COHORT.developmentCount);
  assert(largeCurves.length === LARGE_COHORT.trainingCount + LARGE_COHORT.developmentCount,
    "The large-condition cohort does not have enough trajectories with a shared 36-point grid.");
  const largeTimes = commonTimes(largeCurves).slice(0, 36);
  const largeCohort = {
    conditionId: LARGE_COHORT.conditionId,
    timeHours: largeTimes,
    curves: largeCurves.map((curve) => ({
      ...curve,
      points: curve.points.filter(({ timeHours }) => largeTimes.includes(timeHours)),
    })),
  };
  const roleSplit = splitCurveLabels(largeCohort.curves.map(({ label }) => label),
    LARGE_COHORT.trainingCount, 3817, "bw25113-cond00003-large-cohort");
  const largeRun = await runCohort(largeCohort, LARGE_COHORT.trainingCount,
    "bw25113-cond00003-large-cohort", {
      trainingLabels: roleSplit.training,
      folds: foldsOfEight(roleSplit.training),
    });
  assert(largeRun.summary.trainingTrajectoryCount === 48 && largeRun.summary.developmentTrajectoryCount === 12,
    "The large-condition split must contain 48 training and 12 development trajectories.");
  const report = await writeOutputs(outputDirectory, source, conditionRuns, largeRun);
  return { outputDirectory, report };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--source-dir" || flag === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path.`);
      if (flag === "--source-dir") options.sourceDirectory = value;
      else options.outputDirectory = value;
      index += 1;
    } else if (flag === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/benchmarks/validate-bw25113-expanded.js [--source-dir PATH] [--output-dir PATH]");
    } else {
      const result = await runExpandedBenchmark(options);
      console.log(JSON.stringify({ outputDirectory: result.outputDirectory, selectedConditionIds: result.report.selection.selectedConditionIds,
        conditionResults: result.report.conditionResults.map(({ conditionId, selectedModel, development }) => ({
          conditionId, selectedModel, macroRmse: development.selected.macroRmse,
        })),
        largeCondition: result.report.largeConditionResult,
      }, null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
