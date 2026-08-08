import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import ora from "ora";
import type {
  ProjectConfig,
  PullArtifactInfo,
  PushFileInfo,
  SyncChangedFileEntry,
  SyncConflictEntry,
  SyncConflictResolution,
  SyncConflictStrategy,
  SyncDiffResult,
  SyncFileManifestEntry,
  SyncOptions,
  SyncRemoteFileEntry,
  SyncSummary,
} from "../types";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import { collectFiles, collectProjectFiles } from "../utils/artifacts";
import { computeFileChecksum } from "../utils/checksum";
import { mapWithConcurrency } from "../utils/concurrency";
import { ConfigManager } from "../utils/config";
import { formatSize } from "../utils/format";
import { CirronIgnore } from "../utils/ignore";
import { logger } from "../utils/logger";
import { loadProjectConfigOrNull as loadProjectConfig } from "../utils/project-config";
import { resolveWithin } from "../utils/safe-path";
import { downloadArtifact } from "./pull";
import { uploadSingleFile } from "./push";

// --- Constants ---

const VALID_CONFLICT_STRATEGIES: SyncConflictStrategy[] = [
  "keep-both",
  "local-wins",
  "remote-wins",
  "prompt",
];

/**
 * Files hashed at once while building the local manifest. Disk-and-CPU bound
 * rather than network-bound, so higher than the upload concurrency.
 */
const CHECKSUM_CONCURRENCY = 8;

// --- Helpers ---

function checkAuth(): { api: CirronApi } | null {
  const configManager = new ConfigManager();
  const currentConfig = configManager.load();

  if (!(currentConfig.token || currentConfig.auth?.accessToken)) {
    logger.error("Not authenticated");
    logger.info(`Run ${chalk.cyan("cirron auth login")} to authenticate`);
    return null;
  }

  return { api: new CirronApi(currentConfig) };
}

// --- Type Adapters ---

function toArtifactInfo(
  entry: SyncRemoteFileEntry | SyncChangedFileEntry
): PullArtifactInfo {
  if ("remoteChecksum" in entry) {
    return {
      id: entry.artifactId,
      name: entry.artifactName,
      type: entry.type,
      tag: entry.tag,
      filename: path.basename(entry.path),
      size: entry.remoteSize,
      checksum: entry.remoteChecksum,
      createdAt: new Date().toISOString(),
    };
  }
  return {
    id: entry.artifactId,
    name: entry.artifactName,
    type: entry.type,
    tag: entry.tag,
    filename: path.basename(entry.path),
    size: entry.size,
    checksum: entry.checksum,
    createdAt: entry.createdAt,
  };
}

function toFileInfo(
  entry: SyncFileManifestEntry | SyncChangedFileEntry
): PushFileInfo {
  if ("localChecksum" in entry) {
    return {
      filePath: path.resolve(process.cwd(), entry.path),
      relativePath: entry.path,
      size: entry.localSize,
      checksum: entry.localChecksum,
    };
  }
  return {
    filePath: path.resolve(process.cwd(), entry.path),
    relativePath: entry.path,
    size: entry.size,
    checksum: entry.checksum,
  };
}

function buildKeepBothPaths(filePath: string): {
  localPath: string;
  remotePath: string;
} {
  const ext = path.extname(filePath);
  const base = ext ? filePath.slice(0, -ext.length) : filePath;
  return {
    localPath: `${base}.local${ext}`,
    remotePath: `${base}.remote${ext}`,
  };
}

// --- Validation ---

function validateSyncOptions(options: SyncOptions): SyncConflictStrategy {
  if (options.pushOnly && options.pullOnly) {
    logger.error("Cannot use --push-only and --pull-only together");
    process.exit(1);
  }

  if (options.force && !options.pushOnly && !options.pullOnly) {
    logger.error(
      "--force requires --push-only or --pull-only to determine sync direction"
    );
    logger.info(
      "Use --push-only --force to push all local changes, or --pull-only --force to pull all remote changes"
    );
    process.exit(1);
  }

  const conflictStrategy = (options.conflicts ||
    "prompt") as SyncConflictStrategy;
  if (!VALID_CONFLICT_STRATEGIES.includes(conflictStrategy)) {
    logger.error(`Invalid conflict strategy: "${options.conflicts}"`);
    logger.info(`Valid strategies: ${VALID_CONFLICT_STRATEGIES.join(", ")}`);
    process.exit(1);
  }

  return conflictStrategy;
}

