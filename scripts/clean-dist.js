import { mkdir, rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const dist = new URL("dist/", root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
console.log("Cleaned dist/ for a full build.");
