import {
  assertJsonSafe,
  assertRunEnvelope,
  createErrorMessage,
  createProgressMessage,
  createResultMessage,
} from "./task-protocol.js";

const EVALUATOR_REQUIRED =
  "Worker tasks cannot receive callback functions. Supply a supported serializable evaluator specification.";
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let analysisApiPromise;

function loadAnalysisApi() {
  analysisApiPromise ??= import("../../analysis/index.js");
  return analysisApiPromise;
}

export class WorkerTaskError extends TypeError {
  constructor(code, message, path = null, actual = undefined) {
    super(message);
    this.name = "WorkerTaskError";
    this.code = code;
    this.path = path;
    this.actual = actual;
  }
}

function fail(code, message, path = null, actual = undefined, ErrorType = WorkerTaskError) {
  throw new ErrorType(code, message, path, actual);
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function record(value, path) {
  if (!isRecord(value)) fail("INVALID_TASK_PAYLOAD", `${path} must be a plain object.`, path, value);
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("INVALID_EVALUATOR_SPEC", `${path} must be a non-empty string without surrounding whitespace.`, path, value);
  }
  return value;
}

function finite(value, path) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_EVALUATOR_SPEC", `${path} must be a finite number.`, path, value);
  }
  return value;
}

function copyObjectWithout(source, omitted) {
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    if (!omitted.has(key)) result[key] = value;
  }
  return result;
}

function normalizeTaskOptions(payload, taskKind) {
  record(payload, `${taskKind}.payload`);
  if (payload.options === undefined) return payload;
  record(payload.options, `${taskKind}.payload.options`);
  return payload.options;
}

function evaluatorPayload(payload, taskKind) {
  record(payload, `${taskKind}.payload`);
  const source = payload.options === undefined
    ? payload
    : record(payload.options, `${taskKind}.payload.options`);
  const spec = payload.evaluatorSpec
    ?? payload.evaluator
    ?? source.evaluatorSpec
    ?? source.evaluator;
  const options = copyObjectWithout(source, new Set(["evaluatorSpec", "evaluator", "evaluate"]));
  if (spec === undefined) {
    fail("SERIALIZABLE_EVALUATOR_REQUIRED", EVALUATOR_REQUIRED, `${taskKind}.payload.evaluator`);
  }
  return { options, spec };
}

function numericParameter(parameters, name, path) {
  record(parameters, "parameters");
  const value = parameters[name];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_EVALUATOR_INPUT", `${path} resolved to a non-finite parameter.`, path, value);
  }
  return value;
}

function scalarTerm(term, index) {
  record(term, `evaluator.terms[${index}]`);
  return {
    parameter: nonEmptyString(term.parameter ?? term.name, `evaluator.terms[${index}].parameter`),
    coefficient: finite(term.coefficient ?? 1, `evaluator.terms[${index}].coefficient`),
  };
}

function createLinearCombinationEvaluator(spec) {
  const terms = spec.terms;
  if (!Array.isArray(terms) || terms.length === 0) {
    fail("INVALID_EVALUATOR_SPEC", "evaluator.terms must be a non-empty array.", "evaluator.terms", terms);
  }
  const normalizedTerms = terms.map(scalarTerm);
  const offset = finite(spec.offset ?? spec.constant ?? 0, "evaluator.offset");
  return (parameters) => normalizedTerms.reduce(
    (sum, term) => sum + term.coefficient * numericParameter(parameters, term.parameter, `parameters.${term.parameter}`),
    offset,
  );
}

function observationValue(observation, field, path) {
  record(observation, path);
  if (UNSAFE_KEYS.has(field)) fail("UNSAFE_OBJECT_KEY", `${path}.${field} is unsafe.`, `${path}.${field}`, field);
  const value = observation[field];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("INVALID_EVALUATOR_INPUT", `${path}.${field} must be finite.`, `${path}.${field}`, value);
  }
  return value;
}

function normalizedIntercept(spec) {
  if (spec.interceptParameter !== undefined) {
    return { parameter: nonEmptyString(spec.interceptParameter, "evaluator.interceptParameter") };
  }
  if (spec.intercept !== undefined && isRecord(spec.intercept)) {
    if (spec.intercept.parameter !== undefined) {
      return { parameter: nonEmptyString(spec.intercept.parameter, "evaluator.intercept.parameter") };
    }
    return { value: finite(spec.intercept.value, "evaluator.intercept.value") };
  }
  return { value: finite(spec.intercept ?? 0, "evaluator.intercept") };
}

