import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import inquirer from 'inquirer';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import { CirronIgnore } from '../utils/ignore';
import { uploadSingleFile, formatSize, computeFileChecksum } from './push';
import { downloadArtifact } from './pull';
import { loadProjectConfig as loadProjectConfigUtil } from '../utils/project-config';
import type {
  SyncOptions,
  SyncFileManifestEntry,
  SyncDiffResult,
  SyncRemoteFileEntry,
  SyncChangedFileEntry,
  SyncConflictEntry,
  SyncConflictStrategy,
  SyncConflictResolution,
  SyncSummary,
  ProjectConfig,
  PullArtifactInfo,
  PushFileInfo,
} from '../types';

// --- Constants ---

const VALID_CONFLICT_STRATEGIES: SyncConflictStrategy[] = ['keep-both', 'local-wins', 'remote-wins', 'prompt'];

// --- Helpers ---

function checkAuth(): { api: CirronApi } | null {
  const configManager = new ConfigManager();
  const currentConfig = configManager.load();

  if (!currentConfig.token && !currentConfig.auth?.accessToken) {
    logger.error('Not authenticated');
    logger.info(`Run ${chalk.cyan('cirron auth login')} to authenticate`);
    return null;
  }

  return { api: new CirronApi(currentConfig) };
}

function loadProjectConfig(): ProjectConfig | null {
  const result = loadProjectConfigUtil();
  if (!result) {
    return null;
  }
  return result.config;
}

async function collectFiles(targetPath: string): Promise<string[]> {
  const resolved = path.resolve(targetPath);
  const stat = await fs.stat(resolved);

  if (stat.isFile()) {
    return [resolved];
  }

  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry);
      const entryStat = await fs.stat(fullPath);
      if (entryStat.isDirectory()) {
        await walk(fullPath);
      } else {
        files.push(fullPath);
      }
    }
  };
  await walk(resolved);
  return files;
}

async function collectProjectFiles(
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

  const commonDirs = ['models', 'artifacts', 'build'];
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

  // Apply .cirronignore + --exclude patterns
  const ignore = new CirronIgnore();
  if (excludePatterns) {
    const patterns = excludePatterns.split(',').map((p) => p.trim());
    for (const pattern of patterns) {
      ignore.addPattern(pattern);
    }
  }
  allFiles = allFiles.filter((f) => !ignore.isIgnored(path.relative(cwd, f)));

  return allFiles;
}

// --- Type Adapters ---

