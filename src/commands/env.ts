import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import type { ProjectConfig } from "../types";
import { CirronApi } from "../utils/api";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import { loadProjectConfig } from "../utils/project-config";

interface EnvOptions {
  env?: string;
}

export async function envListCommand(options: EnvOptions): Promise<void> {
  const spinner = ora("Fetching environment variables...").start();

  try {
    const { api, projectConfig } = await setupCommand();
    const environment = options.env || "production";

    const envVars = await api.getEnvironmentVariables(
      projectConfig.name,
      environment
    );
    spinner.stop();

    if (Object.keys(envVars).length === 0) {
      logger.info(
        chalk.yellow(`No environment variables found for ${environment}`)
      );
      return;
    }

    console.log();
    logger.info(chalk.bold(`Environment Variables (${environment})`));
    console.log();

    for (const [key, value] of Object.entries(envVars)) {
      // Mask sensitive values
      const displayValue =
        key.toLowerCase().includes("password") ||
        key.toLowerCase().includes("secret") ||
        key.toLowerCase().includes("key")
          ? "*".repeat(8)
          : value;

      logger.info(`${chalk.cyan(key)}: ${chalk.gray(displayValue)}`);
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to fetch environment variables"));
    logger.error("Error:", error);
  }
}

export async function envSetCommand(
  key: string,
  value: string,
  options: EnvOptions
): Promise<void> {
  const spinner = ora("Setting environment variable...").start();

  try {
    const { api, projectConfig } = await setupCommand();
    const environment = options.env || "production";

    await api.setEnvironmentVariable(
      projectConfig.name,
      environment,
      key,
      value
    );
    spinner.succeed(
      `Set ${chalk.cyan(key)} in ${chalk.yellow(environment)} environment`
    );
  } catch (error) {
    spinner.fail(chalk.red("Failed to set environment variable"));
    logger.error("Error:", error);
  }
}

export async function envDeleteCommand(
  key: string,
  options: EnvOptions
): Promise<void> {
  const spinner = ora("Deleting environment variable...").start();

  try {
    const { api, projectConfig } = await setupCommand();
    const environment = options.env || "production";

    // Confirm deletion
    spinner.stop();
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Delete ${chalk.cyan(key)} from ${chalk.yellow(environment)} environment?`,
        default: false,
      },
    ]);

    if (!answers.confirm) {
      logger.info("Deletion cancelled");
      return;
    }

    spinner.start("Deleting environment variable...");
    await api.deleteEnvironmentVariable(projectConfig.name, environment, key);
    spinner.succeed(
      `Deleted ${chalk.cyan(key)} from ${chalk.yellow(environment)} environment`
    );
  } catch (error) {
    spinner.fail(chalk.red("Failed to delete environment variable"));
    logger.error("Error:", error);
  }
}

async function setupCommand(): Promise<{
  api: CirronApi;
  projectConfig: ProjectConfig;
}> {
  const projectConfigResult = loadProjectConfig();

  if (!projectConfigResult) {
    throw new Error(
      "No cirron config found (cirron.yaml or cirron.json). Run cirron init to initialize a project"
    );
  }

  const projectConfig = projectConfigResult.config;

  const config = new ConfigManager();
  const currentConfig = config.load();

  if (!isAuthenticated(currentConfig)) {
    throw new Error("Not authenticated. Run cirron auth login to authenticate");
  }

  const api = new CirronApi(currentConfig);
  return { api, projectConfig };
}
