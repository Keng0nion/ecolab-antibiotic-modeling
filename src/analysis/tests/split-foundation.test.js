import test from "node:test";
import assert from "node:assert/strict";
import {
  assertNoSplitOverlap,
  assignSplitRolesByIndependentUnit,
  createDatasetSplit,
  validateDatasetSplit,
} from "../split.js";

function observation(id, unitId, role, timeHours = 0) {
  return {
    observationId: id,
    seriesId: `series-${unitId}`,
    independentUnitId: unitId,
    role,
    timeHours,
    drugId: "none",
    concentrationMgPerL: 0,
    measurementType: "log10_cfu_per_ml",
    value: 6,
    censoring: "none",
    censoringBounds: null,
    replicate: unitId,
    conditions: {
      organism: "Escherichia coli",
      strain: "BW25113",
      medium: "M9",
      temperature: { value: 37, unit: "degC" },
    },
  };
}

function dataset(observations) {
  return {
    schemaVersion: "1.0.0",
    kind: "observation-dataset",
    metadata: { datasetId: "split-dataset", title: "Split dataset" },
    observations,
  };
}

test("declared split groups observations only by independentUnitId and fingerprints the result", async () => {
  const input = dataset([
    observation("o1", "u1", "training", 0),
    observation("o2", "u1", "training", 1),
    observation("o3", "u2", "development", 0),
    observation("o4", "u3", "validation", 0),
  ]);
  const split = await createDatasetSplit(input, { lockedValidation: true });
  assert.deepEqual(split.roles.training.independentUnitIds, ["u1"]);
  assert.deepEqual(split.roles.training.observationIds, ["o1", "o2"]);
  assert.deepEqual(split.roles.development.independentUnitIds, ["u2"]);
  assert.deepEqual(split.roles.validation.independentUnitIds, ["u3"]);
  assert.equal(split.roles.training.independentUnitCount, 1);
  assert.equal(split.roles.training.observationCount, 2);
  assert.match(split.sourceDatasetFingerprint, /^[0-9a-f]{64}$/);
  assert.match(split.splitFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(assertNoSplitOverlap(split), true);
  assert.deepEqual(await validateDatasetSplit(split), { valid: true, errors: [] });
});

test("declared split rejects independent-unit role leakage", async () => {
  const input = dataset([
    observation("o1", "u1", "training"),
    observation("o2", "u1", "validation", 1),
  ]);
  await assert.rejects(() => createDatasetSplit(input), { code: "INDEPENDENT_UNIT_ROLE_LEAKAGE" });
});

test("overlap enforcement rejects the same unit in two role manifests", () => {
  const split = {
    roles: {
      training: { independentUnitIds: ["u1"] },
      development: { independentUnitIds: [] },
      validation: { independentUnitIds: ["u1"] },
    },
  };
  assert.throws(() => assertNoSplitOverlap(split), { code: "SPLIT_OVERLAP" });
});

test("deterministic assignment keeps every independent unit wholly in one role", () => {
  const observations = [];
  for (let unit = 1; unit <= 20; unit += 1) {
    observations.push(observation(`o${unit}-a`, `u${unit}`, "training", 0));
    observations.push(observation(`o${unit}-b`, `u${unit}`, "validation", 1));
  }
  const input = dataset(observations);
  const snapshot = structuredClone(input);
  const options = {
    seed: "fixed-seed",
    ratios: { training: 0.6, development: 0.2, validation: 0.2 },
  };
  const first = assignSplitRolesByIndependentUnit(input, options);
  const second = assignSplitRolesByIndependentUnit(input, options);
  assert.deepEqual(first, second);
  assert.deepEqual(input, snapshot);
  const rolesByUnit = new Map();
  for (const item of first.observations) {
    const roles = rolesByUnit.get(item.independentUnitId) ?? new Set();
    roles.add(item.role);
    rolesByUnit.set(item.independentUnitId, roles);
  }
  assert.ok([...rolesByUnit.values()].every((roles) => roles.size === 1));
  const unitCounts = { training: 0, development: 0, validation: 0 };
  for (const roles of rolesByUnit.values()) unitCounts[[...roles][0]] += 1;
  assert.deepEqual(unitCounts, { training: 12, development: 4, validation: 4 });
});

test("different seeds can produce different unit assignments without splitting a unit", () => {
  const input = dataset(Array.from({ length: 12 }, (_, index) => observation(`o${index}`, `u${index}`, "training")));
  const ratios = { training: 0.5, development: 0.25, validation: 0.25 };
  const left = assignSplitRolesByIndependentUnit(input, { seed: "left", ratios });
  const right = assignSplitRolesByIndependentUnit(input, { seed: "right", ratios });
  assert.notDeepEqual(
    left.observations.map(({ independentUnitId, role }) => [independentUnitId, role]),
    right.observations.map(({ independentUnitId, role }) => [independentUnitId, role]),
  );
});

test("split validation reports fingerprint tampering", async () => {
  const split = await createDatasetSplit(dataset([
    observation("o1", "u1", "training"),
    observation("o2", "u2", "validation"),
  ]));
  const tampered = {
    ...split,
    lockedValidation: !split.lockedValidation,
  };
  const result = await validateDatasetSplit(tampered);
  assert.equal(result.valid, false);
  assert.deepEqual(result.errors.map(({ code }) => code), ["SPLIT_FINGERPRINT_MISMATCH"]);
});

test("duplicate observation IDs and invalid ratios are strictly rejected", async () => {
  const duplicate = dataset([
    observation("o1", "u1", "training"),
    observation("o1", "u2", "validation"),
  ]);
  await assert.rejects(() => createDatasetSplit(duplicate), { code: "DUPLICATE_OBSERVATION_ID" });
  assert.throws(
    () => assignSplitRolesByIndependentUnit(dataset([]), {
      ratios: { training: 0.8, development: 0.2, validation: 0.2 },
    }),
    { code: "INVALID_SPLIT_RATIO_TOTAL" },
  );
});