function observationTerm(term, index) {
  record(term, `evaluator.terms[${index}]`);
  return {
    parameter: nonEmptyString(term.parameter ?? term.name, `evaluator.terms[${index}].parameter`),
    observationField: nonEmptyString(
      term.observationField ?? term.field,
      `evaluator.terms[${index}].observationField`,
    ),
    coefficient: finite(term.coefficient ?? 1, `evaluator.terms[${index}].coefficient`),
  };
}

function createObservationLinearPredictor(spec) {
  const terms = spec.terms;
  if (!Array.isArray(terms) || terms.length === 0) {
    fail("INVALID_EVALUATOR_SPEC", "evaluator.terms must be a non-empty array.", "evaluator.terms", terms);
  }
  const intercept = normalizedIntercept(spec);
  const normalizedTerms = terms.map(observationTerm);
  return (parameters, observation, index) => {
    const base = intercept.parameter === undefined
      ? intercept.value
      : numericParameter(parameters, intercept.parameter, `parameters.${intercept.parameter}`);
    return normalizedTerms.reduce(
      (sum, term) => sum
        + term.coefficient
        * numericParameter(parameters, term.parameter, `parameters.${term.parameter}`)
        * observationValue(observation, term.observationField, `observations[${index}]`),
      base,
    );
  };
}

function observationEvaluatorOptions(spec, path = "evaluator.options") {
  const source = spec.options ?? spec.model ?? spec.input;
  const options = source === undefined
    ? copyObjectWithout(spec, new Set(["kind", "type"]))
    : record(source, path);
  for (const callbackName of [
    "protocolBuilder",
    "protocolBuilders",
    "odObservationModel",
    "observationModel",
    "summarize",
    "scalarSummary",
    "summaryEvaluator",
  ]) {
    if (Object.hasOwn(options, callbackName)) {
      fail(
        "UNSUPPORTED_EVALUATOR_CALLBACK",
        `${path}.${callbackName} cannot cross the Worker boundary; use built-in serializable model and summary options only.`,
        `${path}.${callbackName}`,
      );
    }
  }
  return options;
}

/** Build a supported synchronous evaluator from a structured-clone-safe specification. */
export function createSerializableEvaluator(spec, analysisApi = null) {
  record(spec, "evaluator");
  assertJsonSafe(spec, "evaluator");
  const kind = spec.kind ?? spec.type;
  switch (kind) {
    case "constant": {
      const value = finite(spec.value, "evaluator.value");
      return () => value;
    }
    case "parameter": {
      const name = nonEmptyString(spec.parameter ?? spec.name, "evaluator.parameter");
      return (parameters) => numericParameter(parameters, name, `parameters.${name}`);
    }
    case "linear":
    case "linear-combination":
      return createLinearCombinationEvaluator(spec);
    case "observation-dataset":
    case "observation-evaluation":
      if (typeof analysisApi?.createObservationDatasetEvaluator !== "function") {
        fail("ANALYSIS_API_REQUIRED", "The observation evaluator requires the public analysis API.");
      }
      return analysisApi.createObservationDatasetEvaluator(observationEvaluatorOptions(spec));
    case "observation-predictions":
      if (typeof analysisApi?.createObservationPredictionEvaluator !== "function") {
        fail("ANALYSIS_API_REQUIRED", "The prediction evaluator requires the public analysis API.");
      }
      return analysisApi.createObservationPredictionEvaluator(observationEvaluatorOptions(spec));
    case "observation-scalar":
    case "observation-scalar-summary":
      if (typeof analysisApi?.createScalarSummaryEvaluator !== "function") {
        fail("ANALYSIS_API_REQUIRED", "The scalar evaluator requires the public analysis API.");
      }
      return analysisApi.createScalarSummaryEvaluator(observationEvaluatorOptions(spec));
    default:
      fail(
        "UNSUPPORTED_EVALUATOR_SPEC",
        "evaluator.kind must be constant, parameter, linear-combination, observation-dataset, observation-predictions, or observation-scalar-summary.",
        "evaluator.kind",
        kind,
      );
  }
}

