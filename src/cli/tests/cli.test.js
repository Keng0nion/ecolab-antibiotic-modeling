import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSchemaValid } from "../../analysis/tests/schema-test-helper.js";

const rootPath = fileURLToPath(new URL("../../../", import.meta.url));
const cliPath = resolve(rootPath, "bin/ecolab.js");
const bundledDatasetPath = resolve(
  rootPath,
  "data/datasets/figshare-bw25113-growth-v1/figshare-bw25113-growth-v1.json",
);
const examplePackagePath = resolve(rootPath, "data/examples/ecolab-stage6-research-6.2.0.json");
const historical61ExamplePackagePath = resolve(rootPath, "data/examples/ecolab-stage6-research-6.1.0.json");
const historicalExamplePackagePath = resolve(rootPath, "data/examples/ecolab-stage6-research-6.0.0.json");

function runCli(args, { input = null } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: rootPath });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stdout, stderr }));
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

function parseStdout(run) {
  return JSON.parse(run.stdout);
}

function parseStderrError(run) {
  const document = JSON.parse(run.stderr);
  assert.equal(document.kind, "ecolab.cli.error");
  assert.equal(document.schemaVersion, "1.0.0");
  return document.error;
}

const validPlan = {
  schemaVersion: "1.0.0",
  kind: "ecolab.simulation-plan",
  id: "cli-test-plan",
  drugId: "tetracycline",
  sampleIntervalMinutes: 10,
  steps: [
    { action: "dose", concentration: { value: 2, unit: "x_zMIC" } },
    { action: "advance", durationMinutes: 120 },
    { action: "washout" },
    { action: "advance", durationMinutes: 60 },
  ],
};

const CSV_HEADER = "time_h,time_min,drug_id,concentration_mg_per_L,concentration_x_zMIC,"
  + "net_growth_log10_fold_per_h,latent_population_log10_CFU_per_mL,population_CFU_per_mL,"
  + "below_detection_limit,detection_limit_log10_CFU_per_mL,model_id,model_version,"
  + "parameter_set_id,parameter_set_version,warning_codes";

test("help and unknown commands", async () => {
  const help = await runCli([]);
  assert.equal(help.code, 0);
  assert.match(help.stdout, /ecolab <command>/u);
  assert.match(help.stdout, /simulate/u);
  const commandHelp = await runCli(["help", "simulate"]);
  assert.equal(commandHelp.code, 0);
  assert.match(commandHelp.stdout, /ecolab simulate/u);
  const unknown = await runCli(["bogus"]);
  assert.equal(unknown.code, 1);
  assert.equal(parseStderrError(unknown).code, "CLI_UNKNOWN_COMMAND");
  assert.equal(unknown.stdout, "");
});

test("a closed downstream pipe ends the process quietly instead of crashing with EPIPE", async () => {
  const run = await new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, "info"], { cwd: rootPath });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, stderr }));
    child.stdout.destroy();
  });
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
});

test("info prints the catalog, versions, presets, and command list as one JSON document", async () => {
  const run = await runCli(["info"]);
  assert.equal(run.code, 0);
  const info = parseStdout(run);
  assert.equal(info.kind, "ecolab.cli.info");
  assert.equal(info.schemaVersion, "1.0.0");
  assert.equal(info.application.version, "6.2.0");
  assert.equal(info.scientificCore.engineVersion, "2.0.0");
  assert.equal(info.analysis.engineVersion, "2.2.0");
  assert.equal(info.scientificCore.modelId, "ecolab.single-population.regoes-logistic");
  assert.equal(info.analysis.stableEngineId, "ecolab.stage4.analysis");
  assert.deepEqual(info.drugs.map(({ id }) => id), [
    "ampicillin", "tetracycline", "ciprofloxacin", "streptomycin", "rifampicin",
  ]);
  assert.equal(info.drugs.find(({ id }) => id === "ciprofloxacin").zMicMgPerL, 0.017);
  assert.equal(info.dataset.id, "figshare-bw25113-growth-v1");
  assert.equal(info.dataset.normalizedDataSha256.length, 64);
  assert.deepEqual(info.researchPresets, ["small", "standard", "precision"]);
  assert.equal(info.taskKinds.length, 13);
  assert.ok(info.taskKinds.includes("analysis.kill-workflow"));
  assert.equal(info.simulationPlan.kind, "ecolab.simulation-plan");
  assert.equal(info.runtime.networkUsed, false);
  assert.ok(info.commands.some(({ name }) => name === "simulate"));
});