function toArtifactInfo(entry: SyncRemoteFileEntry | SyncChangedFileEntry): PullArtifactInfo {
  if ('remoteChecksum' in entry) {
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

function toFileInfo(entry: SyncFileManifestEntry | SyncChangedFileEntry): PushFileInfo {
  if ('localChecksum' in entry) {
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

function buildKeepBothPaths(filePath: string): { localPath: string; remotePath: string } {
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
    logger.error('Cannot use --push-only and --pull-only together');
    process.exit(1);
  }

  if (options.force && !options.pushOnly && !options.pullOnly) {
    logger.error('--force requires --push-only or --pull-only to determine sync direction');
    logger.info('Use --push-only --force to push all local changes, or --pull-only --force to pull all remote changes');
    process.exit(1);
  }

  const conflictStrategy = (options.conflicts || 'prompt') as SyncConflictStrategy;
  if (!VALID_CONFLICT_STRATEGIES.includes(conflictStrategy)) {
    logger.error(`Invalid conflict strategy: "${options.conflicts}"`);
    logger.info(`Valid strategies: ${VALID_CONFLICT_STRATEGIES.join(', ')}`);
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
    if (!await fs.pathExists(resolved)) {
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

  const manifest: SyncFileManifestEntry[] = [];
  for (const fp of filePaths) {
    const stat = await fs.stat(fp);
    const checksum = await computeFileChecksum(fp);
    manifest.push({
      path: path.relative(process.cwd(), fp),
      checksum,
      size: stat.size,
    });
  }

  return manifest;
}

// --- Filtering ---

function applySyncFilters(diff: SyncDiffResult, options: SyncOptions): SyncDiffResult {
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
      const movedToLocal: SyncChangedFileEntry[] = result.conflicts.map((c) => ({
        path: c.path,
        localChecksum: c.localChecksum,
        remoteChecksum: c.remoteChecksum,
        localSize: c.localSize,
        remoteSize: c.remoteSize,
        artifactId: c.artifactId,
        artifactName: c.artifactName,
        type: c.type,
        tag: c.tag,
      }));
      result.changedLocally = [...result.changedLocally, ...movedToLocal];
      result.conflicts = [];
    }
  }

  if (options.pullOnly) {
    result.localOnly = [];
    result.changedLocally = [];
    if (options.force) {
      // Conflicts become remote-wins pulls
      const movedToRemote: SyncChangedFileEntry[] = result.conflicts.map((c) => ({
        path: c.path,
        localChecksum: c.localChecksum,
        remoteChecksum: c.remoteChecksum,
        localSize: c.localSize,
        remoteSize: c.remoteSize,
        artifactId: c.artifactId,
        artifactName: c.artifactName,
        type: c.type,
        tag: c.tag,
      }));
      result.changedRemotely = [...result.changedRemotely, ...movedToRemote];
      result.conflicts = [];
    }
  }

  // Re-apply exclude patterns to all categories as defense in depth
  if (options.exclude) {
    const ignore = new CirronIgnore();
    const patterns = options.exclude.split(',').map((p) => p.trim());
    for (const pattern of patterns) {
      ignore.addPattern(pattern);
    }
    const isExcluded = (filePath: string): boolean => ignore.isIgnored(filePath);

    result = {
      localOnly: result.localOnly.filter((f) => !isExcluded(f.path)),
      remoteOnly: result.remoteOnly.filter((f) => !isExcluded(f.path)),
      changedLocally: result.changedLocally.filter((f) => !isExcluded(f.path)),
      changedRemotely: result.changedRemotely.filter((f) => !isExcluded(f.path)),
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
        action: 'push',
      })),
      remoteOnly: diff.remoteOnly.map((f) => ({
        path: f.path,
        checksum: f.checksum,
        size: f.size,
        action: 'pull',
      })),
      changedLocally: diff.changedLocally.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: 'push',
      })),
      changedRemotely: diff.changedRemotely.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: 'pull',
      })),
      conflicts: diff.conflicts.map((f) => ({
        path: f.path,
        localChecksum: f.localChecksum,
        remoteChecksum: f.remoteChecksum,
        localSize: f.localSize,
        remoteSize: f.remoteSize,
        action: 'conflict',
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

  logger.info(chalk.bold('Sync dry run - the following changes would be applied:'));
  console.log();

  // Push (local only)
  if (diff.localOnly.length > 0) {
    logger.info(`  ${chalk.green('Push (local only):')} ${diff.localOnly.length} file(s)`);
    diff.localOnly.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)} (${formatSize(f.size)})`);
      if (options.verbose) {
        logger.info(`       Checksum: ${f.checksum.substring(0, 12)}...`);
      }
    });
    console.log();
  }

  // Pull (remote only)
  if (diff.remoteOnly.length > 0) {
    logger.info(`  ${chalk.blue('Pull (remote only):')} ${diff.remoteOnly.length} file(s)`);
    diff.remoteOnly.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)} (${formatSize(f.size)})`);
      if (options.verbose) {
        logger.info(`       Checksum: ${f.checksum.substring(0, 12)}...`);
      }
    });
    console.log();
  }

  // Push (changed locally)
  if (diff.changedLocally.length > 0) {
    logger.info(`  ${chalk.green('Push (changed locally):')} ${diff.changedLocally.length} file(s)`);
    diff.changedLocally.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(`       Local:  ${f.localChecksum.substring(0, 12)}... (${formatSize(f.localSize)})`);
      logger.info(`       Remote: ${f.remoteChecksum.substring(0, 12)}... (${formatSize(f.remoteSize)})`);
    });
    console.log();
  }

  // Pull (changed remotely)
  if (diff.changedRemotely.length > 0) {
    logger.info(`  ${chalk.blue('Pull (changed remotely):')} ${diff.changedRemotely.length} file(s)`);
    diff.changedRemotely.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(`       Local:  ${f.localChecksum.substring(0, 12)}... (${formatSize(f.localSize)})`);
      logger.info(`       Remote: ${f.remoteChecksum.substring(0, 12)}... (${formatSize(f.remoteSize)})`);
    });
    console.log();
  }

  // Conflicts
  if (diff.conflicts.length > 0) {
    logger.info(`  ${chalk.yellow('Conflicts:')} ${diff.conflicts.length} file(s)`);
    diff.conflicts.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.cyan(f.path)}`);
      logger.info(`       Local:  ${f.localChecksum.substring(0, 12)}... (${formatSize(f.localSize)})`);
      logger.info(`       Remote: ${f.remoteChecksum.substring(0, 12)}... (${formatSize(f.remoteSize)})`);
    });
    console.log();
  }

  // Unchanged
  logger.info(`  ${chalk.gray('Unchanged:')} ${diff.unchanged.length} file(s)`);
  if (options.verbose && diff.unchanged.length > 0) {
    diff.unchanged.forEach((f, i) => {
      logger.info(`    ${i + 1}. ${chalk.gray(f.path)} (${formatSize(f.size)})`);
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
  logger.info(chalk.gray('  No changes were applied. Remove --dry-run to sync.'));
}

// --- Conflict Resolution ---

async function promptConflictResolution(
  conflict: SyncConflictEntry,
  index: number,
  total: number,
  lastChoice: SyncConflictResolution | null
): Promise<SyncConflictResolution | 'apply-all'> {
  console.log();
  logger.info(chalk.bold(`Conflict (${index + 1}/${total}): ${conflict.path}`));
  logger.info(`  Local:  ${conflict.localChecksum.substring(0, 12)}... (${formatSize(conflict.localSize)})`);
  logger.info(`  Remote: ${conflict.remoteChecksum.substring(0, 12)}... (${formatSize(conflict.remoteSize)})`);

  const choices: Array<{ name: string; value: string }> = [
    { name: 'Skip (leave unchanged)', value: 'skip' },
    { name: 'Use local version (push to remote)', value: 'overwrite-remote' },
    { name: 'Use remote version (pull to local)', value: 'overwrite-local' },
    { name: 'Keep both (create .local and .remote copies)', value: 'keep-both' },
  ];

  // After first conflict, offer "apply same to remaining"
  if (lastChoice !== null && index < total - 1) {
    const remaining = total - index;
    const choiceLabel = lastChoice === 'skip' ? 'Skip'
      : lastChoice === 'overwrite-remote' ? 'Use local version'
      : lastChoice === 'overwrite-local' ? 'Use remote version'
      : 'Keep both';
    choices.push({
      name: `Apply "${choiceLabel}" to remaining ${remaining} conflict(s)`,
      value: 'apply-all',
    });
  }

  const { resolution } = await inquirer.prompt([
    {
      type: 'list',
      name: 'resolution',
      message: 'How would you like to resolve this conflict?',
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
): Promise<{ succeeded: number; failed: number; pushed: Array<{ path: string; checksum: string; artifactId: string }> }> {
  let succeeded = 0;
  let failed = 0;
  const pushed: Array<{ path: string; checksum: string; artifactId: string }> = [];

  for (const file of files) {
    const fileInfo = toFileInfo(file);
    const itemSpinner = ora(`${label}: ${fileInfo.relativePath} (${formatSize(fileInfo.size)})...`).start();

    try {
      const result = await uploadSingleFile(api, fileInfo, {}, itemSpinner);

      if (result.skipped) {
        itemSpinner.info(`Skipped ${chalk.cyan(fileInfo.relativePath)} (${result.skipReason})`);
      } else {
        itemSpinner.succeed(`Pushed ${chalk.cyan(fileInfo.relativePath)} (${formatSize(fileInfo.size)})`);
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
      const msg = error instanceof Error ? error.message : 'Unknown error';
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
): Promise<{ succeeded: number; failed: number; pulled: Array<{ path: string; checksum: string; artifactId: string }> }> {
  let succeeded = 0;
  let failed = 0;
  const pulled: Array<{ path: string; checksum: string; artifactId: string }> = [];

  const cwd = process.cwd();

  for (const file of files) {
    const artifactInfo = toArtifactInfo(file);
    const destPath = path.resolve(cwd, file.path);
    const itemSpinner = ora(`${label}: ${file.path}...`).start();

    // Validate the resolved path stays within the project directory
    const relPath = path.relative(cwd, destPath);
    if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
      itemSpinner.fail(`Rejected ${file.path}: path traversal detected`);
      failed++;
      continue;
    }

    try {
      await fs.ensureDir(path.dirname(destPath));
      await downloadArtifact(api, artifactInfo, destPath, itemSpinner);

      itemSpinner.succeed(`Pulled ${chalk.cyan(file.path)} (${formatSize(artifactInfo.size)})`);
      succeeded++;
      pulled.push({
        path: file.path,
        checksum: artifactInfo.checksum,
        artifactId: artifactInfo.id,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      itemSpinner.fail(`Failed to pull ${file.path}: ${msg}`);
      failed++;
    }
  }

  return { succeeded, failed, pulled };
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
  const pushed: Array<{ path: string; checksum: string; artifactId: string }> = [];
  const pulled: Array<{ path: string; checksum: string; artifactId: string }> = [];

  if (conflicts.length === 0) {
    return { resolved, skipped, failed, pushed, pulled };
  }

  // Non-interactive strategies
  if (strategy === 'local-wins') {
    for (const conflict of conflicts) {
      const itemSpinner = ora(`Resolving conflict (local-wins): ${conflict.path}...`).start();
      try {
        const fileInfo = toFileInfo(conflict);
        const result = await uploadSingleFile(api, fileInfo, {}, itemSpinner);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> pushed local version`);
        resolved++;
        pushed.push({
          path: conflict.path,
          checksum: fileInfo.checksum,
          artifactId: result.artifact.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
    }
    return { resolved, skipped, failed, pushed, pulled };
  }

  if (strategy === 'remote-wins') {
    for (const conflict of conflicts) {
      const itemSpinner = ora(`Resolving conflict (remote-wins): ${conflict.path}...`).start();
      try {
        const artifactInfo = toArtifactInfo(conflict);
        const destPath = path.resolve(process.cwd(), conflict.path);
        await fs.ensureDir(path.dirname(destPath));
        await downloadArtifact(api, artifactInfo, destPath, itemSpinner);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> pulled remote version`);
        resolved++;
        pulled.push({
          path: conflict.path,
          checksum: artifactInfo.checksum,
          artifactId: artifactInfo.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
    }
    return { resolved, skipped, failed, pushed, pulled };
  }

  if (strategy === 'keep-both') {
    for (const conflict of conflicts) {
      const itemSpinner = ora(`Resolving conflict (keep-both): ${conflict.path}...`).start();
      try {
        const originalPath = path.resolve(process.cwd(), conflict.path);
        const { localPath, remotePath } = buildKeepBothPaths(originalPath);

        // Copy local file to .local suffix
        await fs.copy(originalPath, localPath);

        // Download remote to .remote suffix
        const artifactInfo = toArtifactInfo(conflict);
        await downloadArtifact(api, artifactInfo, remotePath, itemSpinner);

        const relLocal = path.relative(process.cwd(), localPath);
        const relRemote = path.relative(process.cwd(), remotePath);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> kept both (${relLocal}, ${relRemote})`);
        resolved++;
        pulled.push({
          path: conflict.path,
          checksum: artifactInfo.checksum,
          artifactId: artifactInfo.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
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
      const answer = await promptConflictResolution(conflict, i, conflicts.length, lastChoice);
      if (answer === 'apply-all') {
        applyAllChoice = lastChoice;
        resolution = lastChoice!;
      } else {
        resolution = answer;
        lastChoice = resolution;
      }
    }

    if (resolution === 'skip') {
      logger.info(`  Skipped ${chalk.gray(conflict.path)}`);
      skipped++;
      continue;
    }

    if (resolution === 'overwrite-remote') {
      const itemSpinner = ora(`Pushing ${conflict.path}...`).start();
      try {
        const fileInfo = toFileInfo(conflict);
        const result = await uploadSingleFile(api, fileInfo, {}, itemSpinner);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> pushed local version`);
        resolved++;
        pushed.push({
          path: conflict.path,
          checksum: fileInfo.checksum,
          artifactId: result.artifact.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
      continue;
    }

    if (resolution === 'overwrite-local') {
      const itemSpinner = ora(`Pulling ${conflict.path}...`).start();
      try {
        const artifactInfo = toArtifactInfo(conflict);
        const destPath = path.resolve(process.cwd(), conflict.path);
        await fs.ensureDir(path.dirname(destPath));
        await downloadArtifact(api, artifactInfo, destPath, itemSpinner);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> pulled remote version`);
        resolved++;
        pulled.push({
          path: conflict.path,
          checksum: artifactInfo.checksum,
          artifactId: artifactInfo.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
      continue;
    }

    if (resolution === 'keep-both') {
      const itemSpinner = ora(`Keeping both versions of ${conflict.path}...`).start();
      try {
        const originalPath = path.resolve(process.cwd(), conflict.path);
        const { localPath, remotePath } = buildKeepBothPaths(originalPath);

        await fs.copy(originalPath, localPath);

        const artifactInfo = toArtifactInfo(conflict);
        await downloadArtifact(api, artifactInfo, remotePath, itemSpinner);

        const relLocal = path.relative(process.cwd(), localPath);
        const relRemote = path.relative(process.cwd(), remotePath);
        itemSpinner.succeed(`Resolved ${chalk.cyan(conflict.path)} -> kept both (${relLocal}, ${relRemote})`);
        resolved++;
        pulled.push({
          path: conflict.path,
          checksum: artifactInfo.checksum,
          artifactId: artifactInfo.id,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        itemSpinner.fail(`Failed to resolve ${conflict.path}: ${msg}`);
        failed++;
      }
    }
  }

  return { resolved, skipped, failed, pushed, pulled };
}

interface SyncPlanResult {
  summary: SyncSummary;
  pushed: Array<{ path: string; checksum: string; artifactId: string }>;
  pulled: Array<{ path: string; checksum: string; artifactId: string }>;
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

  const allPushed: Array<{ path: string; checksum: string; artifactId: string }> = [];
  const allPulled: Array<{ path: string; checksum: string; artifactId: string }> = [];

  // 1. Pull remote-only files
  if (diff.remoteOnly.length > 0) {
    logger.info(chalk.bold(`\nPulling ${diff.remoteOnly.length} new remote file(s)...`));
    const pullResult = await pullSyncFiles(api, diff.remoteOnly, 'Pull (new)');
    summary.pulled += pullResult.succeeded;
    summary.failed += pullResult.failed;
    allPulled.push(...pullResult.pulled);
  }

  // 2. Pull changed-remotely files
  if (diff.changedRemotely.length > 0) {
    logger.info(chalk.bold(`\nPulling ${diff.changedRemotely.length} updated remote file(s)...`));
    const pullResult = await pullSyncFiles(api, diff.changedRemotely, 'Pull (updated)');
    summary.pulled += pullResult.succeeded;
    summary.failed += pullResult.failed;
    allPulled.push(...pullResult.pulled);
  }

  // 3. Push local-only files
  if (diff.localOnly.length > 0) {
    logger.info(chalk.bold(`\nPushing ${diff.localOnly.length} new local file(s)...`));
    const pushResult = await pushSyncFiles(api, diff.localOnly, 'Push (new)');
    summary.pushed += pushResult.succeeded;
    summary.failed += pushResult.failed;
    allPushed.push(...pushResult.pushed);
  }

  // 4. Push changed-locally files
  if (diff.changedLocally.length > 0) {
    logger.info(chalk.bold(`\nPushing ${diff.changedLocally.length} updated local file(s)...`));
    const pushResult = await pushSyncFiles(api, diff.changedLocally, 'Push (updated)');
    summary.pushed += pushResult.succeeded;
    summary.failed += pushResult.failed;
    allPushed.push(...pushResult.pushed);
  }

  // 5. Resolve conflicts
  if (diff.conflicts.length > 0) {
    logger.info(chalk.bold(`\nResolving ${diff.conflicts.length} conflict(s)...`));
    const conflictResult = await resolveConflicts(api, diff.conflicts, strategy);
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

  const totalActions = summary.pushed + summary.pulled + summary.conflictsResolved + summary.conflictsSkipped;

  if (totalActions === 0 && summary.failed === 0) {
    logger.info(chalk.bold('\nAlready in sync.'));
    logger.info(`  ${chalk.gray(`${summary.unchanged} file(s) unchanged`)}`);
    return;
  }

  console.log();
  logger.info(chalk.bold('Sync summary:'));
  if (summary.pushed > 0) logger.info(`  Pushed:    ${chalk.green(String(summary.pushed))}`);
  if (summary.pulled > 0) logger.info(`  Pulled:    ${chalk.blue(String(summary.pulled))}`);
  if (summary.totalConflicts > 0) {
    const conflictParts: string[] = [];
    if (summary.conflictsResolved > 0) conflictParts.push(`${summary.conflictsResolved} resolved`);
    if (summary.conflictsSkipped > 0) conflictParts.push(`${summary.conflictsSkipped} skipped`);
    logger.info(`  Conflicts: ${chalk.yellow(conflictParts.join(', '))}`);
  }
  if (summary.failed > 0) logger.info(`  Failed:    ${chalk.red(String(summary.failed))}`);
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
  if (!auth) return;
  const { api } = auth;

  // Load project config
  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    logger.error('No cirron config found (cirron.yaml or cirron.json) in current directory');
    logger.info(`Run ${chalk.cyan('cirron init')} to initialize a project`);
    return;
  }

  // Build local manifest
  const manifestSpinner = ora('Scanning local files...').start();

  let manifest: SyncFileManifestEntry[];
  try {
    manifest = await buildLocalManifest(syncPath, options, projectConfig);
    if (manifest.length === 0 && !options.pullOnly) {
      manifestSpinner.info('No local artifact files found');
      logger.info('Ensure your project config has artifacts configured, or specify a path.');
      return;
    }
    manifestSpinner.succeed(`Scanned ${manifest.length} local file(s)`);
  } catch (error) {
    manifestSpinner.fail('Failed to scan local files');
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
    }
    process.exit(1);
  }

  // Get diff from server
  const diffSpinner = ora('Computing sync diff with remote...').start();

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
    diffSpinner.succeed('Sync diff computed');
  } catch (error) {
    diffSpinner.fail('Failed to compute sync diff');
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
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
    logger.info(chalk.bold('\nAlready in sync.'));
    logger.info(`  ${chalk.gray(`${diff.unchanged.length} file(s) unchanged`)}`);
    return;
  }

  // Dry run
  if (options.dryRun) {
    printSyncDryRun(diff, options);
    return;
  }

  // Execute sync
  const { summary, pushed, pulled } = await executeSyncPlan(api, diff, conflictStrategy, options);

  // Best-effort sync metadata update
  try {
    await api.completeSyncMetadata({
      projectName: projectConfig.name,
      pushed,
      pulled,
    });
  } catch {
    logger.warn('Failed to update sync metadata on server. Sync completed successfully.');
  }

  // Print summary
  printSyncSummary(summary, options);

  // Exit with error if any failures
  if (summary.failed > 0) {
    process.exit(1);
  }
}