function detailWithoutProgress(entry) {
  if (!isRecord(entry)) return undefined;
  const detail = copyObjectWithout(entry, new Set(["phase", "completed", "total", "fraction"]));
  return Object.keys(detail).length > 0 ? detail : undefined;
}

function analysisProgress(reportProgress, defaultPhase) {
  return (entry) => {
    record(entry, "analysis progress");
    const phase = entry.phase ?? defaultPhase;
    reportProgress(phase, entry.completed, entry.total, detailWithoutProgress(entry));
  };
}

function withEvaluator(payload, taskKind, analysisApi) {
  const { options, spec } = evaluatorPayload(payload, taskKind);
  return { ...options, evaluator: createSerializableEvaluator(spec, analysisApi) };
}

function fitOptions(payload, analysisApi) {
  const { options, spec } = evaluatorPayload(payload, "analysis.fit");
  record(spec, "evaluator");
  const kind = spec.kind ?? spec.type;
  if (kind === "linear-observation" || kind === "observation-linear") {
    return { ...options, predictor: createObservationLinearPredictor(spec) };
  }
  if (kind === "observation-predictions") {
    const evaluatorOptions = observationEvaluatorOptions(spec);
    const evaluator = analysisApi.createObservationPredictionEvaluator(evaluatorOptions);
    return {
      ...options,
      observations: options.observations ?? evaluatorOptions.dataset?.observations,
      evaluator: (parameters) => evaluator(parameters),
    };
  }
  fail(
    "UNSUPPORTED_FIT_EVALUATOR_SPEC",
    "analysis.fit supports evaluator.kind linear-observation or observation-predictions.",
    "evaluator.kind",
    kind,
  );
}

async function parseDataset(payload, reportProgress, analysisApi) {
  record(payload, "dataset.parse.payload");
  if (!Object.hasOwn(payload, "input")) {
    fail("DATASET_INPUT_REQUIRED", "dataset.parse payload.input is required.", "dataset.parse.payload.input");
  }
  const options = payload.options ?? {};
  record(options, "dataset.parse.payload.options");
  reportProgress("import", 0, 1);
  const imported = analysisApi.importObservationDataset(payload.input, options);
  reportProgress("import", 1, 1, { format: imported.format, rowCount: imported.stats.rowCount });
  reportProgress("quality-check", 0, 1);
  const qualityReport = analysisApi.assessDatasetQuality(imported.dataset, payload.qualityOptions ?? {});
  reportProgress("quality-check", 1, 1, {
    valid: qualityReport.valid,
    errorCount: qualityReport.summary.errorCount,
    warningCount: qualityReport.summary.warningCount,
  });
  return { ...imported, qualityReport };
}

async function qualityCheck(payload, reportProgress, analysisApi) {
  record(payload, "dataset.quality-check.payload");
  const dataset = payload.dataset ?? payload.input;
  if (dataset === undefined) {
    fail("DATASET_REQUIRED", "dataset.quality-check payload.dataset is required.", "dataset.quality-check.payload.dataset");
  }
  reportProgress("quality-check", 0, 1);
  const result = analysisApi.assessDatasetQuality(dataset, payload.options ?? {});
  reportProgress("quality-check", 1, 1, {
    valid: result.valid,
    errorCount: result.summary.errorCount,
    warningCount: result.summary.warningCount,
  });
  return result;
}

async function evaluateTask(payload, reportProgress, analysisApi) {
  record(payload, "analysis.evaluate.payload");
  reportProgress("evaluate", 0, 1);
  let result;
  const spec = payload.evaluatorSpec ?? payload.evaluator;
  if (spec !== undefined) {
    const evaluator = createSerializableEvaluator(spec, analysisApi);
    result = evaluator(payload.parameters ?? payload.overrides ?? {}, payload.context ?? {});
  } else {
    const options = normalizeTaskOptions(payload, "analysis.evaluate");
    result = analysisApi.evaluateObservationDataset(options);
  }
  result = await Promise.resolve(result);
  reportProgress("evaluate", 1, 1);
  return result;
}

async function researchWorkflow(payload, reportProgress, analysisApi) {
  if (typeof analysisApi.runResearchWorkflow !== "function") {
    fail(
      "RESEARCH_WORKFLOW_UNAVAILABLE",
      "The public analysis API does not currently export runResearchWorkflow.",
      "analysis.runResearchWorkflow",
    );
  }
  const options = normalizeTaskOptions(payload, "analysis.research-workflow");
  reportProgress("research-workflow", 0, 1);
  const result = await analysisApi.runResearchWorkflow({
    ...options,
    onProgress: analysisProgress(reportProgress, "research-workflow"),
  });
  reportProgress("research-workflow", 1, 1);
  return result;
}