test("simulate course presets reproduce the documented model properties", async () => {
  const control = parseStdout(await runCli(["simulate", "--preset", "run-control"]));
  assert.equal(control.kind, "ecolab.cli.simulation");
  assert.equal(control.mode, "preset");
  assert.equal(control.preset, "run-control");
  const controlRun = control.runs[0];
  assert.equal(controlRun.runId, "course-run-control");
  const manifest = controlRun.runManifest;
  assert.equal(manifest.kind, "ecolab.simulation-run");
  assert.equal(manifest.engine.version, "2.0.0");
  assert.deepEqual(manifest.randomness, { used: false, seed: null });
  assert.ok(manifest.warnings.some(({ code }) => code === "TRANSFERRED_CALIBRATION"));
  const controlTrajectory = manifest.result.trajectory;
  assert.equal(controlTrajectory.length, 49);
  assert.equal(controlTrajectory[0].drugId, "none");
  assert.equal(controlTrajectory[0].latentLog10PopulationDensity, 6);
  assert.ok(Math.abs(controlTrajectory[0].netGrowthLog10PerHour - 0.4300428509485446) < 1e-12);
  assert.equal(controlTrajectory.at(-1).timeHours, 4);

  const zmic = parseStdout(await runCli(["simulate", "--preset", "run-zmic"]));
  const zmicTrajectory = zmic.runs[0].runManifest.result.trajectory;
  assert.equal(zmicTrajectory[0].concentrationMgPerL, 0.017);
  assert.equal(zmicTrajectory[0].netGrowthLog10PerHour, 0);
  assert.equal(zmicTrajectory.at(-1).latentLog10PopulationDensity, 6);
});

test("simulate accepts a plan from stdin and resolves x_zMIC against the registered parameter set", async () => {
  const run = await runCli(["simulate", "--plan", "-"], { input: JSON.stringify(validPlan) });
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.mode, "plan");
  assert.equal(document.runs[0].runId, "cli-test-plan");
  const steps = document.plans[0].plan.steps;
  assert.deepEqual(steps[0], { action: "dose", concentrationMgPerL: 1.34 });
  assert.deepEqual(steps[1], { action: "advance", durationMinutes: 120 });
  assert.deepEqual(steps[2], { action: "washout" });
  const trajectory = document.runs[0].runManifest.result.trajectory;
  assert.equal(trajectory.at(-1).concentrationMgPerL, 0);
  assert.equal(trajectory.at(-1).timeHours, 3);
});

test("simulate writes the app's run manifest and trajectory CSV with --out", async (t) => {
  const outDir = await mkdtemp(resolve(tmpdir(), "ecolab-cli-sim-"));
  t.after(() => rm(outDir, { recursive: true, force: true }));
  const run = await runCli(["simulate", "--preset", "run-washout", "--out", outDir]);
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.deepEqual(document.artifacts.map(({ role }) => role), ["run-manifest-json", "trajectory-csv"]);
  const [manifestArtifact, csvArtifact] = document.artifacts;
  const manifestText = await readFile(manifestArtifact.path, "utf8");
  const csvText = await readFile(csvArtifact.path, "utf8");
  assert.equal(
    createHash("sha256").update(manifestText, "utf8").digest("hex"),
    manifestArtifact.sha256,
  );
  assert.equal(createHash("sha256").update(csvText, "utf8").digest("hex"), csvArtifact.sha256);
  assert.equal(JSON.parse(manifestText).kind, "ecolab.simulation-run");
  assert.ok(csvText.startsWith(`${CSV_HEADER}\n`));
  assert.match(csvText, /'?-1\.1855236655894/);
});

test("simulate compare-drugs runs every registered antibiotic at 4x zMIC", async () => {
  const run = await runCli(["simulate", "--preset", "compare-drugs"]);
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.runs.length, 5);
  assert.equal(document.comparison.atZMicMultiple, 4);
  assert.equal(document.comparison.durationMinutes, 60);
  assert.deepEqual(
    document.comparison.rows.map(({ drugId }) => drugId),
    ["ampicillin", "tetracycline", "ciprofloxacin", "streptomycin", "rifampicin"],
  );
  const cipro = document.comparison.rows.find(({ drugId }) => drugId === "ciprofloxacin");
  assert.equal(cipro.concentrationMgPerL, 0.068);
  assert.ok(Math.abs(cipro.netGrowthLog10PerHour + 1.1855236655894) < 1e-12);
});