// --- Local Manifest ---

async function buildLocalManifest(
  syncPath: string | undefined,
  options: SyncOptions,
  projectConfig: ProjectConfig
): Promise<SyncFileManifestEntry[]> {
  let filePaths: string[];

  if (syncPath) {
    const resolved = path.resolve(syncPath);
    if (!(await fs.pathExists(resolved))) {
      logger.error(`Path not found: ${syncPath}`);
      process.exit(1);
    }
    filePaths = await collectFiles(resolved);
  } else {
    filePaths = await collectProjectFiles(projectConfig, options.exclude);
  }

  if (filePaths.length === 0) {
    return [];
  }

  return await mapWithConcurrency(
    filePaths,
    CHECKSUM_CONCURRENCY,
    async (fp): Promise<SyncFileManifestEntry> => {
      const stat = await fs.stat(fp);
      const checksum = await computeFileChecksum(fp);
      return {
        path: path.relative(process.cwd(), fp),
        checksum,
        size: stat.size,
      };
    }
  );
}

// --- Filtering ---

function applySyncFilters(
  diff: SyncDiffResult,
  options: SyncOptions
): SyncDiffResult {
  let result: SyncDiffResult = {
    localOnly: [...diff.localOnly],
    remoteOnly: [...diff.remoteOnly],
    changedLocally: [...diff.changedLocally],
    changedRemotely: [...diff.changedRemotely],
    conflicts: [...diff.conflicts],
    unchanged: [...diff.unchanged],
  };

  if (options.pushOnly) {
    result.remoteOnly = [];
    result.changedRemotely = [];
    if (options.force) {
      // Conflicts become local-wins pushes
      const movedToLocal: SyncChangedFileEntry[] = result.conflicts.map(
        (c) => ({
          path: c.path,
          localChecksum: c.localChecksum,
          remoteChecksum: c.remoteChecksum,
          localSize: c.localSize,
          remoteSize: c.remoteSize,
          artifactId: c.artifactId,
          artifactName: c.artifactName,
          type: c.type,
          tag: c.tag,
        })
      );
      result.changedLocally = [...result.changedLocally, ...movedToLocal];
      result.conflicts = [];
    }
  }

  if (options.pullOnly) {
    result.localOnly = [];
    result.changedLocally = [];
    if (options.force) {
      // Conflicts become remote-wins pulls
      const movedToRemote: SyncChangedFileEntry[] = result.conflicts.map(
        (c) => ({
          path: c.path,
          localChecksum: c.localChecksum,
          remoteChecksum: c.remoteChecksum,
          localSize: c.localSize,
          remoteSize: c.remoteSize,
          artifactId: c.artifactId,
          artifactName: c.artifactName,
          type: c.type,
          tag: c.tag,
        })
      );
      result.changedRemotely = [...result.changedRemotely, ...movedToRemote];
      result.conflicts = [];
    }
  }

  // Re-apply exclude patterns to all categories as defense in depth
  if (options.exclude) {
    const ignore = new CirronIgnore();
    const patterns = options.exclude.split(",").map((p) => p.trim());
    for (const pattern of patterns) {
      ignore.addPattern(pattern);
    }
    const isExcluded = (filePath: string): boolean =>
      ignore.isIgnored(filePath);

    result = {
      localOnly: result.localOnly.filter((f) => !isExcluded(f.path)),
      remoteOnly: result.remoteOnly.filter((f) => !isExcluded(f.path)),
      changedLocally: result.changedLocally.filter((f) => !isExcluded(f.path)),
      changedRemotely: result.changedRemotely.filter(
        (f) => !isExcluded(f.path)
      ),
      conflicts: result.conflicts.filter((f) => !isExcluded(f.path)),
      unchanged: result.unchanged.filter((f) => !isExcluded(f.path)),
    };
  }

  return result;
}

// --- Dry Run ---

