import path from "node:path";
import fs from "fs-extra";
import type { ProjectConfig } from "../types";
import { CirronIgnore } from "./ignore";

/**
 * Shared artifact-addressing and file-collection logic for push, pull and
 * sync. These were copied between push.ts and sync.ts (collection) and
 * push.ts and pull.ts (name/tag parsing); the copies were verified identical
 * apart from a parameter name before being moved here.
 */

/** Resource types the registry addresses artifacts by. */
export type ResourceType = "model" | "image" | "build" | "runtime";

export const KNOWN_RESOURCE_TYPES: ResourceType[] = [
  "model",
  "image",
  "build",
  "runtime",
];

/**
 * Whether a token names a known resource type rather than a path or name.
 *
 * @param resource - The first positional argument to push or pull.
 * @returns True when it is one of the known resource types.
 */
export function isResourceTyped(resource: string): boolean {
  return KNOWN_RESOURCE_TYPES.includes(resource as ResourceType);
}

/**
 * Split a `name:tag` argument.
 *
 * Uses the LAST colon so a registry-qualified name keeps its host portion,
 * and requires a non-zero index so a leading colon is not read as an empty
 * name.
 */
export function parseNameTag(nameArg: string): { name: string; tag?: string } {
  const colonIndex = nameArg.lastIndexOf(":");
  if (colonIndex > 0) {
    return {
      name: nameArg.slice(0, colonIndex),
      tag: nameArg.slice(colonIndex + 1),
    };
  }
  return { name: nameArg };
}

/**
 * Every file under `targetPath`, or the file itself when it is not a dir.
 *
 * @returns Absolute paths of every file found, empty when the directory does
 * not exist.
 */
export async function collectFiles(targetPath: string): Promise<string[]> {
  const resolved = path.resolve(targetPath);
  const stat = await fs.stat(resolved);

  if (stat.isFile()) {
    return [resolved];
  }

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    // withFileTypes saves a stat per entry, but Dirents do not follow
    // symlinks, so those keep their own branch below to stay collected.
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const linkStat = await fs.stat(fullPath);
        if (linkStat.isDirectory()) {
          await walk(fullPath);
        } else {
          files.push(fullPath);
        }
      } else if (entry.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  await walk(resolved);
  return files;
}

/**
 * Collect a project's artifact files: configured artifact paths plus the
 * conventional output directories, deduplicated and filtered.
 *
 * `excludePatterns` is a comma-separated list layered on top of
 * `.cirronignore`. It carries `push --ignore` and `sync --exclude`; the flag
 * names stay distinct on the command line, only this parameter is unified.
 * @returns Absolute paths of the files to upload, after ignore filtering;
 * empty when nothing matches.
 */
export async function collectProjectFiles(
  projectConfig: ProjectConfig,
  excludePatterns: string | undefined
): Promise<string[]> {
  const cwd = process.cwd();
  const pathsToScan: string[] = [];

  if (projectConfig.artifacts) {
    if (projectConfig.artifacts.modelPath) {
      pathsToScan.push(path.join(cwd, projectConfig.artifacts.modelPath));
    }
    if (projectConfig.artifacts.checkpointPath) {
      pathsToScan.push(path.join(cwd, projectConfig.artifacts.checkpointPath));
    }
  }

  const commonDirs = ["models", "artifacts", "build"];
  for (const dir of commonDirs) {
    const dirPath = path.join(cwd, dir);
    if (await fs.pathExists(dirPath)) {
      pathsToScan.push(dirPath);
    }
  }

  let allFiles: string[] = [];
  for (const scanPath of pathsToScan) {
    if (await fs.pathExists(scanPath)) {
      const files = await collectFiles(scanPath);
      allFiles.push(...files);
    }
  }

  // Deduplicate
  allFiles = [...new Set(allFiles)];

  // Apply .cirronignore + the command's exclude patterns
  const ignore = new CirronIgnore();
  if (excludePatterns) {
    const patterns = excludePatterns.split(",").map((p) => p.trim());
    for (const pattern of patterns) {
      ignore.addPattern(pattern);
    }
  }
  allFiles = allFiles.filter((f) => !ignore.isIgnored(path.relative(cwd, f)));

  return allFiles;
}
