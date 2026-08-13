import chalk from "chalk";
import inquirer from "inquirer";
import ora from "ora";
import type { InferenceKeyInfo, IssuedInferenceKey } from "../types";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";

interface KeysIssueOptions {
  expiresAt?: string;
  name?: string;
}

interface KeysRotateOptions {
  name?: string;
}

interface KeysRevokeOptions {
  yes?: boolean;
}

/** Entry point for `cirron keys issue <deploymentId>`. */
export async function keysIssueCommand(
  deploymentId: string,
  options: KeysIssueOptions
): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  if (options.expiresAt && Number.isNaN(Date.parse(options.expiresAt))) {
    logger.error(
      `Invalid --expires-at value: ${chalk.yellow(options.expiresAt)} (expected an ISO date)`
    );
    process.exit(1);
  }

  const spinner = ora("Issuing inference key...").start();
  try {
    const issued = await api.issueInferenceKey(deploymentId, {
      ...(options.name ? { name: options.name } : {}),
      ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    });
    spinner.succeed("Inference key issued");
    printIssuedKey(issued);
  } catch (error) {
    spinner.fail(chalk.red("Failed to issue inference key"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Entry point for `cirron keys list <deploymentId>`. */
export async function keysListCommand(deploymentId: string): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  const spinner = ora("Fetching inference keys...").start();
  try {
    const keys = await api.listInferenceKeys(deploymentId);
    spinner.stop();

    if (keys.length === 0) {
      logger.info("No inference keys for this deployment");
      logger.info(
        `Issue one with ${chalk.cyan(`cirron keys issue ${deploymentId}`)}`
      );
      return;
    }

    console.log();
    logger.info(chalk.bold(`Inference keys (${keys.length})`));
    console.log();
    for (const key of keys) {
      printKeyRow(key);
    }
  } catch (error) {
    spinner.fail(chalk.red("Failed to list inference keys"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Entry point for `cirron keys rotate <deploymentId> <keyId>`. */
export async function keysRotateCommand(
  deploymentId: string,
  keyId: string,
  options: KeysRotateOptions
): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  const spinner = ora("Rotating inference key...").start();
  try {
    const rotated = await api.rotateInferenceKey(deploymentId, keyId, {
      ...(options.name ? { name: options.name } : {}),
    });
    spinner.succeed("Inference key rotated");
    logger.info(
      `The old key ${chalk.yellow(keyId)} is revoked; update clients now.`
    );
    printIssuedKey(rotated);
  } catch (error) {
    spinner.fail(chalk.red("Failed to rotate inference key"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Entry point for `cirron keys revoke <deploymentId> <keyId>`. */
export async function keysRevokeCommand(
  deploymentId: string,
  keyId: string,
  options: KeysRevokeOptions
): Promise<void> {
  const api = requireApi();
  if (!api) {
    return;
  }

  if (!options.yes) {
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: `Revoke inference key ${chalk.yellow(keyId)}? Clients using it will get 401 within 30 seconds.`,
        default: false,
      },
    ]);
    if (!answers.confirm) {
      logger.info("Revocation cancelled");
      return;
    }
  }

  const spinner = ora("Revoking inference key...").start();
  try {
    await api.revokeInferenceKey(deploymentId, keyId);
    spinner.succeed("Inference key revoked");
  } catch (error) {
    spinner.fail(chalk.red("Failed to revoke inference key"));
    handlePlatformError(error);
    process.exit(1);
  }
}

/** Auth prologue shared by every keys subcommand. */
function requireApi(): CirronApi | null {
  const config = new ConfigManager();
  const currentConfig = config.load();
  if (!isAuthenticated(currentConfig)) {
    logger.error(
      `Not authenticated. Run ${chalk.cyan("cirron auth login")} first`
    );
    process.exit(1);
  }
  return new CirronApi(currentConfig);
}

/** Print an issued/rotated key: the one time the raw key is ever visible. */
function printIssuedKey(issued: IssuedInferenceKey): void {
  console.log();
  logger.info(
    chalk.bold.yellow(
      "This key is shown once and cannot be retrieved again - store it now."
    )
  );
  console.log();
  logger.info(`  ${chalk.bold("Key:")}     ${chalk.green(issued.rawKey)}`);
  logger.info(`  ${chalk.bold("Prefix:")}  ${issued.key.prefix}`);
  if (issued.key.name) {
    logger.info(`  ${chalk.bold("Name:")}    ${issued.key.name}`);
  }
  if (issued.key.expiresAt) {
    logger.info(`  ${chalk.bold("Expires:")} ${issued.key.expiresAt}`);
  }
  console.log();
  logger.info(
    `Use it as ${chalk.cyan(`Authorization: Bearer ${issued.key.prefix}...`)} against the deployment's managed hostname`
  );
}

function printKeyRow(key: InferenceKeyInfo): void {
  const status = key.revokedAt
    ? chalk.red("revoked")
    : key.expiresAt && Date.parse(key.expiresAt) < Date.now()
      ? chalk.yellow("expired")
      : chalk.green("active");
  logger.info(
    `  ${chalk.bold(key.prefix)}  ${status}  ${key.name ?? chalk.dim("(unnamed)")}`
  );
  logger.info(
    chalk.dim(
      `    id ${key.id} | created ${key.createdAt} | last used ${key.lastUsedAt ?? "never"}${key.expiresAt ? ` | expires ${key.expiresAt}` : ""}`
    )
  );
}