function printSyncDryRun(diff: SyncDiffResult, options: SyncOptions): void {
  if (options.json) {
    const toPush = diff.localOnly.length + diff.changedLocally.length;
    const toPull = diff.remoteOnly.length + diff.changedRemotely.length;

    const jsonResult: Record<string, unknown> = {
      localOnly: diff.localOnly.map((f) => ({
        path: f.path,
        checksum: f.checksum,
        size: f.size,
        action: "push",
      })),
      remoteOnly: diff.remoteOnly.map((f) => ({
        path: f.path,
        checksum: f.checksum,
        size: f.size,
        action: "pull",
      })),
      changedLocally: diff.changedLocally.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: "push",
      })),
      changedRemotely: diff.changedRemotely.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: "pull",
      })),
      conflicts: diff.conflicts.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: "conflict",
      })),
      unchanged: diff.unchanged.length,
      summary: {
        toPush,
        toPull,
        conflicts: diff.conflicts.length,
        unchanged: diff.unchanged.length,
      },
    };
    console.log(JSON.stringify(jsonResult, null, 2));
    return;
  }

  logger.info(
    chalk.bold("Sync dry run - the following changes would be applied:")
  );
  console.log();

  // Push (local only)
  if (diff.localOnly.length > 0) {
    logger.info(
      `  ${chalk.green("Push (local only):")} ${diff.localOnly.length} file(s)`
    );
    diff.localOnly.forEach((f, i) => {
      logger.info(
        `    ${i + 1}. ${chalk.cyan(f.path)} (${formatSize(f.size)})`
      );
      if (options.verbose) {
        logger.info(`       Checksum: ${f.checksum.slice(0, 12)}...`);
      }
    });
    console.log();
  }

  // Pull (remote only)
  if (diff.remoteOnly.length > 0) {
    logger.info(
      `  ${chalk.blue("Pull (remote only):")} ${diff.remoteOnly.length} file(s)`
    );
    diff.remoteOnly.forEach((f, i) => {
      logger.info(
        `    ${i + 1}. ${chalk.cyan(f.path)} (${formatSize(f.size)})`
      );
      if (options.verbose) {
        logger.info(`       Checksum: ${f.checksum.slice(0, 12)}...`);
      }
    });
    console.log();
  }

  // Push (changed locally)
  if (diff.changedLocally.length > 0) {
    logger.info(
      `  ${chalk.green("Push (changed locally):")} ${diff.changedLocally.length} file(s)`
    );
    diff.changedLocally.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(
        `       Local:  ${f.localChecksum.slice(0, 12)}... (${formatSize(f.localSize)})`
      );
      logger.info(
        `       Remote: ${f.remoteChecksum.slice(0, 12)}... (${formatSize(f.remoteSize)})`
      );
    });
    console.log();
  }

  // Pull (changed remotely)
  if (diff.changedRemotely.length > 0) {
    logger.info(
      `  ${chalk.blue("Pull (changed remotely):")} ${diff.changedRemotely.length} file(s)`
    );
    diff.changedRemotely.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(
        `       Local:  ${f.localChecksum.slice(0, 12)}... (${formatSize(f.localSize)})`
      );
      logger.info(
        `       Remote: ${f.remoteChecksum.slice(0, 12)}... (${formatSize(f.remoteSize)})`
      );
    });
    console.log();
  }

  // Conflicts
  if (diff.conflicts.length > 0) {
    logger.info(
      `  ${chalk.yellow("Conflicts:")} ${diff.conflicts.length} file(s)`
    );
    diff.conflicts.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(
        `       Local:  ${f.localChecksum.slice(0, 12)}... (${formatSize(f.localSize)})`
      );
      logger.info(
        `       Remote: ${f.remoteChecksum.slice(0, 12)}... (${formatSize(f.remoteSize)})`
      );
    });
    console.log();
  }

  // Unchanged
  logger.info(`  ${chalk.gray("Unchanged:")} ${diff.unchanged.length} file(s)`);
  if (options.verbose && diff.unchanged.length > 0) {
    diff.unchanged.forEach((f, i) => {
      logger.info(
        `    ${i + 1}. ${chalk.gray(f.path)} (${formatSize(f.size)})`
      );
    });
  }
  console.log();

  // Summary line
  const toPush = diff.localOnly.length + diff.changedLocally.length;
  const toPull = diff.remoteOnly.length + diff.changedRemotely.length;
  logger.info(
    `  Summary: ${chalk.green(`${toPush} to push`)}, ${chalk.blue(`${toPull} to pull`)}, ` +
      `${chalk.yellow(`${diff.conflicts.length} conflict(s)`)}, ${chalk.gray(`${diff.unchanged.length} unchanged`)}`
  );
  logger.info(
    chalk.gray("  No changes were applied. Remove --dry-run to sync.")
  );
}

