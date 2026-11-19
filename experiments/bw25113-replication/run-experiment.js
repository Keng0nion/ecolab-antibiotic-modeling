// Independent replication of the published maximum growth rate (r) and carrying capacity (K)
// for Escherichia coli BW25113 in the chemically defined medium Cond00003, and the implied
// doubling time compared with the literature anchor for BW25113 (BioNumbers 111767 /
// Campos et al. 2014, 42 +/- 12 min in supplemented M9, single cell).
//
// Sources:
// - bundled normalized dataset  : data/datasets/figshare-bw25113-growth-v1 (figshare 28342064, CC BY 4.0)
// - reference K/r values        : derived/reference-values.json (extract-reference.py)
// - background evidence          : derived/background-evidence.json (extract-reference.py)
//
// Pipeline, in the authors' own definitions (Aida & Ying 2025, Scientific Data, Methods):
//   net C_i = OD_i - background;  mu_j = ln(C_j / C_(j-1)) / (t_j - t_(j-1));
//   r = mean of the three consecutive mu around the maximum mu;
//   K = mean of the three consecutive net values around the maximum net value.
// The background was NOT deposited, so this experiment runs three pre-declared scenarios:
//   high = early plateau mean (background plus initial cells),
//   mid  = high - 0.002 OD, low = high - 0.004 OD
// (1:1000 inoculation of an overnight culture contributes at most about 0.004 OD600).
//
// Usage: node run-experiment.js   (after: python3 extract-reference.py)

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeObservationDataset } from "../../src/analysis/dataset-import.js";
import { createRandom, deriveSeed, RNG_ALGORITHM } from "../../src/analysis/random.js";
import { quantileR7 } from "../../src/analysis/monte-carlo.js";

const HERE = new URL(".", import.meta.url);
const ROOT = new URL("../../", HERE);

const DATASET_PATH = new URL("data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json", ROOT);
const EXPECTED_DATASET_SHA256 = "67b5fc2757073f92832a9c2cc575324eb91f54dd3621c3e5c2cfb335f8f03817";