/** Dispatch one validated task without depending on a Worker global. */
export async function dispatchTask(task, context = {}) {
  record(task, "task");
  const analysisApi = context.analysisApi ?? await loadAnalysisApi();
  const reportProgress = context.reportProgress ?? (() => {});
  if (typeof reportProgress !== "function") {
    fail("INVALID_PROGRESS_REPORTER", "context.reportProgress must be a function.", "context.reportProgress");
  }
  switch (task.kind) {
    case "dataset.parse":
      return parseDataset(task.payload, reportProgress, analysisApi);
    case "dataset.quality-check":
      return qualityCheck(task.payload, reportProgress, analysisApi);
    case "analysis.parameter-scan": {
      reportProgress("parameter-scan.prepare", 0, 1);
      const options = withEvaluator(task.payload, task.kind, analysisApi);
      reportProgress("parameter-scan.prepare", 1, 1);
      return analysisApi.runParameterScan({
        ...options,
        onProgress: analysisProgress(reportProgress, "parameter-scan"),
      });
    }
    case "analysis.monte-carlo": {
      reportProgress("monte-carlo.prepare", 0, 1);
      const options = withEvaluator(task.payload, task.kind, analysisApi);
      reportProgress("monte-carlo.prepare", 1, 1);
      return analysisApi.runMonteCarlo({
        ...options,
        onProgress: analysisProgress(reportProgress, "monte-carlo"),
      });
    }
    case "analysis.sensitivity-local": {
      reportProgress("sensitivity-local", 0, 1);
      const result = analysisApi.localSensitivity(withEvaluator(task.payload, task.kind, analysisApi));
      reportProgress("sensitivity-local", 1, 1);
      return result;
    }
    case "analysis.sensitivity-morris": {
      reportProgress("sensitivity-morris", 0, 1);
      const result = analysisApi.morrisSensitivity(withEvaluator(task.payload, task.kind, analysisApi));
      reportProgress("sensitivity-morris", 1, 1);
      return result;
    }
    case "analysis.sensitivity-sobol": {
      reportProgress("sensitivity-sobol", 0, 1);
      const result = analysisApi.sobolJansenSensitivity(withEvaluator(task.payload, task.kind, analysisApi));
      reportProgress("sensitivity-sobol", 1, 1);
      return result;
    }
    case "analysis.fit": {
      reportProgress("fit", 0, 1);
      const result = analysisApi.fitParameters(fitOptions(task.payload, analysisApi));
      reportProgress("fit", 1, 1);
      return result;
    }
    case "analysis.evaluate":
      return evaluateTask(task.payload, reportProgress, analysisApi);
    case "analysis.research-workflow":
      return researchWorkflow(task.payload, reportProgress, analysisApi);
    default:
      fail("UNSUPPORTED_TASK_KIND", `Unsupported task kind: ${String(task.kind)}.`, "task.kind", task.kind);
  }
}

/** Validate, execute, and emit deterministic progress/result/error envelopes. */
export async function handleRunEnvelope(message, postMessage, context = {}) {
  if (typeof postMessage !== "function") {
    throw new TypeError("postMessage must be a function.");
  }
  let taskId = isRecord(message)
    && typeof message.taskId === "string"
    && message.taskId.length > 0
    && message.taskId === message.taskId.trim()
    ? message.taskId
    : "invalid-task";
  try {
    const run = assertRunEnvelope(message);
    taskId = run.taskId;
    const result = await dispatchTask(run.task, {
      ...context,
      reportProgress(phase, completed, total, detail = undefined) {
        const fraction = completed / total;
        postMessage(createProgressMessage(taskId, phase, completed, total, fraction, detail));
      },
    });
    postMessage(createResultMessage(taskId, result));
  } catch (error) {
    postMessage(createErrorMessage(taskId, error));
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  const workerScope = self;
  workerScope.onmessage = async (event) => {
    workerScope.onmessage = null;
    await handleRunEnvelope(event.data, (message) => workerScope.postMessage(message));
    workerScope.close?.();
  };
}