// --- Conflict Resolution ---

async function promptConflictResolution(
  conflict: SyncConflictEntry,
  index: number,
  total: number,
  lastChoice: SyncConflictResolution | null
): Promise<SyncConflictResolution | "apply-all"> {
  console.log();
  logger.info(chalk.bold(`Conflict (${index + 1}/${total}): ${conflict.path}`));
  logger.info(
    `  Local:  ${conflict.localChecksum.slice(0, 12)}... (${formatSize(conflict.localSize)})`
  );
  logger.info(
    `  Remote: ${conflict.remoteChecksum.slice(0, 12)}... (${formatSize(conflict.remoteSize)})`
  );

  const choices: Array<{ name: string; value: string }> = [
    { name: "Skip (leave unchanged)", value: "skip" },
    { name: "Use local version (push to remote)", value: "overwrite-remote" },
    { name: "Use remote version (pull to local)", value: "overwrite-local" },
    {
      name: "Keep both (create .local and .remote copies)",
      value: "keep-both",
    },
  ];

  // After first conflict, offer "apply same to remaining"
  if (lastChoice !== null && index < total - 1) {
    const remaining = total - index;
    const choiceLabel =
      lastChoice === "skip"
        ? "Skip"
        : lastChoice === "overwrite-remote"
          ? "Use local version"
          : lastChoice === "overwrite-local"
            ? "Use remote version"
            : "Keep both";
    choices.push({
      name: `Apply "${choiceLabel}" to remaining ${remaining} conflict(s)`,
      value: "apply-all",
    });
  }

  const { resolution } = await inquirer.prompt([
    {
      type: "select",
      name: "resolution",
      message: "How would you like to resolve this conflict?",
      choices,
      loop: false,
    },
  ]);

  return resolution;
}

// --- Sync Execution ---

