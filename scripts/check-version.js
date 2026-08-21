import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const versionSource = await readFile(new URL("src/app/version.js", root), "utf8");
const match = versionSource.match(/export\s+const\s+APPLICATION_VERSION\s*=\s*["']([^"']+)["']\s*;/u);

if (typeof packageJson.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(packageJson.version)) {
  throw new Error("package.json must declare a valid semantic version.");
}
if (!match) throw new Error("src/app/version.js must export a literal APPLICATION_VERSION.");
if (match[1] !== packageJson.version) {
  throw new Error(`Application version mismatch: package.json=${packageJson.version}, src/app/version.js=${match[1]}.`);
}
if (packageJson.version !== "5.0.0") {
  throw new Error(`Stage 5 requires application version 5.0.0; found ${packageJson.version}.`);
}

console.log(`Application version ${packageJson.version} is consistent; package.json is authoritative.`);
