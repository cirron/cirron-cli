import zlib from "node:zlib";
import chalk from "chalk";
import Table from "cli-table3";
import fs from "fs-extra";
import inquirer from "inquirer";
import ora from "ora";
import { CirronApi } from "../utils/api";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import {
  humanBytes,
  listSpoolFiles,
  nsToIso,
  resolveSpoolDir,
  type SpoolFile,
} from "../utils/spool";
import { CLI_VERSION, USER_AGENT } from "../utils/version";

// TODO: make the ingest endpoint configurable, and add `flush --force` so an
// unauthenticated user can clear the spool without silently discarding data.

const INGEST_PATH = "/api/traces";
const GZIP_MIN_BYTES = 1024;

interface SpoolOptions {
  dir?: string;
  force?: boolean;
  json?: boolean;
}

async function drainResponse(response: Response): Promise<void> {
  try {
    await response.text();
  } catch {
    // body already consumed or connection closed — nothing to drain
  }
}

export async function spoolInspectCommand(
  options: SpoolOptions
): Promise<void> {
  const spoolDir = resolveSpoolDir(options.dir);
  const files = await listSpoolFiles(spoolDir);

  if (files.length === 0) {
    if (options.json) {
      logger.json({
        dir: spoolDir,
        files: 0,
        totalBytes: 0,
        oldest: null,
        newest: null,
      });
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
      oldest: {
        name: oldest.name,
        createdNs: oldest.createdNs.toString(),
        iso: nsToIso(oldest.createdNs),
      },
      newest: {
        name: newest.name,
        createdNs: newest.createdNs.toString(),
        iso: nsToIso(newest.createdNs),
      },
      entries: files.map((f) => ({
        name: f.name,
        size: f.size,
        createdNs: f.createdNs.toString(),
        iso: nsToIso(f.createdNs),
      })),
    });
    return;
  }

  logger.info(
    `${chalk.bold("Spool:")} ${spoolDir}  ${chalk.gray(`(${files.length} file${files.length === 1 ? "" : "s"}, ${humanBytes(totalBytes)})`)}`
  );
  const table = new Table({
    head: [chalk.cyan("Timestamp"), chalk.cyan("Size"), chalk.cyan("File")],
    colAligns: ["left", "right", "left"],
  });
  for (const f of files) {
    table.push([nsToIso(f.createdNs), humanBytes(f.size), chalk.gray(f.name)]);
  }
  console.log(table.toString());
  logger.info(
    `${chalk.gray("Oldest:")} ${nsToIso(oldest.createdNs)}   ${chalk.gray("Newest:")} ${nsToIso(newest.createdNs)}`
  );
}

interface FlushResult {
  failed: number;
  skipped: number;
  uploaded: number;
}

async function flushBatch(
  file: SpoolFile,
  apiUrl: string,
  authHeader: string,
  timeoutMs: number
): Promise<"ok" | "fatal" | "retryable"> {
  const raw = await fs.readFile(file.fullPath);
  const shouldGzip = raw.length >= GZIP_MIN_BYTES;
  const body = shouldGzip ? zlib.gzipSync(raw) : raw;

  const batchId = file.name
    .replace(/\.json$/, "")
    .split("-")
    .slice(1)
    .join("-");

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
    "X-Cirron-SDK-Version": `cli/${CLI_VERSION}`,
    "X-Cirron-Batch-Id": batchId,
    Authorization: authHeader,
  };
  if (shouldGzip) {
    headers["Content-Encoding"] = "gzip";
  }

  const url = new URL(INGEST_PATH, apiUrl).toString();
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | null = null;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      if (response.ok) {
        await drainResponse(response);
        return "ok";
      }

      if (response.status === 401 || response.status === 403) {
        await drainResponse(response);
        logger.error(
          `Auth rejected (${response.status}) for ${file.name}. Run ${chalk.cyan("cirron auth login")}.`
        );
        return "fatal";
      }
      if (response.status === 404) {
        await drainResponse(response);
        logger.error(
          `Ingest route ${INGEST_PATH} not available on ${apiUrl} (404). Platform may not have shipped the route yet.`
        );
        return "fatal";
      }
      if (response.status === 400 || response.status === 413) {
        await drainResponse(response);
        logger.error(
          `Rejected ${file.name}: HTTP ${response.status} ${response.statusText}`
        );
        return "fatal";
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number.parseInt(
          response.headers.get("retry-after") || "0",
          10
        );
        await drainResponse(response);
        const delayMs =
          retryAfter > 0
            ? Math.min(retryAfter, 30) * 1000
            : Math.min(1000 * 2 ** (attempt - 1), 10_000);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return "retryable";
      }
      await drainResponse(response);
      logger.error(`Unexpected HTTP ${response.status} for ${file.name}`);
      return "fatal";
    } catch (error) {
      if (response) {
        await drainResponse(response);
      }
      if (attempt >= maxAttempts) {
        const msg =
          (error as Error).name === "AbortError"
            ? `timed out after ${timeoutMs}ms`
            : (error as Error).message;
        logger.error(`Network error uploading ${file.name}: ${msg}`);
        return "retryable";
      }
      const delayMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      await new Promise((r) => setTimeout(r, delayMs));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return "retryable";
}

