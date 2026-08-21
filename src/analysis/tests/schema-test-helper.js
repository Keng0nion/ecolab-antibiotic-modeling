function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function typeMatches(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function pointerValue(document, fragment, path) {
  if (fragment === "" || fragment === "#") return document;
  if (!fragment.startsWith("#/")) fail(path, `unsupported $ref fragment ${fragment}`);
  let value = document;
  for (const rawPart of fragment.slice(2).split("/")) {
    const part = decodeURIComponent(rawPart).replaceAll("~1", "/").replaceAll("~0", "~");
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) {
      fail(path, `unresolved $ref fragment ${fragment}`);
    }
    value = value[part];
  }
  return value;
}

function resolveRef(ref, context, path) {
  const hashIndex = ref.indexOf("#");
  const documentName = hashIndex === -1 ? ref : ref.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? "" : ref.slice(hashIndex);
  const document = documentName === ""
    ? context.document
    : context.documents[documentName];
  if (!document) fail(path, `unresolved schema document ${documentName}`);
  return {
    schema: pointerValue(document, fragment, path),
    context: { ...context, document },
  };
}

function validate(value, schema, context, path) {
  if (schema === true) return;
  if (schema === false) fail(path, "value is forbidden by schema");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    fail(path, "schema must be an object or boolean");
  }

  if (schema.$ref) {
    const resolved = resolveRef(schema.$ref, context, path);
    validate(value, resolved.schema, resolved.context, path);
  }

  if (Object.hasOwn(schema, "const") && !Object.is(value, schema.const)) {
    fail(path, `expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => canonical(candidate) === canonical(value))) {
    fail(path, `expected one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => typeMatches(value, type))) {
      fail(path, `expected type ${types.join(" or ")}`);
    }
  }

  if (schema.not !== undefined) {
    let matched = true;
    try {
      validate(value, schema.not, context, path);
    } catch {
      matched = false;
    }
    if (matched) fail(path, "value matched forbidden not schema");
  }

  if (schema.oneOf) {
    let matches = 0;
    for (const candidate of schema.oneOf) {
      try {
        validate(value, candidate, context, path);
        matches += 1;
      } catch {
        // Candidate mismatch is expected while evaluating oneOf.
      }
    }
    if (matches !== 1) fail(path, `expected exactly one oneOf match, received ${matches}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      fail(path, `expected minLength ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !(new RegExp(schema.pattern, "u")).test(value)) {
      fail(path, `did not match pattern ${schema.pattern}`);
    }
    if (schema.format === "date-time" && Number.isNaN(Date.parse(value))) {
      fail(path, "expected date-time text");
    }
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (schema.minimum !== undefined && value < schema.minimum) fail(path, `expected minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(path, `expected maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(path, `expected minItems ${schema.minItems}`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(path, `expected maxItems ${schema.maxItems}`);
    if (schema.uniqueItems === true) {
      const unique = new Set(value.map(canonical));
      if (unique.size !== value.length) fail(path, "expected uniqueItems");
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validate(item, schema.items, context, `${path}[${index}]`));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      fail(path, `expected minProperties ${schema.minProperties}`);
    }
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) fail(path, `missing required property ${required}`);
    }
    for (const key of keys) {
      if (schema.propertyNames !== undefined) {
        validate(key, schema.propertyNames, context, `${path} property name ${JSON.stringify(key)}`);
      }
      if (schema.properties && Object.hasOwn(schema.properties, key)) {
        validate(value[key], schema.properties[key], context, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        fail(path, `unexpected additional property ${key}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validate(value[key], schema.additionalProperties, context, `${path}.${key}`);
      }
    }
  }
}

export function assertSchemaValid(value, schema, options = {}) {
  const documents = options.documents ?? {};
  validate(value, schema, { document: schema, documents }, options.path ?? "$");
}