test("simulate rejects ambiguous input and invalid plans without partial output", async () => {
  const neither = await runCli(["simulate"]);
  assert.equal(neither.code, 1);
  assert.equal(parseStderrError(neither).code, "CLI_SIMULATE_INPUT");
  assert.equal(neither.stdout, "");
  const both = await runCli(["simulate", "--plan", "-", "--preset", "run-control"], { input: JSON.stringify(validPlan) });
  assert.equal(both.code, 1);
  assert.equal(parseStderrError(both).code, "CLI_SIMULATE_INPUT");
  const badKey = await runCli(["simulate", "--plan", "-"], {
    input: JSON.stringify({ ...validPlan, typo: true }),
  });
  assert.equal(badKey.code, 1);
  assert.equal(parseStderrError(badKey).code, "UNKNOWN_PLAN_KEY");
  const badAction = await runCli(["simulate", "--plan", "-"], {
    input: JSON.stringify({ ...validPlan, steps: [{ action: "teleport" }] }),
  });
  assert.equal(badAction.code, 1);
  assert.equal(parseStderrError(badAction).code, "UNKNOWN_PLAN_ACTION");
  const unknownOption = await runCli(["simulate", "--preset", "run-control", "--nope"]);
  assert.equal(unknownOption.code, 1);
  assert.equal(parseStderrError(unknownOption).code, "CLI_UNKNOWN_OPTION");
});

test("simulation plans conform to schemas/simulation-plan.schema.json", async () => {
  const schema = JSON.parse(await readFile(
    resolve(rootPath, "schemas/simulation-plan.schema.json"),
    "utf8",
  ));
  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assertSchemaValid(validPlan, schema);
  assert.throws(() => assertSchemaValid({ ...validPlan, typo: true }, schema), /additional property/);
  assert.throws(() => assertSchemaValid({ ...validPlan, steps: [] }, schema), /minItems/);
  assert.throws(
    () => assertSchemaValid({
      ...validPlan,
      steps: [{ action: "dose", concentration: { value: 1, unit: "M" } }],
    }, schema),
    /oneOf/,
  );
});

test("qc admits the bundled dataset and reports eligibility, and fails loudly on invalid input", async () => {
  const bundled = await runCli(["qc", "--dataset", bundledDatasetPath]);
  assert.equal(bundled.code, 0);
  const qc = parseStdout(bundled);
  assert.equal(qc.kind, "ecolab.cli.dataset-qc");
  assert.equal(qc.format, "json");
  assert.equal(qc.qualityReport.valid, true);
  assert.equal(qc.sourceTextIncluded, false);
  assert.equal(qc.workflowEligibility.eligible, true);
  assert.equal(qc.workflowEligibility.matchedBundledArtifact, true);
  assert.equal(qc.record.sourceKind, "bundled");

  const bad = await runCli(["qc", "--dataset", "-"], { input: '{"schemaVersion":"9.9.9"}' });
  assert.equal(bad.code, 1);
  assert.equal(parseStderrError(bad).code, "UNSUPPORTED_SCHEMA_VERSION");
});

test("replay inspects the current Stage 6 example by unwrapping its researchPackage field", async () => {
  const run = await runCli(["replay", "--package", examplePackagePath]);
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.kind, "ecolab.cli.replay");
  assert.equal(document.mode, "inspect");
  assert.equal(document.input.unwrappedFrom, "researchPackage");
  assert.equal(document.inspection.status, "replayable");
  assert.equal(document.inspection.replayable, true);
  assert.equal(document.inspection.runId, "ecolab-stage6-research-6.2.0");
  assert.equal(document.replay, null);
});

test("replay refuses the frozen 6.0.0 example as inspect-only under the 6.2.0 software contract", async () => {
  const run = await runCli(["replay", "--package", historicalExamplePackagePath]);
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.mode, "inspect");
  assert.equal(document.input.unwrappedFrom, "researchPackage");
  assert.equal(document.inspection.status, "inspect_only");
  assert.equal(document.inspection.replayable, false);
  assert.equal(document.inspection.runId, "ecolab-stage6-research-6.0.0");
  assert.ok(document.inspection.reasons.some(({ code }) => code === "UNSUPPORTED_SOFTWARE_VERSION"));
  assert.equal(document.replay, null);
});

