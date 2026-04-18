// src/commands/spool.ts
import path from 'path';
import zlib from 'zlib';
import chalk from 'chalk';
import fs from 'fs-extra';
import inquirer from 'inquirer';
import ora from 'ora';
import Table from 'cli-table3';
import fetch from 'node-fetch';
import { ConfigManager } from '../utils/config';
import { logger } from '../utils/logger';

const SPOOL_FILENAME_RE = /^(\d+)-[0-9a-f]+\.json$/;
const DEFAULT_SPOOL_SUBPATH = path.join('.cirron', 'spool');
const INGEST_PATH = '/api/traces';
const GZIP_MIN_BYTES = 1024;
const CLI_VERSION = '1.0.0';

interface SpoolOptions {
  dir?: string;
  json?: boolean;
  force?: boolean;
}

interface SpoolFile {
  name: string;
  fullPath: string;
  createdNs: bigint;
  size: number;
}

function resolveSpoolDir(dir: string | undefined): string {
  return path.resolve(dir ?? path.join(process.cwd(), DEFAULT_SPOOL_SUBPATH));
}

async function listSpoolFiles(spoolDir: string): Promise<SpoolFile[]> {
  if (!(await fs.pathExists(spoolDir))) {
    return [];
  }
  const entries = await fs.readdir(spoolDir);
  const files: SpoolFile[] = [];
  for (const name of entries) {
    const match = SPOOL_FILENAME_RE.exec(name);
    if (!match) continue;
    const fullPath = path.join(spoolDir, name);
    const stat = await fs.stat(fullPath);
    if (!stat.isFile()) continue;
    files.push({
      name,
      fullPath,
      createdNs: BigInt(match[1]!),
      size: stat.size,
    });
  }
  files.sort((a, b) => (a.createdNs < b.createdNs ? -1 : a.createdNs > b.createdNs ? 1 : 0));
  return files;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(2)} ${units[i]}`;
}

function nsToIso(ns: bigint): string {
  const ms = Number(ns / 1_000_000n);
  return new Date(ms).toISOString();
}

export async function spoolInspectCommand(options: SpoolOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.dir);
  const files = await listSpoolFiles(spoolDir);

  if (files.length === 0) {
    if (options.json) {
      logger.json({ dir: spoolDir, files: 0, totalBytes: 0, oldest: null, newest: null });
    } else {
      logger.info(chalk.yellow(`No spool files found in ${spoolDir}`));
    }
    return;
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
  const oldest = files[0]!;
  const newest = files[files.length - 1]!;

  if (options.json) {
    logger.json({
      dir: spoolDir,
      files: files.length,
      totalBytes,
      oldest: { name: oldest.name, createdNs: oldest.createdNs.toString(), iso: nsToIso(oldest.createdNs) },
      newest: { name: newest.name, createdNs: newest.createdNs.toString(), iso: nsToIso(newest.createdNs) },
    });
    return;
  }

  logger.info(chalk.bold(`Spool: ${spoolDir}`));
  const table = new Table({ head: [chalk.cyan('Metric'), chalk.cyan('Value')] });
  table.push(
    ['Files', String(files.length)],
    ['Total size', humanBytes(totalBytes)],
    ['Oldest', `${nsToIso(oldest.createdNs)}  ${chalk.gray(oldest.name)}`],
    ['Newest', `${nsToIso(newest.createdNs)}  ${chalk.gray(newest.name)}`],
  );
  console.log(table.toString());
}

interface FlushResult {
  uploaded: number;
  failed: number;
  skipped: number;
}

async function flushBatch(
  file: SpoolFile,
  apiUrl: string,
  authHeader: string | undefined,
): Promise<'ok' | 'fatal' | 'retryable'> {
  const raw = await fs.readFile(file.fullPath);
  const shouldGzip = raw.length >= GZIP_MIN_BYTES;
  const body = shouldGzip ? zlib.gzipSync(raw) : raw;

  const batchId = file.name.replace(/\.json$/, '').split('-').slice(1).join('-');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': `cirron-cli/${CLI_VERSION}`,
    'X-Cirron-SDK-Version': `cli/${CLI_VERSION}`,
    'X-Cirron-Batch-Id': batchId,
  };
  if (shouldGzip) headers['Content-Encoding'] = 'gzip';
  if (authHeader) headers['Authorization'] = authHeader;

  const url = new URL(INGEST_PATH, apiUrl).toString();
  let attempt = 0;
  const maxAttempts = 3;

  while (attempt < maxAttempts) {
    attempt++;
    try {
      const response = await fetch(url, { method: 'POST', headers, body });
      if (response.ok) return 'ok';

      if (response.status === 401 || response.status === 403) {
        logger.error(
          `Auth rejected (${response.status}) for ${file.name}. Run ${chalk.cyan('cirron auth login')}.`,
        );
        return 'fatal';
      }
      if (response.status === 404) {
        logger.error(
          `Ingest route ${INGEST_PATH} not available on ${apiUrl} (404). Platform may not have shipped the route yet.`,
        );
        return 'fatal';
      }
      if (response.status === 400 || response.status === 413) {
        logger.error(`Rejected ${file.name}: HTTP ${response.status} ${response.statusText}`);
        return 'fatal';
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
        const delayMs = retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : Math.min(1000 * 2 ** (attempt - 1), 10000);
        await new Promise((r) => setTimeout(r, delayMs));
        continue;
      }
      logger.error(`Unexpected HTTP ${response.status} for ${file.name}`);
      return 'fatal';
    } catch (error) {
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10000);
      await new Promise((r) => setTimeout(r, delayMs));
      if (attempt >= maxAttempts) {
        logger.error(`Network error uploading ${file.name}: ${(error as Error).message}`);
        return 'retryable';
      }
    }
  }
  return 'retryable';
}

export async function spoolFlushCommand(options: SpoolOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.dir);
  const files = await listSpoolFiles(spoolDir);

  if (files.length === 0) {
    logger.info(chalk.yellow(`No spool files to flush in ${spoolDir}`));
    return;
  }

  const configManager = new ConfigManager();
  const config = configManager.load();
  const authHeader = config.auth?.accessToken
    ? `Bearer ${config.auth.accessToken}`
    : config.token
      ? `Bearer ${config.token}`
      : undefined;

  if (!authHeader) {
    logger.error(`Not authenticated. Run ${chalk.cyan('cirron auth login')} first.`);
    return;
  }

  const spinner = ora(`Flushing ${files.length} batch${files.length === 1 ? '' : 'es'}...`).start();
  const result: FlushResult = { uploaded: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    spinner.text = `Flushing ${i + 1}/${files.length}: ${file.name}`;
    const outcome = await flushBatch(file, config.apiUrl, authHeader);
    if (outcome === 'ok') {
      await fs.unlink(file.fullPath);
      result.uploaded++;
    } else if (outcome === 'fatal') {
      result.failed++;
      result.skipped = files.length - i - 1;
      spinner.stop();
      logger.warn(`Stopping flush; ${result.skipped} batch${result.skipped === 1 ? '' : 'es'} left in spool.`);
      break;
    } else {
      result.failed++;
    }
  }

  if (spinner.isSpinning) spinner.stop();
  logger.info(
    `${chalk.green(`Uploaded: ${result.uploaded}`)}  ${chalk.red(`Failed: ${result.failed}`)}  ${chalk.gray(`Skipped: ${result.skipped}`)}`,
  );
}

export async function spoolClearCommand(options: SpoolOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.dir);
  const files = await listSpoolFiles(spoolDir);

  if (files.length === 0) {
    logger.info(chalk.yellow(`No spool files to clear in ${spoolDir}`));
    return;
  }

  const totalBytes = files.reduce((acc, f) => acc + f.size, 0);

  if (!options.force) {
    const { confirm } = await inquirer.prompt<{ confirm: boolean }>([
      {
        type: 'confirm',
        name: 'confirm',
        message: `Delete ${chalk.cyan(files.length)} spool file${files.length === 1 ? '' : 's'} (${humanBytes(totalBytes)}) from ${chalk.gray(spoolDir)}?`,
        default: false,
      },
    ]);
    if (!confirm) {
      logger.info('Cancelled.');
      return;
    }
  }

  let deleted = 0;
  for (const file of files) {
    try {
      await fs.unlink(file.fullPath);
      deleted++;
    } catch (error) {
      logger.error(`Failed to delete ${file.name}: ${(error as Error).message}`);
    }
  }
  logger.success(`Deleted ${deleted} spool file${deleted === 1 ? '' : 's'}.`);
}
