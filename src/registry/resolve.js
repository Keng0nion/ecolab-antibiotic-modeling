import { validationError } from "../model/errors.js";
import {
  assertArray,
  assertFiniteNumber,
  assertNonEmptyString,
  assertPlainObject,
  cloneJson,
  deepFreeze,
} from "../model/validate.js";
import {
  concentrationToMgPerL,
  populationToLog10,
  timeToHours,
} from "../model/units.js";
import {
  IMPLEMENTATION_ID,
  MODEL_ID,
} from "../model/version.js";
import { validateGrowthParameters } from "../model/regoes-logistic-v1.js";

function recordsFromRegistry(registry, path) {
  assertPlainObject(registry, path);
  assertArray(registry.records, `${path}.records`);
  return registry.records;
}

function indexUnique(records, keyFor, path) {
  const index = new Map();
  records.forEach((record, position) => {
    assertPlainObject(record, `${path}.records.${position}`);
    const key = keyFor(record);
    if (index.has(key)) {
      throw validationError(
        "DUPLICATE_REGISTRY_ID",
        `${path}.records.${position}`,
        "unique registry key",
        key,
        `Duplicate registry key: ${key}.`,
      );
    }
    index.set(key, record);
  });
  return index;
}

function assertExactUnit(parameter, expectedUnit, path) {
  assertPlainObject(parameter, path);
  assertFiniteNumber(parameter.value, `${path}.value`);
  if (parameter.unit !== expectedUnit) {
    throw validationError(
      "UNIT_MISMATCH",
      `${path}.unit`,
      expectedUnit,
      parameter.unit,
      `${path}.unit must be ${expectedUnit}.`,
    );
  }
  return parameter.value;
}

