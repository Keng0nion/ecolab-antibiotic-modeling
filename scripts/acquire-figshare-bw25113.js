import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");

export const SOURCE_METADATA = Object.freeze({
  id: "figshare-bw25113-growth-v1",
  datasetDoi: "10.6084/m9.figshare.28342064.v1",
  articleDoi: "10.1038/s41597-025-05356-3",
  title: "Bacterial growth profiles across one-thousand chemical-defined media",
  authors: Object.freeze(["Honoka Aida", "Bei-Wen Ying"]),
  figshareUrl: "https://figshare.com/articles/dataset/Bacterial_growth_profiles_across_one-thousand_chemical-defined_media/28342064",
  publishedDate: "2025-05-23T01:20:20Z",
  license: Object.freeze({
    id: "CC-BY-4.0",
    name: "Creative Commons Attribution 4.0 International",
    url: "https://creativecommons.org/licenses/by/4.0/",
    redistributionStatus: "redistributable_with_attribution",
  }),
});

export const SOURCE_FILES = Object.freeze([
  Object.freeze({
    id: "growth-round01",
    name: "BW25113_Growth_Round01.xlsx",
    url: "https://ndownloader.figshare.com/files/53453711",
    bytes: 1_004_441,
    md5: "c24e2d5b0b54c79a55b11d8868e73ad8",
    sha256: "d81c738fdf7885195203de9b8b28bc221cf81992dffe1288c42b81aa6876d921",
  }),
  Object.freeze({
    id: "medium-composition",
    name: "BW25113_Medium composition.xlsx",
    url: "https://ndownloader.figshare.com/files/53453759",
    bytes: 2_693_064,
    md5: "eab20d0936d82546e073e41005f313a9",
    sha256: "e3d82236c0f9a65cff55bebf1d5478b15a0972111422c32a3395deb5c5509cdd",
  }),
  Object.freeze({
    id: "growth-evaluation",
    name: "BW25113_GrowthDataEvaluation.xlsx",
    url: "https://ndownloader.figshare.com/files/53453777",
    bytes: 769_714,
    md5: "6df4248797486cb5ecbafd598fb7d28e",
    sha256: "2ae299c04f6a4de7401d3896413030db050b28691764be7940da471f351e03b1",
  }),
]);

function digest(algorithm, buffer) {
  return createHash(algorithm).update(buffer).digest("hex");
}

export function verifySourceBuffer(buffer, specification) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError(`${specification.name} must be provided as a Buffer.`);
  const actual = {
    bytes: buffer.length,
    md5: digest("md5", buffer),
    sha256: digest("sha256", buffer),
  };
  for (const key of ["bytes", "md5", "sha256"]) {
    if (actual[key] !== specification[key]) {
      throw new Error(
        `${specification.name} failed ${key} verification: expected ${specification[key]}, received ${actual[key]}.`,
      );
    }
  }
  return actual;
}

async function download(specification) {
  const response = await fetch(specification.url, {
    headers: { "user-agent": "ecolab-verified-data-acquisition/1.0" },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`Download failed for ${specification.name}: HTTP ${response.status}.`);
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) !== specification.bytes) {
    throw new Error(
      `${specification.name} advertised ${contentLength} bytes; expected ${specification.bytes}.`,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  verifySourceBuffer(buffer, specification);
  return buffer;
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, contents, { flag: "wx" });
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export function acquisitionManifest() {
  return {
    schemaVersion: "1.0.0",
    datasetId: SOURCE_METADATA.id,
    source: {
      title: SOURCE_METADATA.title,
      authors: [...SOURCE_METADATA.authors],
      datasetDoi: SOURCE_METADATA.datasetDoi,
      articleDoi: SOURCE_METADATA.articleDoi,
      url: SOURCE_METADATA.figshareUrl,
      publishedDate: SOURCE_METADATA.publishedDate,
      license: { ...SOURCE_METADATA.license },
    },
    policy: {
      verification: "Each source payload must match the declared byte count, MD5, and SHA-256 before it is stored.",
      transformation: "None. The XLSX files are stored byte-for-byte.",
    },
    files: SOURCE_FILES.map((file) => ({
      id: file.id,
      name: file.name,
      url: file.url,
      bytes: file.bytes,
      md5: file.md5,
      sha256: file.sha256,
    })),
  };
}

export async function acquireFigshareDataset(options = {}) {
  const outputDirectory = path.resolve(
    options.outputDirectory ?? path.join(projectRoot, "data/raw/figshare-bw25113-growth-v1"),
  );
  const sourceDirectory = options.sourceDirectory ? path.resolve(options.sourceDirectory) : null;
  const verifiedPayloads = [];
  for (const specification of SOURCE_FILES) {
    const buffer = sourceDirectory
      ? await readFile(path.join(sourceDirectory, specification.name))
      : await download(specification);
    verifySourceBuffer(buffer, specification);
    verifiedPayloads.push({ specification, buffer });
  }

  await mkdir(outputDirectory, { recursive: true });
  for (const { specification, buffer } of verifiedPayloads) {
    await atomicWrite(path.join(outputDirectory, specification.name), buffer);
  }

  const manifestText = `${JSON.stringify(acquisitionManifest(), null, 2)}\n`;
  await atomicWrite(path.join(outputDirectory, "acquisition.json"), manifestText);
  return {
    outputDirectory,
    files: SOURCE_FILES.map((file) => path.join(outputDirectory, file.name)),
    manifest: path.join(outputDirectory, "acquisition.json"),
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--source-dir" || argument === "--output-dir") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a path.`);
      if (argument === "--source-dir") options.sourceDirectory = value;
      else options.outputDirectory = value;
      index += 1;
    } else if (argument === "--help") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/acquire-figshare-bw25113.js [--source-dir PATH] [--output-dir PATH]");
      console.log("Without --source-dir, all source XLSX files are downloaded from Figshare.");
    } else {
      const result = await acquireFigshareDataset(options);
      console.log(`Verified and stored ${result.files.length} source files in ${result.outputDirectory}.`);
      console.log(`Acquisition metadata: ${result.manifest}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