const PLATEAU_WINDOW_HOURS = Object.freeze([0.5, 5.0]);
const INITIAL_CELL_UNCERTAINTY_OD = 0.004;
const SCENARIOS = Object.freeze([
  { id: "high", offset: 0 },
  { id: "mid", offset: -0.002 },
  { id: "low", offset: -0.004 },
]);
const ROBUST_NET_WINDOW = Object.freeze([0.02, 0.12]);
const MIN_ROBUST_POINTS = 4;
const BOOTSTRAP_SAMPLES = 10000;
const BOOTSTRAP_SEED = deriveSeed(20261113, "ecolab-bw25113-replication-v1");
const OD_QUANTUM = 0.001;
const NET_EPSILON = 1e-9; // drop floating-point residue at the quantum-zero boundary
const LITERATURE_ANCHOR_MINUTES = Object.freeze({ value: 42, uncertainty: 12 });

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleSd(values) {
  if (values.length < 2) return null;
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

function pearson(xs, ys) {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - mx) * (ys[index] - my);
    sxx += (xs[index] - mx) ** 2;
    syy += (ys[index] - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}

function consecutiveLogSlopes(net, times) {
  const slopes = [];
  for (let index = 1; index < net.length; index += 1) {
    if (net[index] > NET_EPSILON && net[index - 1] > NET_EPSILON) {
      slopes.push({
        index,
        slope: Math.log(net[index] / net[index - 1]) / (times[index] - times[index - 1]),
        t1: times[index - 1],
        t2: times[index],
        netIncrementQuanta: (net[index] - net[index - 1]) / OD_QUANTUM,
      });
    }
  }
  return slopes;
}

// "r was calculated from three continuous slopes, where the maximum slope of the growth
// curve was in the middle" (Aida & Ying 2025, Eq. 2.2). Edge maxima are shifted inward so
// the window still contains three slopes whenever available.
function paperGrowthRate(net, times) {
  const slopes = consecutiveLogSlopes(net, times);
  if (slopes.length === 0) return null;
  let maxIndex = 0;
  for (let index = 1; index < slopes.length; index += 1) {
    if (slopes[index].slope > slopes[maxIndex].slope) maxIndex = index;
  }
  const start = Math.max(0, Math.min(maxIndex - 1, slopes.length - 3));
  const window = slopes.slice(start, start + 3);
  const rLn = mean(window.map((entry) => entry.slope));

  // Robust variant of the same sentence: instead of centering the window on the single
  // maximum pair slope (unstable when +/-1 quantum wiggles reach 1.39/h), take the maximum
  // of the sliding three-slope window averages.
  let centeredWindowMax = null;
  if (slopes.length >= 3) {
    let bestStart = 0;
    let bestAverage = -Infinity;
    for (let candidate = 0; candidate <= slopes.length - 3; candidate += 1) {
      const average = mean([slopes[candidate].slope, slopes[candidate + 1].slope, slopes[candidate + 2].slope]);
      if (average > bestAverage) {
        bestAverage = average;
        bestStart = candidate;
      }
    }
    centeredWindowMax = { rLn: bestAverage, centerPairHours: [slopes[bestStart + 1].t1, slopes[bestStart + 1].t2] };
  }

  return {
    rLn,
    rLog10: rLn / Math.LN10,
    rCenteredWindowMax: centeredWindowMax,
    slopesUsed: window.length,
    peakPairHours: [slopes[maxIndex].t1, slopes[maxIndex].t2],
    peakSlopeLn: slopes[maxIndex].slope,
    peakPairIncrementQuanta: slopes[maxIndex].netIncrementQuanta,
  };
}

// "K was calculated from three continuous OD600 values, where the maximum OD600 of the
// growth curve was in the middle" (Aida & Ying 2025, Eq. 1).
function paperCarryingCapacity(net) {
  let maxIndex = 0;
  for (let index = 1; index < net.length; index += 1) {
    if (net[index] > net[maxIndex]) maxIndex = index;
  }
  const from = Math.max(0, maxIndex - 1);
  const to = Math.min(net.length - 1, maxIndex + 1);
  return { k: mean(net.slice(from, to + 1)), peakIndex: maxIndex, windowLength: to - from + 1 };
}

// Model-free companion estimate: ordinary least squares slope of ln(net) against time over
// the pre-declared net-signal band [0.02, 0.12] OD, far above the 0.001 OD quantization.
function windowedLogSlope(net, times, lo, hi) {
  const points = [];
  for (let index = 0; index < net.length; index += 1) {
    if (net[index] >= lo && net[index] <= hi) points.push(index);
  }
  if (points.length < MIN_ROBUST_POINTS) return null;
  const xs = points.map((index) => times[index]);
  const ys = points.map((index) => Math.log(net[index]));
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sxy += (xs[index] - mx) * (ys[index] - my);
    sxx += (xs[index] - mx) ** 2;
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let sse = 0;
  let sst = 0;
  for (let index = 0; index < xs.length; index += 1) {
    sse += (ys[index] - (intercept + slope * xs[index])) ** 2;
    sst += (ys[index] - my) ** 2;
  }
  const se = Math.sqrt(sse / (xs.length - 2) / sxx);
  return {
    slopePerHour: slope,
    standardError: se,
    r2: sst === 0 ? null : 1 - sse / sst,
    points: xs.length,
    timeRangeHours: [xs[0], xs[xs.length - 1]],
    netRangeOd: [net[points[0]], net[points[points.length - 1]]],
  };
}

function doublingMinutes(ratePerHour) {
  return (Math.LN2 / ratePerHour) * 60;
}

async function main() {
  const datasetText = await readFile(DATASET_PATH, "utf8");
  const datasetSha256 = createHash("sha256").update(datasetText).digest("hex");
  if (datasetSha256 !== EXPECTED_DATASET_SHA256) {
    throw new Error(`bundled dataset hash mismatch: ${datasetSha256}`);
  }
  const dataset = normalizeObservationDataset(JSON.parse(datasetText));

  const reference = JSON.parse(await readFile(new URL("derived/reference-values.json", HERE), "utf8"));
  const referenceByLabel = new Map(reference.curves.map((entry) => [entry.label, entry]));

  const curvesBySeries = new Map();
  for (const observation of dataset.observations) {
    if (!curvesBySeries.has(observation.seriesId)) curvesBySeries.set(observation.seriesId, []);
    curvesBySeries.get(observation.seriesId).push(observation);
  }

  const perCurve = [];
  for (const [seriesId, observations] of [...curvesBySeries.entries()].sort()) {
    const label = seriesId.split("|")[0];
    const points = observations
      .map((observation) => ({ timeHours: observation.timeHours, od: observation.value }))
      .sort((a, b) => a.timeHours - b.timeHours);
    const times = points.map((point) => point.timeHours);
    const raw = points.map((point) => point.od);

    const plateauValues = points
      .filter((point) => point.timeHours >= PLATEAU_WINDOW_HOURS[0] && point.timeHours <= PLATEAU_WINDOW_HOURS[1])
      .map((point) => point.od);
    const baselineHigh = mean(plateauValues);

    const byScenario = {};
    for (const scenario of SCENARIOS) {
      const background = baselineHigh + scenario.offset;
      const net = raw.map((value) => value - background);
      byScenario[scenario.id] = {
        background,
        rate: paperGrowthRate(net, times),
        carryingCapacity: paperCarryingCapacity(net),
        robust: windowedLogSlope(net, times, ROBUST_NET_WINDOW[0], ROBUST_NET_WINDOW[1]),
      };
    }

    const referenceEntry = referenceByLabel.get(label) ?? null;
    perCurve.push({
      label,
      seriesId,
      role: observations[0].role,
      baselinePlateauMean: baselineHigh,
      byScenario,
      reference: referenceEntry
        ? { k: referenceEntry.K, r: referenceEntry.r, kInfo: referenceEntry.kInfo, rInfo: referenceEntry.rInfo }
        : null,
    });
  }

  // --- comparison against the deposited reference values ---------------------
  const comparisonFor = (field) => {
    const stats = {};
    for (const scenario of SCENARIOS) {
      const deltas = [];
      const relative = [];
      for (const curve of perCurve) {
        const replicated = field === "r" ? curve.byScenario[scenario.id].rate?.rLn : curve.byScenario[scenario.id].carryingCapacity.k;
        const referenceValue = field === "r" ? curve.reference?.r : curve.reference?.k;
        if (replicated === null || replicated === undefined || referenceValue === null || referenceValue === undefined) continue;
        deltas.push(replicated - referenceValue);
        if (referenceValue !== 0) relative.push(((replicated - referenceValue) / referenceValue) * 100);
      }
      stats[scenario.id] = {
        pairedCount: deltas.length,
        meanDelta: mean(deltas),
        sdDelta: sampleSd(deltas),
        meanAbsoluteRelativePercent: mean(relative.map(Math.abs)),
        maxAbsoluteRelativePercent: Math.max(...relative.map(Math.abs)),
        minRelativePercent: Math.min(...relative),
        maxRelativePercent: Math.max(...relative),
      };
    }
    return stats;
  };

  const referenceR = perCurve.map((curve) => curve.reference.r);
  const referenceK = perCurve.map((curve) => curve.reference.k);
  const midR = perCurve.map((curve) => curve.byScenario.mid.rate.rLn);
  const midK = perCurve.map((curve) => curve.byScenario.mid.carryingCapacity.k);

  const tdPaper = referenceR.map((value) => doublingMinutes(value));
  const tdRobustMid = perCurve.map((curve) => doublingMinutes(curve.byScenario.mid.robust.slopePerHour));
  const tdRobustRange = perCurve.map((curve) => {
    const values = SCENARIOS
      .map((scenario) => curve.byScenario[scenario.id].robust)
      .filter((entry) => entry !== null)
      .map((entry) => doublingMinutes(entry.slopePerHour));
    return [Math.min(...values), Math.max(...values)];
  });

  // --- quantization diagnostics ---------------------------------------------
  const quantaAtPeak = perCurve.map((curve) => curve.byScenario.mid.rate.peakPairIncrementQuanta);
  const diagnostics = {
    distinctReplicatedR: new Set(midR.map((value) => value.toPrecision(12))).size,
    distinctReferenceR: new Set(referenceR.map((value) => value.toPrecision(12))).size,
    curvesWithSmallPeakIncrement: quantaAtPeak.filter((value) => Math.abs(value) <= 3).length,
    medianPeakIncrementQuanta: quantileR7([...quantaAtPeak].sort((a, b) => a - b), 0.5),
    peakPairHoursMid: perCurve.map((curve) => curve.byScenario.mid.rate.peakPairHours),
    logBaseCheck: {
      meanAbsoluteRelativePercentLn: mean(midR.map((value, index) => Math.abs(((value - referenceR[index]) / referenceR[index]) * 100))),
      meanAbsoluteRelativePercentLog10: mean(midR.map((value, index) => Math.abs(((value / Math.LN10 - referenceR[index]) / referenceR[index]) * 100))),
    },
  };

  // --- seeded bootstrap over the twelve wells -------------------------------
  const random = createRandom(BOOTSTRAP_SEED);
  const bootstrap = { rMid: [], tdRobustMid: [], kMid: [] };
  for (let sample = 0; sample < BOOTSTRAP_SAMPLES; sample += 1) {
    const draw = Array.from({ length: perCurve.length }, () => Math.floor(random.next() * perCurve.length));
    bootstrap.rMid.push(mean(draw.map((index) => midR[index])));
    bootstrap.tdRobustMid.push(mean(draw.map((index) => tdRobustMid[index])));
    bootstrap.kMid.push(mean(draw.map((index) => midK[index])));
  }
  const summarizeBootstrap = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { mean: mean(values), ci95: [quantileR7(sorted, 0.025), quantileR7(sorted, 0.975)] };
  };

  // --- role groups ----------------------------------------------------------
  const roleSummary = (role) => {
    const curves = perCurve.filter((curve) => curve.role === role);
    return {
      curves: curves.length,
      meanRmid: mean(curves.map((curve) => curve.byScenario.mid.rate.rLn)),
      meanTdRobustMidMinutes: mean(curves.map((curve) => doublingMinutes(curve.byScenario.mid.robust.slopePerHour))),
      meanKmid: mean(curves.map((curve) => curve.byScenario.mid.carryingCapacity.k)),
    };
  };

  const results = {
    meta: {
      description: "Independent replication of Aida & Ying (2025) Cond00003 K and r for BW25113",
      rng: RNG_ALGORITHM,
      bootstrapSeed: BOOTSTRAP_SEED,
    },
    config: {
      plateauWindowHours: PLATEAU_WINDOW_HOURS,
      initialCellUncertaintyOd: INITIAL_CELL_UNCERTAINTY_OD,
      scenarios: SCENARIOS,
      robustNetWindowOd: ROBUST_NET_WINDOW,
      bootstrapSamples: BOOTSTRAP_SAMPLES,
      odQuantum: OD_QUANTUM,
    },
    dataset: { sha256: datasetSha256, curves: perCurve.length },
    reference: { sha256: reference.inputs["BW25113_GrowthDataEvaluation.xlsx"] },
    perCurve,
    comparisons: { r: comparisonFor("r"), k: comparisonFor("k") },
    correlations: {
      rMidVsReference: pearson(midR, referenceR),
      kMidVsReference: pearson(midK, referenceK),
    },
    doublingTimes: {
      paperImpliedMinutes: { mean: mean(tdPaper), sd: sampleSd(tdPaper), min: Math.min(...tdPaper), max: Math.max(...tdPaper) },
      robustMidMinutes: { mean: mean(tdRobustMid), sd: sampleSd(tdRobustMid), min: Math.min(...tdRobustMid), max: Math.max(...tdRobustMid) },
      robustScenarioRangeMinutes: [Math.min(...tdRobustRange.map((pair) => pair[0])), Math.max(...tdRobustRange.map((pair) => pair[1]))],
      centeredWindowMaxMinutes: {
        mean: mean(perCurve.map((curve) => doublingMinutes(curve.byScenario.mid.rate.rCenteredWindowMax.rLn))),
        sd: sampleSd(perCurve.map((curve) => doublingMinutes(curve.byScenario.mid.rate.rCenteredWindowMax.rLn))),
      },
      literatureAnchor: LITERATURE_ANCHOR_MINUTES,
    },
    diagnostics,
    bootstrap: {
      samples: BOOTSTRAP_SAMPLES,
      rMid: summarizeBootstrap(bootstrap.rMid),
      tdRobustMidMinutes: summarizeBootstrap(bootstrap.tdRobustMid),
      kMid: summarizeBootstrap(bootstrap.kMid),
    },
    roles: { training: roleSummary("training"), validation: roleSummary("validation") },
  };

  await writeFile(new URL("derived/results.json", HERE), `${JSON.stringify(results, null, 2)}\n`);

  const csvHeader = [
    "label", "role", "baselinePlateauMean",
    "rLnHigh", "rLnMid", "rLnLow", "rReference", "rCenteredWindowMid", "meanAbsRelPercentMid",
    "kMid", "kReference", "tdPaperMinutes", "tdRobustMidMinutes", "robustR2Mid", "robustPoints",
    "peakPairMid", "peakIncrementQuanta",
  ];
  const csvLines = [csvHeader.join(",")];
  for (const curve of perCurve) {
    const rValues = SCENARIOS.map((scenario) => curve.byScenario[scenario.id].rate.rLn);
    csvLines.push([
      curve.label, curve.role, curve.baselinePlateauMean.toFixed(6),
      ...rValues.map((value) => value.toFixed(6)),
      curve.reference.r.toFixed(6),
      curve.byScenario.mid.rate.rCenteredWindowMax.rLn.toFixed(6),
      Math.abs(((curve.byScenario.mid.rate.rLn - curve.reference.r) / curve.reference.r) * 100).toFixed(2),
      curve.byScenario.mid.carryingCapacity.k.toFixed(6),
      curve.reference.k.toFixed(6),
      doublingMinutes(curve.reference.r).toFixed(3),
      doublingMinutes(curve.byScenario.mid.robust.slopePerHour).toFixed(3),
      curve.byScenario.mid.robust.r2.toFixed(4),
      curve.byScenario.mid.robust.points,
      curve.byScenario.mid.rate.peakPairHours.join("->"),
      curve.byScenario.mid.rate.peakPairIncrementQuanta.toFixed(2),
    ].join(","));
  }
  await writeFile(new URL("derived/per-curve.csv", HERE), `${csvLines.join("\n")}\n`);

  // --- console summary ------------------------------------------------------
  console.log("== 复现实验摘要（Cond00003，12 条曲线）==");
  console.log(`r（作者公布，自然对数假设）: 均值 ${mean(referenceR).toFixed(4)} /h，` +
    `隐含倍增时间 ${results.doublingTimes.paperImpliedMinutes.mean.toFixed(1)} min`);
  console.log(`r（本实验复现，mid 情景）: ${mean(midR).toFixed(4)} /h；` +
    `平均绝对相对偏差 ${results.comparisons.r.mid.meanAbsoluteRelativePercent.toFixed(1)}%，` +
    `范围 ${results.comparisons.r.mid.minRelativePercent.toFixed(1)}% .. ${results.comparisons.r.mid.maxRelativePercent.toFixed(1)}%`);
  console.log(`K（本实验 vs 作者）: ${mean(midK).toFixed(4)} vs ${mean(referenceK).toFixed(4)}；` +
    `平均偏差 ${results.comparisons.k.mid.meanDelta.toFixed(5)} OD，` +
    `平均绝对相对偏差 ${results.comparisons.k.mid.meanAbsoluteRelativePercent.toFixed(2)}%`);
  const cw = perCurve.map((curve) => curve.byScenario.mid.rate.rCenteredWindowMax.rLn);
  const cwRel = cw.map((value, index) => Math.abs(((value - referenceR[index]) / referenceR[index]) * 100));
  console.log(`r（滑窗均值最大变体，mid 情景）: 均值 ${mean(cw).toFixed(4)} /h；` +
    `平均绝对相对偏差 ${mean(cwRel).toFixed(1)}%，最大 ${Math.max(...cwRel).toFixed(1)}%`);
  console.log(`中高信号窗（净信号 0.02..0.12 OD）斜率 → 倍增时间 ` +
    `${results.doublingTimes.robustMidMinutes.mean.toFixed(1)} min ` +
    `(95% CI ${results.bootstrap.tdRobustMidMinutes.ci95.map((v) => v.toFixed(1)).join(" .. ")})`);
  console.log(`背景情景敏感性: r 相对偏差范围 ` +
    `${Math.min(...SCENARIOS.map((s) => results.comparisons.r[s.id].minRelativePercent)).toFixed(1)}% .. ` +
    `${Math.max(...SCENARIOS.map((s) => results.comparisons.r[s.id].maxRelativePercent)).toFixed(1)}%`);
  console.log(`峰斜率落在时段: ${diagnostics.peakPairHoursMid.map((p) => p.join("-")).join(", ")}`);
  console.log(`r 离散值: 复现 ${diagnostics.distinctReplicatedR}/12，作者 ${diagnostics.distinctReferenceR}/12；` +
    `${diagnostics.curvesWithSmallPeakIncrement}/12 条曲线的峰对增量 ≤ 3 个量化步`);
  console.log(`对数底核对: 自然对数平均绝对偏差 ${diagnostics.logBaseCheck.meanAbsoluteRelativePercentLn.toFixed(1)}% vs ` +
    `log10 ${diagnostics.logBaseCheck.meanAbsoluteRelativePercentLog10.toFixed(1)}%`);
  console.log("已写出 derived/results.json 与 derived/per-curve.csv");
}

await main();
