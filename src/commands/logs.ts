import chalk from "chalk";
import ora from "ora";
import type { LogEntry } from "../types";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import { loadProjectConfig } from "../utils/project-config";

interface LogsOptions {
  env?: string;
  follow?: boolean;
  lines?: string;
}

/** Entry point for `cirron logs`: fetch deployment logs, optionally following. */
export async function logsCommand(options: LogsOptions): Promise<void> {
  const spinner = ora("Fetching logs...").start();

  try {
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(
        chalk.red("No cirron config found (cirron.yaml or cirron.json)")
      );
      logger.error(`Run ${chalk.cyan("cirron init")} to initialize a project`);
      return;
    }

    const { config: projectConfig } = projectConfigResult;

    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!isAuthenticated(currentConfig)) {
      spinner.fail(chalk.red("Not authenticated"));
      logger.error(`Run ${chalk.cyan("cirron auth login")} to authenticate`);
      return;
    }

    const api = new CirronApi(currentConfig);
    const environment = options.env || "production";
    const lines = Number.parseInt(options.lines || "100", 10);

    if (options.follow) {
      spinner.stop();
      await followLogs(api, projectConfig.name, environment);
    } else {
      const logs = await api.getLogs(projectConfig.name, environment, {
        lines,
      });
      spinner.stop();

      if (logs.length === 0) {
        logger.info(chalk.yellow("No logs found"));
        return;
      }

      displayLogs(logs);
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch logs"));
    handlePlatformError(error);
    logger.error("Error:", error);
    process.exit(1);
  }
}

async function followLogs(
  api: CirronApi,
  projectName: string,
  environment: string
): Promise<void> {
  logger.info(chalk.blue(`Following logs for ${projectName} (${environment})`));
  logger.info(chalk.gray("Press Ctrl+C to stop"));
  console.log();

  let lastTimestamp = new Date().toISOString();

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await api.getLogs(projectName, environment, {
        since: lastTimestamp,
        lines: 50,
      });

      if (logs.length > 0) {
        displayLogs(logs);
        const lastLog = logs[logs.length - 1];
        if (lastLog) {
          lastTimestamp = lastLog.timestamp;
        }
      }
    } catch (error) {
      logger.debug("Error polling logs:", error);
    }
  };

  // Initial fetch
  await pollLogs();

  // Poll every 2 seconds
  const interval = setInterval(pollLogs, 2000);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    clearInterval(interval);
    logger.info("\nStopped following logs");
    process.exit(0);
  });
}

function displayLogs(logs: LogEntry[]): void {
  for (const log of logs) {
    const timestamp = new Date(log.timestamp).toLocaleTimeString();
    const levelColor = getLevelColor(log.level);
    const level = levelColor(log.level.toUpperCase().padEnd(5));

    console.log(`${chalk.gray(timestamp)} ${level} ${log.message}`);
  }
}

/**
 * Pick the chalk colour for a log level.
 *
 * @param level - The level string from the platform.
 * @returns A chalk styling function; identity for unknown levels.
 */
export function getLevelColor(level: string): (text: string) => string {
  switch (level.toLowerCase()) {
    case "error":
      return chalk.red;
    case "warn":
      return chalk.yellow;
    case "info":
      return chalk.blue;
    case "debug":
      return chalk.gray;
    default:
      return chalk.white;
  }
}
