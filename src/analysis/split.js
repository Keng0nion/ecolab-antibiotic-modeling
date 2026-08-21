import { fingerprintJson, fingerprintSplit, sha256HexFallback } from "./fingerprint.js";

const ROLES = Object.freeze(["training", "development", "validation"]);
const ROLE_SET = new Set(ROLES);

export class DatasetSplitError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DatasetSplitError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path, actual) {
  throw new DatasetSplitError(code, message, { path, actual });
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertDataset(dataset) {
  if (!isRecord(dataset) || !isRecord(dataset.metadata) || !Array.isArray(dataset.observations)) {
    fail("INVALID_DATASET", "dataset must be a normalized observation dataset.", "dataset", dataset);
  }
  if (typeof dataset.metadata.datasetId !== "string" || dataset.metadata.datasetId.length === 0) {
    fail("INVALID_DATASET_ID", "dataset.metadata.datasetId must be non-empty.", "dataset.metadata.datasetId", dataset.metadata.datasetId);
  }
}

function assertObservationIdentity(observation, index) {
  const path = `dataset.observations[${index}]`;
  if (!isRecord(observation)) fail("INVALID_OBSERVATION", `${path} must be an object.`, path, observation);
  for (const key of ["observationId", "independentUnitId"]) {
    if (typeof observation[key] !== "string" || observation[key].length === 0) {
      fail("INVALID_OBSERVATION_IDENTITY", `${path}.${key} must be non-empty.`, `${path}.${key}`, observation[key]);
    }
  }
  if (!ROLE_SET.has(observation.role)) {
    fail("INVALID_ROLE", `${path}.role is invalid.`, `${path}.role`, observation.role);
  }
}

function groupedUnits(dataset) {
  assertDataset(dataset);
  const units = new Map();
  const observationIds = new Set();
  dataset.observations.forEach((observation, index) => {
    assertObservationIdentity(observation, index);
    if (observationIds.has(observation.observationId)) {
      fail("DUPLICATE_OBSERVATION_ID", `Duplicate observationId: ${observation.observationId}.`, `dataset.observations[${index}].observationId`, observation.observationId);
    }
    observationIds.add(observation.observationId);
    let unit = units.get(observation.independentUnitId);
    if (!unit) {
      unit = { independentUnitId: observation.independentUnitId, roles: new Set(), observationIds: [] };
      units.set(observation.independentUnitId, unit);
    }
    unit.roles.add(observation.role);
    unit.observationIds.push(observation.observationId);
  });
  return units;
}

function roleUnitLists(split) {
  if (!isRecord(split) || !isRecord(split.roles)) {
    fail("INVALID_SPLIT", "split.roles must be an object.", "split.roles", split?.roles);
  }
  const result = {};
  for (const role of ROLES) {
    const roleEntry = split.roles[role];
    if (!isRecord(roleEntry) || !Array.isArray(roleEntry.independentUnitIds)) {
      fail("INVALID_SPLIT_ROLE", `split.roles.${role}.independentUnitIds must be an array.`, `split.roles.${role}.independentUnitIds`, roleEntry);
    }
    result[role] = roleEntry.independentUnitIds;
  }
  return result;
}

/** Reject any independent unit appearing in more than one role. */
export function assertNoSplitOverlap(split) {
  const roleLists = roleUnitLists(split);
  const seen = new Map();
  for (const role of ROLES) {
    const withinRole = new Set();
    for (const unitId of roleLists[role]) {
      if (typeof unitId !== "string" || unitId.length === 0) {
        fail("INVALID_INDEPENDENT_UNIT_ID", `split.roles.${role} contains an invalid independent unit ID.`, `split.roles.${role}.independentUnitIds`, unitId);
      }
      if (withinRole.has(unitId)) {
        fail("DUPLICATE_SPLIT_UNIT", `${unitId} is duplicated within ${role}.`, `split.roles.${role}.independentUnitIds`, unitId);
      }
      withinRole.add(unitId);
      if (seen.has(unitId)) {
        fail("SPLIT_OVERLAP", `${unitId} appears in both ${seen.get(unitId)} and ${role}.`, "split.roles", {
          independentUnitId: unitId,
          roles: [seen.get(unitId), role],
        });
      }
      seen.set(unitId, role);
    }
  }
  return true;
}

function roleEntry(units) {
  const sortedUnits = [...units].sort((left, right) => left.independentUnitId.localeCompare(right.independentUnitId));
  const observationIds = sortedUnits
    .flatMap((unit) => [...unit.observationIds].sort())
    .sort((left, right) => left.localeCompare(right));
  return {
    independentUnitIds: sortedUnits.map((unit) => unit.independentUnitId),
    observationIds,
    independentUnitCount: sortedUnits.length,
    observationCount: observationIds.length,
  };
}

/** Build and fingerprint a split from the roles declared on observations. */
export async function createDatasetSplit(dataset, options = {}) {
  const units = groupedUnits(dataset);
  const byRole = Object.fromEntries(ROLES.map((role) => [role, []]));
  for (const unit of units.values()) {
    if (unit.roles.size !== 1) {
      fail("INDEPENDENT_UNIT_ROLE_LEAKAGE", `${unit.independentUnitId} has observations in multiple roles.`, "dataset.observations", {
        independentUnitId: unit.independentUnitId,
        roles: [...unit.roles].sort(),
      });
    }
    byRole[[...unit.roles][0]].push(unit);
  }

  const sourceDatasetFingerprint = options.sourceDatasetFingerprint ?? await fingerprintJson(dataset, options.fingerprintOptions);
  if (typeof sourceDatasetFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(sourceDatasetFingerprint)) {
    fail("INVALID_SOURCE_FINGERPRINT", "sourceDatasetFingerprint must be a lowercase SHA-256 hex digest.", "sourceDatasetFingerprint", sourceDatasetFingerprint);
  }
  const split = {
    schemaVersion: "1.0.0",
    kind: "observation-dataset-split",
    sourceDatasetId: dataset.metadata.datasetId,
    sourceDatasetFingerprint,
    strategy: options.strategy ?? "declared_roles_by_independent_unit",
    lockedValidation: options.lockedValidation === true,
    roles: Object.fromEntries(ROLES.map((role) => [role, roleEntry(byRole[role])])),
  };
  if (typeof split.strategy !== "string" || split.strategy.length === 0) {
    fail("INVALID_SPLIT_STRATEGY", "strategy must be a non-empty string.", "strategy", split.strategy);
  }
  assertNoSplitOverlap(split);
  return { ...split, splitFingerprint: await fingerprintSplit(split, options.fingerprintOptions) };
}

export const fingerprintDatasetSplit = fingerprintSplit;

function validateRatios(ratios) {
  if (!isRecord(ratios)) fail("INVALID_SPLIT_RATIOS", "ratios must be an object.", "ratios", ratios);
  let total = 0;
  const normalized = {};
  for (const role of ROLES) {
    const value = ratios[role];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      fail("INVALID_SPLIT_RATIO", `ratios.${role} must be between 0 and 1.`, `ratios.${role}`, value);
    }
    normalized[role] = value;
    total += value;
  }
  for (const key of Object.keys(ratios)) {
    if (!ROLE_SET.has(key)) fail("UNKNOWN_SPLIT_ROLE", `Unknown split role: ${key}.`, `ratios.${key}`, key);
  }
  if (Math.abs(total - 1) > 1e-12) {
    fail("INVALID_SPLIT_RATIO_TOTAL", "Split ratios must sum to 1.", "ratios", total);
  }
  return normalized;
}

