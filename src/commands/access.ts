import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";

interface AccessSetOptions {
  private?: boolean;
  public?: boolean;
  yes?: boolean;
}

/** Entry point for `cirron access get <deploymentId>`. */
export async function accessGetCommand(deploymentId: string): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  const spinner = ora("Fetching access posture...").start();
  try {
    const makePublic = await api.getDeploymentAccess(deploymentId);
    spinner.stop();
    printPosture(makePublic);
  } catch (error) {
    spinner.fail(chalk.red("Failed to read deployment access"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Entry point for `cirron access set <deploymentId> --public|--private`. */
export async function accessSetCommand(
  deploymentId: string,
  options: AccessSetOptions
): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  if (options.public === options.private) {
    logger.error(
      `Pass exactly one of ${chalk.cyan("--public")} or ${chalk.cyan("--private")}`
    );
    process.exit(1);
    // Reached only when process.exit is mocked (tests): never proceed.
    return;
  }
  const makePublic = Boolean(options.public);

  if (makePublic && !options.yes) {
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Make ${chalk.yellow(deploymentId)} publicly invokable WITHOUT an inference key?`,
        default: false,
      },
    ]);
    if (!answers.confirm) {
      logger.info("Access change cancelled");
      return;
    }
  }

  const spinner = ora(
    makePublic ? "Making deployment public..." : "Making deployment private..."
  ).start();
  try {
    const result = await api.setDeploymentAccess(deploymentId, makePublic);
    spinner.succeed("Access updated (reaches gateways within seconds)");
    printPosture(result);
  } catch (error) {
    spinner.fail(chalk.red("Failed to update deployment access"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Auth prologue shared by the access subcommands. */
function requireApi(): CirronApi | null {
  const config = new ConfigManager();
  const currentConfig = config.load();
  if (!isAuthenticated(currentConfig)) {
    logger.error(
      `Not authenticated. Run ${chalk.cyan("cirron auth login")} first`
    );
    process.exit(1);
    // Reached only when process.exit is mocked (tests): stay side-effect free.
    return null;
  }
  return new CirronApi(currentConfig);
}

function printPosture(makePublic: boolean): void {
  if (makePublic) {
    logger.info(
      `Access: ${chalk.yellow("public")} - the managed URL answers without an inference key`
    );
  } else {
    logger.info(
      `Access: ${chalk.green("private")} - requests need an inference key (the default)`
    );
  }
}