test("replay refuses the frozen 6.1.0 example as inspect-only under the 6.2.0 software contract", async () => {
  const run = await runCli(["replay", "--package", historical61ExamplePackagePath]);
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.mode, "inspect");
  assert.equal(document.input.unwrappedFrom, "researchPackage");
  assert.equal(document.inspection.status, "inspect_only");
  assert.equal(document.inspection.replayable, false);
  assert.equal(document.inspection.runId, "ecolab-stage6-research-6.1.0");
  assert.ok(document.inspection.reasons.some(({ code }) => code === "UNSUPPORTED_SOFTWARE_VERSION"));
  assert.equal(document.replay, null);
});

test("task runs the same worker protocol as the browser app", async () => {
  const datasetText = await readFile(bundledDatasetPath, "utf8");
  const run = await runCli(["task", "--task", "-"], {
    input: JSON.stringify({ kind: "dataset.parse", payload: { input: datasetText } }),
  });
  assert.equal(run.code, 0);
  const document = parseStdout(run);
  assert.equal(document.kind, "ecolab.cli.task");
  assert.equal(document.taskKind, "dataset.parse");
  assert.equal(document.result.format, "json");
  assert.equal(document.result.stats.rowCount, 528);
  assert.equal(document.result.qualityReport.valid, true);

  const badKind = await runCli(["task", "--task", "-"], { input: JSON.stringify({ kind: "nope", payload: {} }) });
  assert.equal(badKind.code, 1);
  assert.equal(parseStderrError(badKind).code, "UNSUPPORTED_TASK_KIND");
});

test("research runs the locked workflow twice with identical artifacts and a replayable package", async (t) => {
  const firstDir = await mkdtemp(resolve(tmpdir(), "ecolab-cli-research-a-"));
  const secondDir = await mkdtemp(resolve(tmpdir(), "ecolab-cli-research-b-"));
  t.after(() => Promise.all([
    rm(firstDir, { recursive: true, force: true }),
    rm(secondDir, { recursive: true, force: true }),
  ]));
  const args = [
    "research", "--preset", "small", "--seed", "123456789",
    "--run-id", "cli-test-research", "--created-at", "2026-09-07T12:00:00.000Z",
  ];
  const first = await runCli([...args, "--out", firstDir]);
  assert.equal(first.code, 0);
  const document = parseStdout(first);
  assert.equal(document.kind, "ecolab.cli.research");
  assert.equal(document.run.runId, "cli-test-research");
  assert.equal(document.run.seed, 123456789);
  assert.equal(document.run.createdAt, "2026-09-07T12:00:00.000Z");
  assert.equal(document.qualityReport.valid, true);
  assert.equal(document.result.researchAssessment.completed, true);
  assert.equal(document.result.capability.level, "L3");
  assert.equal(document.result.growthComparison.selection.selectedModel, "training_mean");
  assert.deepEqual(
    document.artifacts.map(({ role }) => role),
    [
      "research-package-json",
      "analysis-manifest-json",
      "predictions-residuals-metrics-csv",
      "normalized-dataset-csv",
      "methods-markdown",
      "research-dashboard-svg",
    ],
  );
  const packageArtifact = document.artifacts[0];
  assert.ok(packageArtifact.bytes > 1_000_000);

  const second = await runCli([...args, "--out", secondDir]);
  assert.equal(second.code, 0);
  const secondDocument = parseStdout(second);
  const secondPackage = await readFile(secondDocument.artifacts[0].path, "utf8");
  const firstPackage = await readFile(packageArtifact.path, "utf8");
  assert.equal(secondPackage, firstPackage);

  const replay = await runCli(["replay", "--package", packageArtifact.path, "--execute"]);
  assert.equal(replay.code, 0);
  const replayDocument = parseStdout(replay);
  assert.equal(replayDocument.mode, "execute");
  assert.equal(replayDocument.replay.matched, true);
  assert.equal(replayDocument.replay.comparison.mismatchCount, 0);
}, { timeout: 120_000 });