function targetCounts(unitCount, ratios) {
  const exact = ROLES.map((role, order) => ({
    role,
    order,
    exact: unitCount * ratios[role],
    count: Math.floor(unitCount * ratios[role]),
  }));
  let remaining = unitCount - exact.reduce((sum, entry) => sum + entry.count, 0);
  exact
    .sort((left, right) => (right.exact - right.count) - (left.exact - left.count) || left.order - right.order)
    .slice(0, remaining)
    .forEach((entry) => { entry.count += 1; });
  return Object.fromEntries(exact.map((entry) => [entry.role, entry.count]));
}

/**
 * Deterministically reassign complete independent units according to ratios.
 * The returned dataset is a new JSON-compatible object; the input is untouched.
 */
export function assignSplitRolesByIndependentUnit(dataset, options = {}) {
  const units = groupedUnits(dataset);
  const ratios = validateRatios(options.ratios ?? {
    training: 0.7,
    development: 0.15,
    validation: 0.15,
  });
  const seed = options.seed ?? "ecolab-stage4-split-v1";
  if (typeof seed !== "string" || seed.length === 0) {
    fail("INVALID_SPLIT_SEED", "seed must be a non-empty string.", "seed", seed);
  }
  const sortedUnits = [...units.keys()].sort((left, right) => {
    const leftHash = sha256HexFallback(`${seed}\u0000${left}`);
    const rightHash = sha256HexFallback(`${seed}\u0000${right}`);
    return leftHash.localeCompare(rightHash) || left.localeCompare(right);
  });
  const counts = targetCounts(sortedUnits.length, ratios);
  const assignment = new Map();
  let offset = 0;
  for (const role of ROLES) {
    for (const unitId of sortedUnits.slice(offset, offset + counts[role])) assignment.set(unitId, role);
    offset += counts[role];
  }
  const cloned = {
    ...dataset,
    metadata: { ...dataset.metadata },
    observations: dataset.observations.map((observation) => ({
      ...observation,
      role: assignment.get(observation.independentUnitId),
    })),
  };
  return cloned;
}

export const splitDatasetByIndependentUnit = assignSplitRolesByIndependentUnit;

/** Validate overlap and, when present, verify the recorded split fingerprint. */
export async function validateDatasetSplit(split, options = {}) {
  assertNoSplitOverlap(split);
  const errors = [];
  if (typeof split.splitFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(split.splitFingerprint)) {
    errors.push({ code: "INVALID_SPLIT_FINGERPRINT", path: "split.splitFingerprint" });
  } else {
    const actual = await fingerprintSplit(split, options.fingerprintOptions);
    if (actual !== split.splitFingerprint) {
      errors.push({
        code: "SPLIT_FINGERPRINT_MISMATCH",
        path: "split.splitFingerprint",
        expected: actual,
        actual: split.splitFingerprint,
      });
    }
  }
  return { valid: errors.length === 0, errors };
}