function collectAndValidateSourceIds(parameterSet, sourceIndex) {
  const sourceIds = new Set();

  function visit(value, path) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}.${index}`));
      return;
    }
    if (Array.isArray(value.provenance)) {
      value.provenance.forEach((entry, index) => {
        assertPlainObject(entry, `${path}.provenance.${index}`);
        const sourceId = assertNonEmptyString(
          entry.sourceId,
          `${path}.provenance.${index}.sourceId`,
        );
        if (!sourceIndex.has(sourceId)) {
          throw validationError(
            "UNKNOWN_SOURCE_REFERENCE",
            `${path}.provenance.${index}.sourceId`,
            "registered source ID",
            sourceId,
            `Unknown source reference: ${sourceId}.`,
          );
        }
        if (!entry.locator || typeof entry.locator.value !== "string") {
          throw validationError(
            "MISSING_SOURCE_LOCATOR",
            `${path}.provenance.${index}.locator`,
            "source locator",
            entry.locator,
            `A precise source locator is required for ${sourceId}.`,
          );
        }
        sourceIds.add(sourceId);
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== "provenance") visit(child, `${path}.${key}`);
    }
  }

  visit(parameterSet.parameters, "parameterSet.parameters");
  return [...sourceIds].sort();
}

export function findRegistryRecord(registry, id, version = null, path = "registry") {
  const records = recordsFromRegistry(registry, path);
  const matches = records.filter(
    (record) => record.id === id && (version === null || record.version === version),
  );
  if (matches.length !== 1) {
    throw validationError(
      matches.length === 0 ? "REGISTRY_RECORD_NOT_FOUND" : "AMBIGUOUS_REGISTRY_RECORD",
      path,
      version === null ? id : `${id}@${version}`,
      matches.length,
      `Expected exactly one registry record for ${id}${version ? `@${version}` : ""}.`,
    );
  }
  return matches[0];
}

export function resolveModel({ definition, parameterSet, sourceRegistry }) {
  assertPlainObject(definition, "definition");
  assertPlainObject(parameterSet, "parameterSet");
  const sourceRecords = recordsFromRegistry(sourceRegistry, "sourceRegistry");
  const sourceIndex = indexUnique(
    sourceRecords,
    (source) => assertNonEmptyString(source.id, "source.id"),
    "sourceRegistry",
  );

  if (definition.id !== MODEL_ID) {
    throw validationError(
      "UNSUPPORTED_MODEL",
      "definition.id",
      MODEL_ID,
      definition.id,
      `Unsupported model ID: ${definition.id}.`,
    );
  }
  if (definition.implementationId !== IMPLEMENTATION_ID) {
    throw validationError(
      "UNSUPPORTED_IMPLEMENTATION",
      "definition.implementationId",
      IMPLEMENTATION_ID,
      definition.implementationId,
      `Unsupported implementation ID: ${definition.implementationId}.`,
    );
  }
  if (
    parameterSet.modelRef?.id !== definition.id ||
    parameterSet.modelRef?.version !== definition.version
  ) {
    throw validationError(
      "MODEL_VERSION_MISMATCH",
      "parameterSet.modelRef",
      { id: definition.id, version: definition.version },
      parameterSet.modelRef,
      "The parameter set must target this exact model ID and version.",
    );
  }

  const parameters = parameterSet.parameters;
  assertPlainObject(parameters, "parameterSet.parameters");
  const doublingTimeHours = timeToHours(
    parameters.growth.doublingTime,
    "parameterSet.parameters.growth.doublingTime",
  );
  if (doublingTimeHours <= 0) {
    throw validationError(
      "INVALID_DOUBLING_TIME",
      "parameterSet.parameters.growth.doublingTime.value",
      "> 0",
      doublingTimeHours,
      "Doubling time must be greater than zero.",
    );
  }

  const resolvedDrugs = {};
  assertPlainObject(parameters.drugs, "parameterSet.parameters.drugs");
  for (const [drugId, drug] of Object.entries(parameters.drugs)) {
    assertPlainObject(drug, `parameterSet.parameters.drugs.${drugId}`);
    resolvedDrugs[drugId] = {
      zMicMgPerL: concentrationToMgPerL(
        drug.zMic,
        `parameterSet.parameters.drugs.${drugId}.zMic`,
      ),
      hillKappa: assertExactUnit(
        drug.hillKappa,
        "dimensionless",
        `parameterSet.parameters.drugs.${drugId}.hillKappa`,
      ),
      psiMinLog10PerHour: assertExactUnit(
        drug.psiMin,
        "log10-fold/h",
        `parameterSet.parameters.drugs.${drugId}.psiMin`,
      ),
      paperBrothDilutionMicMgPerL: concentrationToMgPerL(
        drug.paperBrothDilutionMic,
        `parameterSet.parameters.drugs.${drugId}.paperBrothDilutionMic`,
      ),
    };
  }

  const resolvedParameters = {
    psiMaxLog10PerHour: Math.log10(2) / doublingTimeHours,
    carryingCapacityLog10CfuPerMl: populationToLog10(
      parameters.population.carryingCapacity,
      "parameterSet.parameters.population.carryingCapacity",
    ),
    drugs: resolvedDrugs,
  };
  validateGrowthParameters(resolvedParameters);
  const sourceIds = collectAndValidateSourceIds(parameterSet, sourceIndex);
  const warnings = Array.isArray(parameterSet.warnings)
    ? parameterSet.warnings.map((warning) => cloneJson(warning))
    : [];

  return deepFreeze({
    kind: "ResolvedModel",
    ref: {
      id: definition.id,
      version: definition.version,
      implementationId: definition.implementationId,
      parameterSetId: parameterSet.id,
      parameterSetVersion: parameterSet.version,
    },
    definition: cloneJson(definition),
    parameterSet: cloneJson(parameterSet),
    parameters: resolvedParameters,
    sourceIds,
    evidenceLevel: parameterSet.evidenceLevel,
    conditionMatch: parameterSet.conditionMatch,
    capabilityLevel: parameterSet.capabilityLevel,
    warnings,
  });
}

export function resolveModelFromRegistries({
  modelRegistry,
  parameterRegistry,
  sourceRegistry,
  modelRef,
  parameterSetRef,
}) {
  const modelRecords = recordsFromRegistry(modelRegistry, "modelRegistry");
  const parameterRecords = recordsFromRegistry(parameterRegistry, "parameterRegistry");
  indexUnique(modelRecords, (record) => `${record.id}@${record.version}`, "modelRegistry");
  indexUnique(
    parameterRecords,
    (record) => `${record.id}@${record.version}`,
    "parameterRegistry",
  );

  return resolveModel({
    definition: findRegistryRecord(
      modelRegistry,
      modelRef.id,
      modelRef.version,
      "modelRegistry",
    ),
    parameterSet: findRegistryRecord(
      parameterRegistry,
      parameterSetRef.id,
      parameterSetRef.version,
      "parameterRegistry",
    ),
    sourceRegistry,
  });
}
