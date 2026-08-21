import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fileInventory } from "./lib/release-utils.js";

const execute = promisify(execFile);
const rootPath = fileURLToPath(new URL("../", import.meta.url));
const temporaryRoot = await mkdtemp(resolve(tmpdir(), "ecolab-reproducible-build-"));

async function build(name) {
  const parent = resolve(temporaryRoot, name);
  const core = resolve(parent, "core");
  const web = resolve(parent, "web");
  await execute(process.execPath, ["scripts/build-core.js", "--out-dir", core], {
    cwd: rootPath,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  await execute(process.execPath, ["scripts/build-web.js", "--out-dir", web], {
    cwd: rootPath,
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  const inventory = [
    ...await fileInventory(core, "core"),
    ...await fileInventory(web, "web"),
  ].sort((left, right) => left.path.localeCompare(right.path, "en"));
  return inventory.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}

try {
  const first = await build("first");
  const second = await build("second");
  const firstText = JSON.stringify(first);
  const secondText = JSON.stringify(second);
  if (firstText !== secondText) {
    const firstByPath = new Map(first.map((file) => [file.path, file]));
    const secondByPath = new Map(second.map((file) => [file.path, file]));
    const paths = [...new Set([...firstByPath.keys(), ...secondByPath.keys()])].sort();
    const differences = paths.filter((path) => JSON.stringify(firstByPath.get(path)) !== JSON.stringify(secondByPath.get(path)));
    throw new Error(`Clean builds are not reproducible. Differing paths:\n${differences.join("\n")}`);
  }
  console.log(`Two clean temporary builds are byte-for-byte reproducible across ${first.length} files.`);
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
