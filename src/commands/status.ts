import { execSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type { ProjectConfig, ProjectStatus } from "../types";
import { CirronApi } from "../utils/api";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { logger } from "../utils/logger";
import { loadProjectConfig } from "../utils/project-config";

interface StatusOptions {
  remote?: boolean;
}

export async function statusCommand(options: StatusOptions): Promise<void> {
  const spinner = ora("Checking project status...").start();

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

    // Get local status
    const localStatus = await getLocalStatus(projectConfig);

    let remoteStatus: Awaited<ReturnType<typeof getRemoteStatus>> | null = null;
    if (options.remote) {
      remoteStatus = await getRemoteStatus(projectConfig);
    }

    spinner.succeed("Status check complete");

    // Display status
    console.log();
    logger.info(chalk.bold(`Project Status: ${projectConfig.name}`));
    console.log();

    // Local status
    logger.info(chalk.bold("Local Status"));
    logger.info(
      `Current branch: ${chalk.cyan(localStatus.currentBranch || "unknown")}`
    );
    logger.info(
      `Git status: ${localStatus.isGitClean ? chalk.green("clean") : chalk.yellow("uncommitted changes")}`
    );

    if (localStatus.buildStatus) {
      const statusColor =
        localStatus.buildStatus === "success" ? chalk.green : chalk.red;
      logger.info(`Last build: ${statusColor(localStatus.buildStatus)}`);
    }

    // Remote status
    if (remoteStatus) {
      console.log();
      logger.info(chalk.bold("Remote Status"));

      if (remoteStatus.lastDeployment) {
        const deployment = remoteStatus.lastDeployment;
        const statusColor =
          deployment.status === "success"
            ? chalk.green
            : deployment.status === "failed"
              ? chalk.red
              : chalk.yellow;

        logger.info(`Last deployment: ${statusColor(deployment.status)}`);
        logger.info(`Environment: ${chalk.cyan(deployment.environment)}`);
        logger.info(
          `Deployed: ${chalk.cyan(new Date(deployment.createdAt).toLocaleString())}`
        );

        if (deployment.url) {
          logger.info(`URL: ${chalk.cyan(deployment.url)}`);
        }
      } else {
        logger.info(chalk.yellow("No deployments found"));
      }
    }

    // Environments
    console.log();
    logger.info(chalk.bold("Environments"));
    for (const env of Object.keys(projectConfig.environments || {})) {
      const envConfig = projectConfig.environments?.[env];
      let status = chalk.gray("configured");

      if (remoteStatus?.lastDeployment?.environment === env) {
        status =
          remoteStatus.lastDeployment.status === "success"
            ? chalk.green("deployed")
            : chalk.red("failed");
      }

      logger.info(
        `  ${env}: ${status}${envConfig?.url ? ` (${envConfig.url})` : ""}`
      );
    }
  } catch (error) {
    spinner.fail(chalk.red("Status check failed"));
    logger.error("Error:", error);
  }
}

async function getLocalStatus(
  projectConfig: ProjectConfig
): Promise<Partial<ProjectStatus>> {
  const status: Partial<ProjectStatus> = {
    name: projectConfig.name,
    environments: Object.keys(projectConfig.environments || {}),
  };

  // Check git status
  try {
    const gitStatus = execSync("git status --porcelain", {
      stdio: "pipe",
      encoding: "utf8",
    })
      .toString()
      .trim();

    status.isGitClean = gitStatus.length === 0;

    const currentBranch = execSync("git branch --show-current", {
      stdio: "pipe",
      encoding: "utf8",
    })
      .toString()
      .trim();

    status.currentBranch = currentBranch;
  } catch {
    // Not a git repository or git not available
    // Don't assign undefined to optional properties
  }

  // Check build status
  const buildConfig = projectConfig.build;
  if (buildConfig?.outputDir) {
    const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
    if (fs.existsSync(outputPath)) {
      status.buildStatus = "success";
    }
  }

  return status;
}

async function getRemoteStatus(
  projectConfig: ProjectConfig
): Promise<Partial<ProjectStatus> | null> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!isAuthenticated(currentConfig)) {
      return null;
    }

    const api = new CirronApi(currentConfig);
    const deployments = await api.getDeployments(projectConfig.name, {
      limit: 1,
    });

    const result: Partial<ProjectStatus> = {};
    if (deployments[0]) {
      result.lastDeployment = deployments[0];
    }
    return result;
  } catch (error) {
    logger.debug("Failed to get remote status:", error);
    return null;
  }
}
