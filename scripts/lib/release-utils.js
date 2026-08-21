import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

function optionValue(args, name) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith(prefix)) return argument.slice(prefix.length);
    if (argument === name) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${name} requires a path.`);
      return value;
    }
  }
  return null;
}

export function resolveDirectoryOption(args, name, defaultPath, rootPath) {
  const value = optionValue(args, name);
  const directory = value === null
    ? resolve(rootPath, defaultPath)
    : isAbsolute(value)
      ? resolve(value)
      : resolve(rootPath, value);
  const projectRelation = relative(rootPath, directory);
  const rootFromDirectory = relative(directory, rootPath);
  if (
    projectRelation === ""
    || projectRelation === "."
    || (rootFromDirectory !== "" && !rootFromDirectory.startsWith(`..${sep}`) && rootFromDirectory !== ".." && !isAbsolute(rootFromDirectory))
  ) {
    throw new Error(`${name} must not resolve to the project root or one of its ancestors.`);
  }
  return directory;
}

export function resolveFileOption(args, name, defaultPath, rootPath) {
  const value = optionValue(args, name);
  return value === null
    ? resolve(rootPath, defaultPath)
    : isAbsolute(value)
      ? resolve(value)
      : resolve(rootPath, value);
}

export function assertKnownOptions(args, options) {
  const known = new Set(options);
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const name = argument.split("=", 1)[0];
    if (!known.has(name)) throw new Error(`Unknown option: ${argument}`);
    if (!argument.includes("=") && index + 1 < args.length && !args[index + 1].startsWith("--")) {
      index += 1;
    }
  }
}

export function slashPath(value) {
  return value.split(sep).join("/");
}

export async function listFiles(directory) {
  const files = [];
  async function visit(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const absolutePath = resolve(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        files.push({ absolutePath, relativePath: slashPath(relativePath) });
      } else {
        throw new Error(`Release trees must not contain symbolic links or special files: ${absolutePath}`);
      }
    }
  }
  await visit(resolve(directory), "");
  return files;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function fileInventory(directory, prefix = "") {
  const files = await listFiles(directory);
  return Promise.all(files.map(async ({ absolutePath, relativePath }) => {
    const [content, metadata] = await Promise.all([readFile(absolutePath), stat(absolutePath)]);
    return {
      path: prefix ? `${prefix}/${relativePath}` : relativePath,
      relativePath,
      absolutePath,
      bytes: metadata.size,
      sha256: sha256(content),
    };
  }));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
}
