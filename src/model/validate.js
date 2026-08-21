import { validationError } from "./errors.js";

export function assertPlainObject(value, path) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw validationError(
      "INVALID_OBJECT",
      path,
      "plain object",
      value,
      `${path} must be a plain object.`,
    );
  }
  return value;
}

export function assertArray(value, path, { minLength = 0 } = {}) {
  if (!Array.isArray(value) || value.length < minLength) {
    throw validationError(
      "INVALID_ARRAY",
      path,
      `array with at least ${minLength} item(s)`,
      value,
      `${path} must be an array with at least ${minLength} item(s).`,
    );
  }
  return value;
}

export function assertFiniteNumber(value, path, options = {}) {
  const { minimum = -Infinity, maximum = Infinity, exclusiveMinimum = false } =
    options;
  const belowMinimum = exclusiveMinimum ? value <= minimum : value < minimum;

  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    belowMinimum ||
    value > maximum
  ) {
    const lower = exclusiveMinimum ? `> ${minimum}` : `>= ${minimum}`;
    throw validationError(
      "INVALID_NUMBER",
      path,
      `finite number ${lower} and <= ${maximum}`,
      value,
      `${path} must be a finite number ${lower} and <= ${maximum}.`,
    );
  }
  return value;
}

export function assertNonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw validationError(
      "INVALID_STRING",
      path,
      "non-empty string",
      value,
      `${path} must be a non-empty string.`,
    );
  }
  return value;
}

export function assertEnum(value, allowed, path) {
  if (!allowed.includes(value)) {
    throw validationError(
      "INVALID_ENUM",
      path,
      allowed,
      value,
      `${path} must be one of: ${allowed.join(", ")}.`,
    );
  }
  return value;
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getAtPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}
