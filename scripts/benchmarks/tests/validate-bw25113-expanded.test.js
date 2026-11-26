import test from "node:test";
import assert from "node:assert/strict";

function curve(label, conditionId, qualityPass, pointCount) {
  return {
    label,
    conditionId,
    qualityPass,
    points: Array.from({ length: pointCount }, (_, index) => ({
      timeHours: (index + 1) / 2,
      value: index / 100,
    })),
  };
}

test("condition selection is evenly spaced, source-quality filtered, and requires common time support", async () => {
  const module = await import("../validate-bw25113-expanded.js").catch(() => ({}));
  assert.equal(typeof module.selectEligibleConditionCohorts, "function");

  const curves = [
    curve("Curve00001", "Cond00001", true, 50),
    curve("Curve00002", "Cond00001", true, 48),
    curve("Curve00003", "Cond00001", false, 50),
    curve("Curve00004", "Cond00002", true, 47),
    curve("Curve00005", "Cond00002", true, 47),
    curve("Curve00006", "Cond00003", true, 50),
    curve("Curve00007", "Cond00003", true, 50),
    curve("Curve00008", "Cond00004", true, 48),
    curve("Curve00009", "Cond00004", true, 50),
    curve("Curve00010", "Cond00005", true, 48),
    curve("Curve00011", "Cond00005", true, 50),
  ];

  const cohorts = module.selectEligibleConditionCohorts(curves, {
    conditionsToSelect: 2,
    replicateCount: 2,
    minimumCommonTimepoints: 48,
    excludedConditionIds: ["Cond00003"],
  });

  assert.deepEqual(cohorts.map(({ conditionId }) => conditionId), ["Cond00001", "Cond00005"]);
  for (const cohort of cohorts) {
    assert.equal(cohort.curves.length, 2);
    assert.equal(cohort.timeHours.length, 48);
    assert.ok(cohort.curves.every(({ qualityPass }) => qualityPass));
    assert.ok(cohort.curves.every(({ points }) => points.length === cohort.timeHours.length));
  }
});

test("growth comparison options pass only the normalized dataset and supported configuration", async () => {
  const module = await import("../validate-bw25113-expanded.js");
  assert.equal(typeof module.growthComparisonOptions, "function");
  const normalized = {
    dataset: { kind: "observation-dataset" },
    split: { kind: "observation-dataset-split" },
    observations: [{ value: 1 }],
  };
  const result = module.growthComparisonOptions(normalized, { seed: 17 });
  assert.deepEqual(Object.keys(result).sort(), ["bootstrap", "bounds", "dataset", "optimizer", "runtime", "seed", "split"]);
  assert.equal(result.dataset, normalized.dataset);
  assert.equal(result.split, normalized.split);
  assert.equal(result.seed, 17);
});

test("evenly spaced sampling spans the full ordered cohort deterministically", async () => {
  const module = await import("../validate-bw25113-expanded.js");
  assert.equal(typeof module.selectEvenlySpaced, "function");
  assert.deepEqual(module.selectEvenlySpaced(["a", "b", "c", "d", "e", "f", "g"], 3), ["a", "d", "g"]);
  assert.deepEqual(module.selectEvenlySpaced(["a", "b", "c", "d", "e", "f", "g"], 1), ["d"]);
  assert.throws(() => module.selectEvenlySpaced(["a"], 2), /at least 2/);
});

test("curve-level role assignment is deterministic, complete, and non-overlapping", async () => {
  const module = await import("../validate-bw25113-expanded.js");
  assert.equal(typeof module.splitCurveLabels, "function");
  const labels = Array.from({ length: 12 }, (_, index) => `Curve${String(index + 1).padStart(5, "0")}`);
  const first = module.splitCurveLabels(labels, 8, 3817, "Cond00042");
  const second = module.splitCurveLabels(labels, 8, 3817, "Cond00042");
  assert.deepEqual(first, second);
  assert.equal(first.training.length, 8);
  assert.equal(first.development.length, 4);
  assert.equal(new Set([...first.training, ...first.development]).size, labels.length);
  assert.deepEqual([...first.training, ...first.development].sort(), labels.sort());
  assert.throws(() => module.splitCurveLabels(labels, 0, 3817, "Cond00042"), /trainingCount/);
});
