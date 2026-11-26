import { inspectResearchPackage, replayResearchPackage } from "../analysis/index.js";
import { CLI_SCHEMA_VERSION, cliError, progressFromEntry, readJsonInput } from "./io.js";

/**
 * Package inspection is always synchronous and offline. Numerical replay runs only
 * on --execute and only for exact-version built-in packages, mirroring the app.
 */
export async function runReplayCommand({ packagePath = null, execute = false, reportProgress }) {
  if (packagePath === null) throw cliError("CLI_REPLAY_INPUT", "replay requires --package <file|->.");
  const { value, source } = await readJsonInput(packagePath, { label: "research package" });
  const unwrappedFrom = value !== null && typeof value === "object" && !Array.isArray(value)
    && value.researchPackage !== null && typeof value.researchPackage === "object"
    ? "researchPackage"
    : null;
  const packageValue = unwrappedFrom === "researchPackage" ? value.researchPackage : value;
  const packageText = unwrappedFrom === "researchPackage" ? JSON.stringify(value.researchPackage) : source.text;

  const inspected = inspectResearchPackage(packageText);
  const pkg = inspected.researchPackage;
  const manifest = pkg.contents?.analysisManifest ?? {};
  const inspection = {
    status: inspected.status,
    replayable: inspected.replayable,
    reasons: inspected.reasons,
    packageId: pkg.packageId ?? null,
    createdAt: pkg.createdAt ?? null,
    runId: manifest.runId ?? null,
    dataset: manifest.dataset ?? null,
    versions: manifest.versions ?? null,
    selfContained: pkg.replay?.selfContained ?? null,
    dependencies: pkg.replay?.dependencies ?? [],
  };

  let replay = null;
  if (execute) {
    const outcome = await replayResearchPackage(packageText, {
      onProgress: progressFromEntry(reportProgress),
    });
    replay = { matched: outcome.matched, comparison: outcome.comparison };
  }

  return {
    kind: "ecolab.cli.replay",
    schemaVersion: CLI_SCHEMA_VERSION,
    mode: execute ? "execute" : "inspect",
    input: {
      path: source.path,
      stdin: source.stdin,
      unwrapped: unwrappedFrom !== null,
      unwrappedFrom,
    },
    inspection,
    replay,
  };
}
