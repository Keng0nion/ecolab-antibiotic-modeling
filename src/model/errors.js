export class ScientificValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ScientificValidationError";
    this.code = code;
    this.path = details.path ?? null;
    this.expected = details.expected;
    this.actual = details.actual;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      path: this.path,
      expected: this.expected,
      actual: this.actual,
    };
  }
}

export function validationError(code, path, expected, actual, message) {
  return new ScientificValidationError(code, message, {
    path,
    expected,
    actual,
  });
}