export async function spoolFlushCommand(options: SpoolOptions): Promise<void> {
  const spoolDir = resolveSpoolDir(options.dir);
  const files = await listSpoolFiles(spoolDir);

  if (files.length === 0) {
    logger.info(chalk.yellow(`No spool files to flush in ${spoolDir}`));
    return;
  }

  const configManager = new ConfigManager();
  let config = configManager.load();

  if (!(config.auth?.accessToken || config.token)) {
    logger.error(
      `Not authenticated. Run ${chalk.cyan("cirron auth login")} first.`
    );
    return;
  }

  // Exercising CirronApi refreshes a near-expiry token and persists it to
  // ~/.cirron/config.json before the auth header is read out below.
  const api = new CirronApi(config);
  try {
    await api.verifyAuth();
  } catch (error) {
    const msg = (error as Error).message;
    if (msg.includes("401") || msg.includes("403")) {
      logger.error(
        `Authentication invalid. Run ${chalk.cyan("cirron auth login")} first.`
      );
      return;
    }
    // Non-auth failures (network, 5xx on /status) are non-fatal — let the flush
    // loop surface them per-batch with its own retry/backoff.
    logger.warn(
      `Could not verify auth before flush: ${msg}. Proceeding anyway.`
    );
  }

  // Reload config in case ensureValidToken persisted a refreshed access token.
  config = configManager.load();
  const authHeader = config.auth?.accessToken
    ? `Bearer ${config.auth.accessToken}`
    : `Bearer ${config.token}`;

  const spinner = ora(
    `Flushing ${files.length} batch${files.length === 1 ? "" : "es"}...`
  ).start();
  const result: FlushResult = { uploaded: 0, failed: 0, skipped: 0 };

  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    spinner.text = `Flushing ${i + 1}/${files.length}: ${file.name}`;
    const outcome = await flushBatch(
      file,
      config.apiUrl,
      authHeader,
      config.timeout
    );
    if (outcome === "ok") {
      try {
        await fs.unlink(file.fullPath);
        result.uploaded++;
      } catch (error) {
        result.failed++;
        logger.error(
          `Uploaded ${file.name} but failed to delete local spool file ${file.fullPath}: ${(error as Error).message}. It may be re-uploaded on next flush.`
        );
      }
    } else if (outcome === "fatal") {
      result.failed++;
      result.skipped = files.length - i - 1;
      spinner.stop();
      logger.warn(
        `Stopping flush; ${result.skipped} batch${result.skipped === 1 ? "" : "es"} left in spool.`
      );
      break;
    } else {
      result.failed++;
    }
  }

  if (spinner.isSpinning) {
    spinner.stop();
  }
  logger.info(
    `${chalk.green(`Uploaded: ${result.uploaded}`)}  ${chalk.red(`Failed: ${result.failed}`)}  ${chalk.gray(`Skipped: ${result.skipped}`)}`
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
        type: "confirm",
        name: "confirm",
        message: `Delete ${chalk.cyan(files.length)} spool file${files.length === 1 ? "" : "s"} (${humanBytes(totalBytes)}) from ${chalk.gray(spoolDir)}?`,
        default: false,
      },
    ]);
    if (!confirm) {
      logger.info("Cancelled.");
      return;
    }
  }

  let deleted = 0;
  for (const file of files) {
    try {
      await fs.unlink(file.fullPath);
      deleted++;
    } catch (error) {
      logger.error(
        `Failed to delete ${file.name}: ${(error as Error).message}`
      );
    }
  }
  logger.success(`Deleted ${deleted} spool file${deleted === 1 ? "" : "s"}.`);
}
