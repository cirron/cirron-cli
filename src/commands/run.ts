import path from "node:path";
import chalk from "chalk";
import Table from "cli-table3";
import fs from "fs-extra";
import { load as loadYaml } from "js-yaml";
import ora from "ora";
import type {
  PipelineConfig,
  RunCancelOptions,
  RunInferenceOptions,
  RunInfo,
  RunJobOptions,
  RunListOptions,
  RunLogsOptions,
  RunPipelineOptions,
  RunStatusOptions,
  RunSweepOptions,
} from "../types";
import { CirronApi } from "../utils/api";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import { getLevelColor } from "./logs";

// Helpers

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

async function loadPipelineConfig(configPath: string): Promise<PipelineConfig> {
  const absolutePath = path.resolve(process.cwd(), configPath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }

  const content = await fs.readFile(absolutePath, "utf8");
  const ext = path.extname(absolutePath).toLowerCase();

  try {
    if (ext === ".yaml" || ext === ".yml") {
      return loadYaml(content) as PipelineConfig;
    }

    return JSON.parse(content) as PipelineConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file '${configPath}': ${message}`);
  }
}

async function monitorRun(
  api: CirronApi,
  runId: string,
  spinner: ReturnType<typeof ora>
): Promise<RunInfo> {
  const maxAttempts = 360; // 30 minutes with 5-second intervals
  let attempts = 0;

  while (attempts < maxAttempts) {
    try {
      const run = await api.getRun(runId);

      switch (run.status) {
        case "PENDING":
          spinner.text = `Run ${runId} queued...`;
          break;
        case "RUNNING":
          spinner.text = `Run ${runId} running...`;
          break;
        case "COMPLETED":
        case "FAILED":
        case "CANCELLED":
          return run;
        default:
          break;
      }

      await new Promise((resolve) => setTimeout(resolve, 5000));
      attempts++;
    } catch (error) {
      logger.warn("Error checking run status:", error);
      attempts++;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  throw new Error("Run monitoring timed out");
}

function formatDuration(run: RunInfo): string {
  if (run.duration) {
    const seconds = run.duration;
    if (seconds < 60) {
      return `${seconds}s`;
    }
    if (seconds < 3600) {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}m ${s}s`;
    }
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  if (!(run.completedAt && run.createdAt)) {
    return "N/A";
  }

  const diffSeconds = Math.round(
    (new Date(run.completedAt).getTime() - new Date(run.createdAt).getTime()) /
      1000
  );
  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  }
  if (diffSeconds < 3600) {
    const m = Math.floor(diffSeconds / 60);
    const s = diffSeconds % 60;
    return `${m}m ${s}s`;
  }
  const h = Math.floor(diffSeconds / 3600);
  const m = Math.floor((diffSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function getStatusColor(status: string): (text: string) => string {
  switch (status) {
    case "COMPLETED":
      return chalk.green;
    case "RUNNING":
      return chalk.yellow;
    case "PENDING":
      return chalk.blue;
    case "FAILED":
      return chalk.red;
    case "CANCELLED":
      return chalk.gray;
    default:
      return chalk.white;
  }
}

// Command Handlers

/** Entry point for `cirron run pipeline`: trigger a pipeline run and optionally follow it. */
export async function runPipelineCommand(
  nameOrId: string | undefined,
  options: RunPipelineOptions
): Promise<void> {
  if (!nameOrId) {
    logger.error("Pipeline name or ID is required");
    logger.info(`Usage: ${chalk.cyan("cirron run pipeline <name>")}`);
    return;
  }

  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  // Load pipeline config file if provided
  let pipelineConfig: PipelineConfig | undefined;
  if (options.config) {
    try {
      pipelineConfig = await loadPipelineConfig(options.config);
    } catch (error) {
      logger.error(`Failed to load config: ${(error as Error).message}`);
      return;
    }
  }

  // Parse tags from comma-separated string
  const tags = options.tag
    ? options.tag
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : undefined;

  // Handle --dry-run: display plan without executing
  if (options.dryRun) {
    logger.info(chalk.bold("Dry run - pipeline execution plan:"));
    console.log();
    logger.info(`  Pipeline:  ${chalk.cyan(nameOrId)}`);
    if (options.gpu) {
      logger.info(`  GPU:       ${chalk.cyan(options.gpu)}`);
    }
    if (options.priority) {
      logger.info(`  Priority:  ${chalk.cyan(options.priority)}`);
    }
    if (tags && tags.length > 0) {
      logger.info(`  Tags:      ${chalk.cyan(tags.join(", "))}`);
    }

    if (pipelineConfig) {
      if (pipelineConfig.steps && pipelineConfig.steps.length > 0) {
        console.log();
        logger.info(chalk.bold("  Steps:"));
        for (const [i, step] of pipelineConfig.steps.entries()) {
          logger.info(
            `    ${i + 1}. ${step.name}${step.command ? ` (${step.command})` : ""}`
          );
          if (step.resources?.gpu) {
            logger.info(`       GPU: ${step.resources.gpu}`);
          }
          if (step.dependsOn && step.dependsOn.length > 0) {
            logger.info(`       Depends on: ${step.dependsOn.join(", ")}`);
          }
        }
      }
      if (pipelineConfig.parameters) {
        console.log();
        logger.info(chalk.bold("  Parameters:"));
        for (const [key, value] of Object.entries(pipelineConfig.parameters)) {
          logger.info(`    ${key}: ${chalk.cyan(String(value))}`);
        }
      }
    }

    console.log();
    logger.info(
      chalk.gray("No run was triggered. Remove --dry-run to execute.")
    );
    return;
  }

  // Trigger the run
  const spinner = ora(`Triggering pipeline run: ${nameOrId}...`).start();

  try {
    const triggerOptions: {
      config?: Record<string, unknown>;
      gpu?: string;
      priority?: string;
      tags?: string[];
    } = {};
    if (pipelineConfig) {
      triggerOptions.config = pipelineConfig as Record<string, unknown>;
    }
    if (options.gpu) {
      triggerOptions.gpu = options.gpu;
    }
    if (options.priority) {
      triggerOptions.priority = options.priority;
    }
    if (tags) {
      triggerOptions.tags = tags;
    }

    const run = await api.triggerPipelineRun(nameOrId, triggerOptions);

    spinner.succeed(`Pipeline run created (ID: ${chalk.cyan(run.id)})`);

    logger.info(`  Status:   ${getStatusColor(run.status)(run.status)}`);
    logger.info(`  Pipeline: ${chalk.cyan(run.pipeline?.name || nameOrId)}`);
    if (run.gpu) {
      logger.info(`  GPU:      ${chalk.cyan(run.gpu)}`);
    }
    if (run.priority) {
      logger.info(`  Priority: ${chalk.cyan(run.priority)}`);
    }

    // Watch mode: poll for completion
    if (options.watch) {
      console.log();
      const watchSpinner = ora(`Watching run ${run.id}...`).start();

      try {
        const finalRun = await monitorRun(api, run.id, watchSpinner);

        if (finalRun.status === "COMPLETED") {
          watchSpinner.succeed(
            chalk.green(`Run ${run.id} completed successfully`)
          );
          logger.info(`  Duration: ${chalk.cyan(formatDuration(finalRun))}`);
        } else if (finalRun.status === "FAILED") {
          watchSpinner.fail(chalk.red(`Run ${run.id} failed`));
          if (finalRun.error) {
            logger.error(finalRun.error);
          }
          logger.info(`View logs: ${chalk.cyan(`cirron run logs ${run.id}`)}`);
          process.exit(1);
        } else if (finalRun.status === "CANCELLED") {
          watchSpinner.warn(`Run ${run.id} was cancelled`);
        }
      } catch {
        watchSpinner.fail("Watch timed out");
        logger.info(
          `Check status: ${chalk.cyan(`cirron run status ${run.id}`)}`
        );
      }
    } else {
      console.log();
      logger.info(`Check status: ${chalk.cyan(`cirron run status ${run.id}`)}`);
      logger.info(`View logs:    ${chalk.cyan(`cirron run logs ${run.id}`)}`);
    }
  } catch (error) {
    spinner.fail("Failed to trigger pipeline run");
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

/** Entry point for `cirron run list`: list recent runs. */
export async function runListCommand(options: RunListOptions): Promise<void> {
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  const spinner = ora("Fetching runs...").start();

  try {
    const limit = options.last ? Number.parseInt(options.last, 10) : 20;
    if (Number.isNaN(limit)) {
      spinner.fail("Invalid value for --last: must be a number");
      return;
    }
    const runsOptions: { status?: string; limit?: number; pipeline?: string } =
      { limit };
    if (options.status) {
      runsOptions.status = options.status;
    }
    if (options.pipeline) {
      runsOptions.pipeline = options.pipeline;
    }

    const runs = await api.getRuns(runsOptions);

    spinner.succeed("Runs fetched");

    if (options.json) {
      console.log(JSON.stringify(runs, null, 2));
      return;
    }

    if (!runs || runs.length === 0) {
      logger.info("No runs found");
      return;
    }

    const table = new Table({
      head: [
        "Run ID",
        "Type",
        "Pipeline",
        "Status",
        "Priority",
        "Duration",
        "Created At",
      ],
      colWidths: [15, 12, 20, 12, 10, 10, 25],
    });

    for (const run of runs as RunInfo[]) {
      const displayId =
        run.id.length > 12 ? `${run.id.slice(0, 12)}...` : run.id;
      table.push([
        displayId,
        run.type || "N/A",
        run.pipeline?.name || "N/A",
        getStatusColor(run.status)(run.status),
        run.priority || "normal",
        formatDuration(run),
        new Date(run.createdAt).toLocaleString(),
      ]);
    }

    console.log(table.toString());

    if (runs.length === limit) {
      logger.info(
        chalk.gray(`Showing last ${limit} runs. Use --last <n> to see more.`)
      );
    }
  } catch (error) {
    spinner.fail("Failed to fetch runs");
    logger.error("Error:", error);
  }
}

// Enhanced Stubs

/** Entry point for `cirron run job`. Not implemented — prints a placeholder and returns. */
export async function runJobCommand(options: RunJobOptions): Promise<void> {
  logger.info(`${chalk.yellow("run job")} is not yet implemented.`);
  logger.info("This command will execute a single-task job.");
  if (options.config) {
    logger.info(`Config file: ${options.config}`);
  }
}

/** Entry point for `cirron run inference`. Not implemented — prints a placeholder and returns. */
export async function runInferenceCommand(
  deployment: string | undefined,
  options: RunInferenceOptions
): Promise<void> {
  logger.info(`${chalk.yellow("run inference")} is not yet implemented.`);
  logger.info("This command will trigger batch inference.");
  if (deployment) {
    logger.info(`Deployment: ${deployment}`);
  }
  if (options.input) {
    logger.info(`Input: ${options.input}`);
  }
}

/** Entry point for `cirron run sweep`. Not implemented — prints a placeholder and returns. */
export async function runSweepCommand(options: RunSweepOptions): Promise<void> {
  logger.info(`${chalk.yellow("run sweep")} is not yet implemented.`);
  logger.info("This command will trigger a hyperparameter sweep.");
  if (options.strategy) {
    logger.info(`Strategy: ${options.strategy}`);
  }
}

/** Entry point for `cirron run status`: report one run's state. */
export async function runStatusCommand(
  runId: string,
  options: RunStatusOptions
): Promise<void> {
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  const spinner = ora(`Fetching status for run ${runId}...`).start();

  try {
    const run = await api.getRun(runId);
    spinner.succeed("Run status retrieved");

    if (options.json) {
      console.log(JSON.stringify(run, null, 2));
      return;
    }

    console.log();
    logger.info(`  Run ID:    ${chalk.cyan(run.id)}`);
    logger.info(`  Type:      ${run.type}`);
    logger.info(`  Status:    ${getStatusColor(run.status)(run.status)}`);
    if (run.pipeline) {
      logger.info(
        `  Pipeline:  ${chalk.cyan(run.pipeline.name)} (${run.pipeline.id})`
      );
    }
    if (run.gpu) {
      logger.info(`  GPU:       ${chalk.cyan(run.gpu)}`);
    }
    if (run.priority) {
      logger.info(`  Priority:  ${chalk.cyan(run.priority)}`);
    }
    if (run.tags && run.tags.length > 0) {
      logger.info(`  Tags:      ${chalk.cyan(run.tags.join(", "))}`);
    }
    logger.info(`  Created:   ${new Date(run.createdAt).toLocaleString()}`);
    if (run.startedAt) {
      logger.info(`  Started:   ${new Date(run.startedAt).toLocaleString()}`);
    }
    if (run.completedAt) {
      logger.info(`  Completed: ${new Date(run.completedAt).toLocaleString()}`);
    }
    logger.info(`  Duration:  ${formatDuration(run)}`);
    if (run.error) {
      logger.error(`  Error:     ${run.error}`);
    }

    // Watch mode - poll for updates if run is still active
    if (
      options.watch &&
      (run.status === "PENDING" || run.status === "RUNNING")
    ) {
      console.log();
      const watchSpinner = ora(`Watching run ${runId}...`).start();
      try {
        const finalRun = await monitorRun(api, runId, watchSpinner);
        if (finalRun.status === "COMPLETED") {
          watchSpinner.succeed(
            chalk.green(`Run ${runId} completed successfully`)
          );
          logger.info(`  Duration: ${chalk.cyan(formatDuration(finalRun))}`);
        } else if (finalRun.status === "FAILED") {
          watchSpinner.fail(chalk.red(`Run ${runId} failed`));
          if (finalRun.error) {
            logger.error(finalRun.error);
          }
        } else if (finalRun.status === "CANCELLED") {
          watchSpinner.warn(`Run ${runId} was cancelled`);
        }
      } catch {
        watchSpinner.fail("Watch timed out");
      }
    }
  } catch (error) {
    spinner.fail("Failed to fetch run status");
    if (error instanceof Error) {
      logger.error(error.message);
    }
    process.exit(1);
  }
}

/** Entry point for `cirron run cancel`: cancel a run. */
export async function runCancelCommand(
  runId: string,
  options: RunCancelOptions
): Promise<void> {
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  const spinner = ora(`Cancelling run ${runId}...`).start();

  try {
    const cancelOptions: { force?: boolean } = {};
    if (options.force) {
      cancelOptions.force = options.force;
    }
    const run = await api.cancelRun(runId, cancelOptions);
    spinner.succeed(`Run ${runId} cancelled`);
    logger.info(`  Status:   ${getStatusColor(run.status)(run.status)}`);
    if (run.pipeline) {
      logger.info(`  Pipeline: ${chalk.cyan(run.pipeline.name)}`);
    }
  } catch (error) {
    spinner.fail("Failed to cancel run");
    if (error instanceof Error) {
      logger.error(error.message);
    }
    process.exit(1);
  }
}

/** Entry point for `cirron run logs`: fetch a run's logs. */
export async function runLogsCommand(
  runId: string,
  options: RunLogsOptions
): Promise<void> {
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  const spinner = ora(`Fetching logs for run ${runId}...`).start();

  try {
    const logOptions: { lines?: number; since?: string } = {};
    if (options.lines) {
      const parsedLines = Number.parseInt(options.lines, 10);
      if (Number.isNaN(parsedLines)) {
        spinner.fail("Invalid value for --lines: must be a number");
        return;
      }
      logOptions.lines = parsedLines;
    }
    const logs = await api.getRunLogs(runId, logOptions);

    spinner.succeed(`Logs for run ${runId}`);
    console.log();

    if (!logs || logs.length === 0) {
      logger.info("No logs available for this run.");
      return;
    }

    for (const entry of logs) {
      const timestamp = chalk.gray(
        new Date(entry.timestamp).toLocaleTimeString()
      );
      const source = entry.source ? chalk.gray(`[${entry.source}]`) : "";
      const levelColor = getLevelColor(entry.level);
      console.log(
        `${timestamp} ${levelColor(entry.level.toUpperCase().padEnd(5))} ${source} ${entry.message}`
      );
    }

    // Follow mode - poll for new logs
    if (options.follow) {
      const lastLog = logs.length > 0 ? logs[logs.length - 1] : undefined;
      let lastTimestamp: string | undefined = lastLog?.timestamp;

      logger.info(chalk.gray("\nFollowing logs (Ctrl+C to stop)..."));

      const pollInterval = setInterval(async () => {
        try {
          const pollOptions: { lines?: number; since?: string } = { lines: 50 };
          if (lastTimestamp) {
            pollOptions.since = lastTimestamp;
          }
          const newLogs = await api.getRunLogs(runId, pollOptions);

          for (const entry of newLogs) {
            if (entry.timestamp === lastTimestamp) {
              continue;
            }

            const timestamp = chalk.gray(
              new Date(entry.timestamp).toLocaleTimeString()
            );
            const source = entry.source ? chalk.gray(`[${entry.source}]`) : "";
            const levelColor = getLevelColor(entry.level);
            console.log(
              `${timestamp} ${levelColor(entry.level.toUpperCase().padEnd(5))} ${source} ${entry.message}`
            );
            lastTimestamp = entry.timestamp;
          }
        } catch (error) {
          logger.debug("Error polling run logs:", error);
        }
      }, 2000);

      process.once("SIGINT", () => {
        clearInterval(pollInterval);
        console.log();
        logger.info("Stopped following logs.");
        process.exit(0);
      });
    }
  } catch (error) {
    spinner.fail("Failed to fetch run logs");
    if (error instanceof Error) {
      logger.error(error.message);
    }
    process.exit(1);
  }
}