async function pushSyncFiles(
  api: CirronApi,
  files: Array<SyncFileManifestEntry | SyncChangedFileEntry>,
  label: string
): Promise<{
  succeeded: number;
  failed: number;
  pushed: Array<{ path: string; checksum: string; artifactId: string }>;
}> {
  let succeeded = 0;
  let failed = 0;
  const pushed: Array<{ path: string; checksum: string; artifactId: string }> =
    [];

  for (const file of files) {
    const fileInfo = toFileInfo(file);
    const itemSpinner = ora(
      `${label}: ${fileInfo.relativePath} (${formatSize(fileInfo.size)})...`
    ).start();

    try {
      const result = await uploadSingleFile(api, fileInfo, {}, itemSpinner);

      if (result.skipped) {
        itemSpinner.info(
          `Skipped ${chalk.cyan(fileInfo.relativePath)} (${result.skipReason})`
        );
      } else {
        itemSpinner.succeed(
          `Pushed ${chalk.cyan(fileInfo.relativePath)} (${formatSize(fileInfo.size)})`
        );
      }

      succeeded++;
      // Only track for sync metadata if we have a valid artifact ID
      // (deduped uploads may return an empty ID)
      if (result.artifact.id) {
        pushed.push({
          path: fileInfo.relativePath,
          checksum: fileInfo.checksum,
          artifactId: result.artifact.id,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      itemSpinner.fail(`Failed to push ${fileInfo.relativePath}: ${msg}`);
      failed++;
    }
  }

  return { succeeded, failed, pushed };
}

async function pullSyncFiles(
  api: CirronApi,
  files: Array<SyncRemoteFileEntry | SyncChangedFileEntry>,
  label: string
): Promise<{
  succeeded: number;
  failed: number;
  pulled: Array<{ path: string; checksum: string; artifactId: string }>;
}> {
  let succeeded = 0;
  let failed = 0;
  const pulled: Array<{ path: string; checksum: string; artifactId: string }> =
    [];

  const cwd = process.cwd();

  for (const file of files) {
    const artifactInfo = toArtifactInfo(file);
    const itemSpinner = ora(`${label}: ${file.path}...`).start();

    // Validate the resolved path stays within the project directory
    const destPath = resolveWithin(cwd, file.path);
    if (!destPath) {
      itemSpinner.fail(`Rejected ${file.path}: path traversal detected`);
      failed++;
      continue;
    }

    try {
      await fs.ensureDir(path.dirname(destPath));
      await downloadArtifact(api, artifactInfo, destPath, itemSpinner);

      itemSpinner.succeed(
        `Pulled ${chalk.cyan(file.path)} (${formatSize(artifactInfo.size)})`
      );
      succeeded++;
      pulled.push({
        path: file.path,
        checksum: artifactInfo.checksum,
        artifactId: artifactInfo.id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error";
      itemSpinner.fail(`Failed to pull ${file.path}: ${msg}`);
      failed++;
    }
  }

  return { succeeded, failed, pulled };
}

interface ConflictEntryRecord {
  artifactId: string;
  checksum: string;
  path: string;
}

interface ConflictOutcome {
  ok: boolean;
  pulled?: ConflictEntryRecord;
  pushed?: ConflictEntryRecord;
}

/**
 * The three conflict resolutions, each written once.
 *
 * Both the batch-strategy loop and the interactive loop call these; only the
 * spinner's starting label differs between them, so it is a parameter. The
 * success and failure strings are identical in both and stay here.
 *
 * A rejected path and a thrown error both report `ok: false`, which the
 * callers count as a failure exactly as the inlined copies did.
 */
async function resolveByPush(
  api: CirronApi,
  conflict: SyncConflictEntry,
  startLabel: string
): Promise<ConflictOutcome> {
  const itemSpinner = ora(startLabel).start();

  // Guarded even though this action only READS locally and uploads: the path
  // is server-supplied, so an unguarded resolve lets a hostile response name
  // any readable file and have the CLI upload it.
  if (!resolveWithin(process.cwd(), conflict.path)) {
    itemSpinner.fail(`Rejected ${conflict.path}: path traversal detected`);
    return { ok: false };
  }

  try {
    const fileInfo = toFileInfo(conflict);
    const result = await uploadSingleFile(api, fileInfo, {}, itemSpinner);
    itemSpinner.succeed(
      `Resolved ${chalk.cyan(conflict.path)} -> pushed local version`
    );
    return {
      ok: true,
      pushed: {
        path: conflict.path,
        checksum: fileInfo.checksum,
        artifactId: result.artifact.id,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
    return { ok: false };
  }
}

async function resolveByPull(
  api: CirronApi,
  conflict: SyncConflictEntry,
  startLabel: string
): Promise<ConflictOutcome> {
  const itemSpinner = ora(startLabel).start();

  const destPath = resolveWithin(process.cwd(), conflict.path);
  if (!destPath) {
    itemSpinner.fail(`Rejected ${conflict.path}: path traversal detected`);
    return { ok: false };
  }

  try {
    const artifactInfo = toArtifactInfo(conflict);
    await fs.ensureDir(path.dirname(destPath));
    await downloadArtifact(api, artifactInfo, destPath, itemSpinner);
    itemSpinner.succeed(
      `Resolved ${chalk.cyan(conflict.path)} -> pulled remote version`
    );
    return {
      ok: true,
      pulled: {
        path: conflict.path,
        checksum: artifactInfo.checksum,
        artifactId: artifactInfo.id,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
    return { ok: false };
  }
}

async function resolveByKeepBoth(
  api: CirronApi,
  conflict: SyncConflictEntry,
  startLabel: string
): Promise<ConflictOutcome> {
  const itemSpinner = ora(startLabel).start();

  // buildKeepBothPaths only appends suffixes, so guarding the original
  // covers the .local/.remote destinations too.
  const originalPath = resolveWithin(process.cwd(), conflict.path);
  if (!originalPath) {
    itemSpinner.fail(`Rejected ${conflict.path}: path traversal detected`);
    return { ok: false };
  }

  try {
    const { localPath, remotePath } = buildKeepBothPaths(originalPath);

    await fs.copy(originalPath, localPath);

    const artifactInfo = toArtifactInfo(conflict);
    await downloadArtifact(api, artifactInfo, remotePath, itemSpinner);

    const relLocal = path.relative(process.cwd(), localPath);
    const relRemote = path.relative(process.cwd(), remotePath);
    itemSpinner.succeed(
      `Resolved ${chalk.cyan(conflict.path)} -> kept both (${relLocal}, ${relRemote})`
    );
    return {
      ok: true,
      // NOTE (backlog SYNC-02): this records the REMOTE checksum as the
      // baseline for the untouched local file, so the next sync reports a
      // spurious changedLocally. Preserved verbatim by the extraction; the
      // fix is now a one-site change.
      pulled: {
        path: conflict.path,
        checksum: artifactInfo.checksum,
        artifactId: artifactInfo.id,
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
    return { ok: false };
  }
}

async function resolveConflicts(
  api: CirronApi,
  conflicts: SyncConflictEntry[],
  strategy: SyncConflictStrategy
): Promise<{
  resolved: number;
  skipped: number;
  failed: number;
  pushed: Array<{ path: string; checksum: string; artifactId: string }>;
  pulled: Array<{ path: string; checksum: string; artifactId: string }>;
}> {
  let resolved = 0;
  let skipped = 0;
  let failed = 0;
  const pushed: Array<{ path: string; checksum: string; artifactId: string }> =
    [];
  const pulled: Array<{ path: string; checksum: string; artifactId: string }> =
    [];

  const record = (outcome: ConflictOutcome): void => {
    if (outcome.ok) {
      resolved++;
      if (outcome.pushed) {
        pushed.push(outcome.pushed);
      }
      if (outcome.pulled) {
        pulled.push(outcome.pulled);
      }
    } else {
      failed++;
    }
  };

  if (conflicts.length === 0) {
    return { resolved, skipped, failed, pushed, pulled };
  }

  // Non-interactive strategies
  if (strategy === "local-wins") {
    for (const conflict of conflicts) {
      record(
        await resolveByPush(
          api,
          conflict,
          `Resolving conflict (local-wins): ${conflict.path}...`
        )
      );
    }
    return { resolved, skipped, failed, pushed, pulled };
  }

  if (strategy === "remote-wins") {
    for (const conflict of conflicts) {
      record(
        await resolveByPull(
          api,
          conflict,
          `Resolving conflict (remote-wins): ${conflict.path}...`
        )
      );
    }
    return { resolved, skipped, failed, pushed, pulled };
  }

  if (strategy === "keep-both") {
    for (const conflict of conflicts) {
      record(
        await resolveByKeepBoth(
          api,
          conflict,
          `Resolving conflict (keep-both): ${conflict.path}...`
        )
      );
    }
    return { resolved, skipped, failed, pushed, pulled };
  }

  // Interactive prompt strategy
  let lastChoice: SyncConflictResolution | null = null;
  let applyAllChoice: SyncConflictResolution | null = null;

  for (let i = 0; i < conflicts.length; i++) {
    const conflict = conflicts[i]!;

    let resolution: SyncConflictResolution;
    if (applyAllChoice) {
      resolution = applyAllChoice;
    } else {
      const answer = await promptConflictResolution(
        conflict,
        i,
        conflicts.length,
        lastChoice
      );
      if (answer === "apply-all") {
        applyAllChoice = lastChoice;
        resolution = lastChoice!;
      } else {
        resolution = answer;
        lastChoice = resolution;
      }
    }

    if (resolution === "skip") {
      logger.info(`  Skipped ${chalk.gray(conflict.path)}`);
      skipped++;
      continue;
    }

    if (resolution === "overwrite-remote") {
      record(await resolveByPush(api, conflict, `Pushing ${conflict.path}...`));
      continue;
    }

    if (resolution === "overwrite-local") {
      record(await resolveByPull(api, conflict, `Pulling ${conflict.path}...`));
      continue;
    }

    if (resolution === "keep-both") {
      record(
        await resolveByKeepBoth(
          api,
          conflict,
          `Keeping both versions of ${conflict.path}...`
        )
      );
    }
  }

  return { resolved, skipped, failed, pushed, pulled };
}

interface SyncPlanResult {
  pulled: Array<{ path: string; checksum: string; artifactId: string }>;
  pushed: Array<{ path: string; checksum: string; artifactId: string }>;
  summary: SyncSummary;
}

async function executeSyncPlan(
  api: CirronApi,
  diff: SyncDiffResult,
  strategy: SyncConflictStrategy,
  _options: SyncOptions
): Promise<SyncPlanResult> {
  const summary: SyncSummary = {
    pushed: 0,
    pulled: 0,
    conflictsResolved: 0,
    conflictsSkipped: 0,
    unchanged: diff.unchanged.length,
    failed: 0,
    totalLocalOnly: diff.localOnly.length,
    totalRemoteOnly: diff.remoteOnly.length,
    totalChangedLocally: diff.changedLocally.length,
    totalChangedRemotely: diff.changedRemotely.length,
    totalConflicts: diff.conflicts.length,
  };

  const allPushed: Array<{
    path: string;
    checksum: string;
    artifactId: string;
  }> = [];
  const allPulled: Array<{
    path: string;
    checksum: string;
    artifactId: string;
  }> = [];

  // 1. Pull remote-only files
  if (diff.remoteOnly.length > 0) {
    logger.info(
      chalk.bold(`\nPulling ${diff.remoteOnly.length} new remote file(s)...`)
    );
    const pullResult = await pullSyncFiles(api, diff.remoteOnly, "Pull (new)");
    summary.pulled += pullResult.succeeded;
    summary.failed += pullResult.failed;
    allPulled.push(...pullResult.pulled);
  }

  // 2. Pull changed-remotely files
  if (diff.changedRemotely.length > 0) {
    logger.info(
      chalk.bold(
        `\nPulling ${diff.changedRemotely.length} updated remote file(s)...`
      )
    );
    const pullResult = await pullSyncFiles(
      api,
      diff.changedRemotely,
      "Pull (updated)"
    );
    summary.pulled += pullResult.succeeded;
    summary.failed += pullResult.failed;
    allPulled.push(...pullResult.pulled);
  }

  // 3. Push local-only files
  if (diff.localOnly.length > 0) {
    logger.info(
      chalk.bold(`\nPushing ${diff.localOnly.length} new local file(s)...`)
    );
    const pushResult = await pushSyncFiles(api, diff.localOnly, "Push (new)");
    summary.pushed += pushResult.succeeded;
    summary.failed += pushResult.failed;
    allPushed.push(...pushResult.pushed);
  }

  // 4. Push changed-locally files
  if (diff.changedLocally.length > 0) {
    logger.info(
      chalk.bold(
        `\nPushing ${diff.changedLocally.length} updated local file(s)...`
      )
    );
    const pushResult = await pushSyncFiles(
      api,
      diff.changedLocally,
      "Push (updated)"
    );
    summary.pushed += pushResult.succeeded;
    summary.failed += pushResult.failed;
    allPushed.push(...pushResult.pushed);
  }

  // 5. Resolve conflicts
  if (diff.conflicts.length > 0) {
    logger.info(
      chalk.bold(`\nResolving ${diff.conflicts.length} conflict(s)...`)
    );
    const conflictResult = await resolveConflicts(
      api,
      diff.conflicts,
      strategy
    );
    summary.conflictsResolved += conflictResult.resolved;
    summary.conflictsSkipped += conflictResult.skipped;
    summary.failed += conflictResult.failed;
    allPushed.push(...conflictResult.pushed);
    allPulled.push(...conflictResult.pulled);
  }

  return { summary, pushed: allPushed, pulled: allPulled };
}

// --- Summary ---

function printSyncSummary(summary: SyncSummary, options: SyncOptions): void {
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const totalActions =
    summary.pushed +
    summary.pulled +
    summary.conflictsResolved +
    summary.conflictsSkipped;

  if (totalActions === 0 && summary.failed === 0) {
    logger.info(chalk.bold("\nAlready in sync."));
    logger.info(`  ${chalk.gray(`${summary.unchanged} file(s) unchanged`)}`);
    return;
  }

  console.log();
  logger.info(chalk.bold("Sync summary:"));
  if (summary.pushed > 0) {
    logger.info(`  Pushed:    ${chalk.green(String(summary.pushed))}`);
  }
  if (summary.pulled > 0) {
    logger.info(`  Pulled:    ${chalk.blue(String(summary.pulled))}`);
  }
  if (summary.totalConflicts > 0) {
    const conflictParts: string[] = [];
    if (summary.conflictsResolved > 0) {
      conflictParts.push(`${summary.conflictsResolved} resolved`);
    }
    if (summary.conflictsSkipped > 0) {
      conflictParts.push(`${summary.conflictsSkipped} skipped`);
    }
    logger.info(`  Conflicts: ${chalk.yellow(conflictParts.join(", "))}`);
  }
  if (summary.failed > 0) {
    logger.info(`  Failed:    ${chalk.red(String(summary.failed))}`);
  }
  logger.info(`  Unchanged: ${chalk.gray(String(summary.unchanged))}`);
}

// --- Main Entry Point ---

export async function syncCommand(
  syncPath: string | undefined,
  options: SyncOptions
): Promise<void> {
  // Validate options
  const conflictStrategy = validateSyncOptions(options);

  // Auth check
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  // Load project config
  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    logger.error(
      "No cirron config found (cirron.yaml or cirron.json) in current directory"
    );
    logger.info(`Run ${chalk.cyan("cirron init")} to initialize a project`);
    return;
  }

  // Build local manifest
  const manifestSpinner = ora("Scanning local files...").start();

  let manifest: SyncFileManifestEntry[];
  try {
    manifest = await buildLocalManifest(syncPath, options, projectConfig);
    if (manifest.length === 0 && !options.pullOnly) {
      manifestSpinner.info("No local artifact files found");
      logger.info(
        "Ensure your project config has artifacts configured, or specify a path."
      );
      return;
    }
    manifestSpinner.succeed(`Scanned ${manifest.length} local file(s)`);
  } catch (error) {
    manifestSpinner.fail("Failed to scan local files");
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }

  // Get diff from server
  const diffSpinner = ora("Computing sync diff with remote...").start();

  let diff: SyncDiffResult;
  try {
    diff = await api.getSyncDiff({
      projectName: projectConfig.name,
      manifest: manifest.map((m) => ({
        path: m.path,
        checksum: m.checksum,
        size: m.size,
      })),
    });
    diffSpinner.succeed("Sync diff computed");
  } catch (error) {
    diffSpinner.fail("Failed to compute sync diff");
    handlePlatformError(error);
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }

  // Apply filters
  diff = applySyncFilters(diff, options);

  // Check if there's anything to do
  const totalChanges =
    diff.localOnly.length +
    diff.remoteOnly.length +
    diff.changedLocally.length +
    diff.changedRemotely.length +
    diff.conflicts.length;

  if (totalChanges === 0) {
    logger.info(chalk.bold("\nAlready in sync."));
    logger.info(
      `  ${chalk.gray(`${diff.unchanged.length} file(s) unchanged`)}`
    );
    return;
  }

  // Dry run
  if (options.dryRun) {
    printSyncDryRun(diff, options);
    return;
  }

  // Execute sync
  const { summary, pushed, pulled } = await executeSyncPlan(
    api,
    diff,
    conflictStrategy,
    options
  );

  // Best-effort sync metadata update
  try {
    await api.completeSyncMetadata({
      projectName: projectConfig.name,
      pushed,
      pulled,
    });
  } catch {
    logger.warn(
      "Failed to update sync metadata on server. Sync completed successfully."
    );
  }

  // Print summary
  printSyncSummary(summary, options);

  // Exit with error if any failures
  if (summary.failed > 0) {
    process.exit(1);
  }
}
