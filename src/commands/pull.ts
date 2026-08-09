import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import ora from "ora";
import type {
  PullArtifactInfo,
  PullOptions,
  PullResourceType,
  PullResult,
} from "../types";
import { CirronApi } from "../utils/api";
import { handlePlatformError } from "../utils/api-errors";
import {
  isResourceTyped,
  KNOWN_RESOURCE_TYPES,
  parseNameTag,
} from "../utils/artifacts";
import { computeFileChecksum } from "../utils/checksum";
import { ConfigManager } from "../utils/config";
import { formatSize } from "../utils/format";
import { CirronIgnore } from "../utils/ignore";
import { logger } from "../utils/logger";
import { loadProjectConfigOrNull as loadProjectConfig } from "../utils/project-config";
import { resolveWithin } from "../utils/safe-path";

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

async function resolveOutputPath(
  artifact: PullArtifactInfo,
  outputOption: string | undefined
): Promise<string> {
  const outputDir = outputOption || process.cwd();
  await fs.ensureDir(outputDir);

  // `filename` is server-supplied: contain it inside the chosen output
  // directory. The user's own --output stays unconstrained.
  const dest = resolveWithin(outputDir, artifact.filename);
  if (!dest) {
    throw new Error(
      `Refusing to write artifact with unsafe filename: ${artifact.filename}`
    );
  }
  return dest;
}

async function checkConflict(
  destPath: string,
  force: boolean
): Promise<boolean> {
  if (!fs.existsSync(destPath)) {
    return true;
  }

  if (force) {
    logger.debug(`Overwriting existing file: ${destPath}`);
    return true;
  }

  const { overwrite } = await inquirer.prompt([
    {
      type: "confirm",
      name: "overwrite",
      message: `File already exists: ${path.basename(destPath)}. Overwrite?`,
      default: false,
      loop: false,
    },
  ]);

  return overwrite;
}

/**
 * Download one artifact to an already-resolved destination path.
 *
 * The caller is responsible for containing `destPath` within the project;
 * this does not re-check it.
 *
 * @param api - Authenticated platform client.
 * @param artifact - The artifact to fetch.
 * @param destPath - Absolute path to write to.
 * @param spinner - Progress spinner, updated in place.
 */
export async function downloadArtifact(
  api: CirronApi,
  artifact: PullArtifactInfo,
  destPath: string,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  const downloadInfo = await api.getPullDownloadUrl(artifact.id);

  const tempPath = `${destPath}.tmp`;

  try {
    spinner.text = `Downloading ${artifact.name} (${formatSize(artifact.size)})...`;

    await api.downloadFile(
      downloadInfo.downloadUrl,
      tempPath,
      (downloaded, total) => {
        const pct = Math.round((downloaded / total) * 100);
        spinner.text = `Downloading ${artifact.name}: ${pct}% (${formatSize(downloaded)}/${formatSize(total)})`;
      }
    );

    spinner.text = `Verifying checksum for ${artifact.name}...`;
    const actualChecksum = await computeFileChecksum(tempPath);

    if (actualChecksum !== artifact.checksum) {
      await fs.remove(tempPath);
      throw new Error(
        `Checksum mismatch for ${artifact.name}: expected ${artifact.checksum}, got ${actualChecksum}`
      );
    }

    await fs.move(tempPath, destPath, { overwrite: true });
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      await fs.remove(tempPath);
    }
    throw error;
  }
}

/**
 * The shared tail of a single-artifact pull: dry-run, destination, conflict
 * prompt, download, and the optional JSON result.
 *
 * `successSubject` is the only thing the resource-typed and path-based callers
 * disagree on, so it is a parameter rather than two copies of the sequence.
 */
async function completePull(
  api: CirronApi,
  artifact: PullArtifactInfo,
  options: PullOptions,
  spinner: ReturnType<typeof ora>,
  successSubject: string
): Promise<void> {
  const outputDir = options.output || process.cwd();

  if (options.dryRun) {
    spinner.stop();
    printDryRun([artifact], outputDir, options.json ?? false);
    return;
  }

  const destPath = await resolveOutputPath(artifact, options.output);

  const shouldProceed = await checkConflict(destPath, options.force ?? false);
  if (!shouldProceed) {
    spinner.info(`Skipped ${artifact.name} (file exists)`);
    return;
  }

  await downloadArtifact(api, artifact, destPath, spinner);

  spinner.succeed(`Pulled ${successSubject} -> ${destPath}`);

  if (options.json) {
    const result: PullResult = {
      artifact,
      outputPath: destPath,
      verified: true,
      skipped: false,
    };
    console.log(JSON.stringify(result, null, 2));
  }
}

// Dry Run

function printDryRun(
  artifacts: PullArtifactInfo[],
  outputDir: string,
  jsonOutput: boolean
): void {
  if (jsonOutput) {
    const result = artifacts.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      tag: a.tag,
      filename: a.filename,
      size: a.size,
      outputPath: path.join(outputDir, a.filename),
    }));
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  logger.info(chalk.bold("Dry run - the following artifacts would be pulled:"));
  console.log();

  const totalSize = artifacts.reduce((sum, a) => sum + a.size, 0);

  artifacts.forEach((artifact, index) => {
    logger.info(`  ${index + 1}. ${chalk.cyan(artifact.name)}`);
    logger.info(`     Type:     ${artifact.type}`);
    logger.info(`     Tag:      ${artifact.tag}`);
    logger.info(`     File:     ${artifact.filename}`);
    logger.info(`     Size:     ${formatSize(artifact.size)}`);
    logger.info(`     Output:   ${path.join(outputDir, artifact.filename)}`);
    console.log();
  });

  logger.info(
    `Total: ${artifacts.length} artifact(s), ${formatSize(totalSize)}`
  );
  logger.info(
    chalk.gray("No files were downloaded. Remove --dry-run to pull.")
  );
}

// Main Command

/** Entry point for `cirron pull`: download registry artifacts into the project. */
export async function pullCommand(
  resource: string | undefined,
  name: string | undefined,
  options: PullOptions
): Promise<void> {
  // Handle --interactive: enhanced stub for beta
  if (options.interactive) {
    logger.info(
      `${chalk.yellow("pull --interactive")} is not yet fully implemented.`
    );
    logger.info("Guided pull flow will be available in a future release.");
    if (resource) {
      logger.info(`Resource: ${resource}`);
    }
    if (name) {
      logger.info(`Name: ${name}`);
    }
    const optKeys = Object.entries(options)
      .filter(([key, val]) => key !== "interactive" && val !== undefined)
      .map(([key, val]) => `${key}=${val}`);
    if (optKeys.length > 0) {
      logger.info(`Options: ${optKeys.join(", ")}`);
    }
    return;
  }

  // Auth check
  const auth = checkAuth();
  if (!auth) {
    return;
  }
  const { api } = auth;

  // Handle --all mode
  if (options.all) {
    await pullAll(api, options);
    return;
  }

  // Validate resource is provided when not using --all
  if (!resource) {
    logger.error("Resource type or path is required");
    logger.info(
      `Usage: ${chalk.cyan("cirron pull <resource> [name] [options]")}`
    );
    logger.info(`       ${chalk.cyan("cirron pull --all")}`);
    logger.info(`Resource types: ${KNOWN_RESOURCE_TYPES.join(", ")}`);
    return;
  }

  // Determine if resource-typed or path-based
  if (isResourceTyped(resource)) {
    await pullResourceTyped(api, resource as PullResourceType, name, options);
  } else {
    await pullPathBased(api, resource, options);
  }
}

// Resource-typed pull

async function pullResourceTyped(
  api: CirronApi,
  resource: PullResourceType,
  name: string | undefined,
  options: PullOptions
): Promise<void> {
  if (!name) {
    logger.error(
      `Resource name is required for ${chalk.cyan(`cirron pull ${resource}`)}`
    );
    logger.info(
      `Usage: ${chalk.cyan(`cirron pull ${resource} <name> [--tag <tag>]`)}`
    );
    return;
  }

  const parsed = parseNameTag(name);
  const resolvedName = parsed.name;
  const resolvedTag = options.tag || parsed.tag || "latest";

  const spinner = ora(
    `Fetching artifact info for ${resource} ${resolvedName}:${resolvedTag}...`
  ).start();

  try {
    const fetchOptions: {
      resource?: string;
      name?: string;
      tag?: string;
    } = {};
    fetchOptions.resource = resource;
    fetchOptions.name = resolvedName;
    fetchOptions.tag = resolvedTag;

    const artifacts = await api.getPullArtifacts(fetchOptions);

    if (!artifacts || artifacts.length === 0) {
      spinner.fail(
        `No artifact found: ${resource} ${resolvedName}:${resolvedTag}`
      );
      return;
    }

    const artifact = artifacts[0]!;
    await completePull(
      api,
      artifact,
      options,
      spinner,
      `${chalk.cyan(artifact.name)}:${resolvedTag}`
    );
  } catch (error) {
    spinner.fail(`Failed to pull ${resource} ${resolvedName}`);
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

// Path-based pull

async function pullPathBased(
  api: CirronApi,
  resourcePath: string,
  options: PullOptions
): Promise<void> {
  const spinner = ora(
    `Fetching artifact info for path: ${resourcePath}...`
  ).start();

  try {
    const fetchOptions: { path?: string; tag?: string } = {};
    fetchOptions.path = resourcePath;
    if (options.tag) {
      fetchOptions.tag = options.tag;
    }

    const artifacts = await api.getPullArtifacts(fetchOptions);

    if (!artifacts || artifacts.length === 0) {
      spinner.fail(`No artifact found for path: ${resourcePath}`);
      return;
    }

    const artifact = artifacts[0]!;
    await completePull(
      api,
      artifact,
      options,
      spinner,
      chalk.cyan(resourcePath)
    );
  } catch (error) {
    spinner.fail(`Failed to pull ${resourcePath}`);
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

// Pull all

async function pullAll(api: CirronApi, options: PullOptions): Promise<void> {
  const projectConfig = loadProjectConfig();
  if (!projectConfig) {
    logger.error(
      "No cirron config found (cirron.yaml or cirron.json) in current directory"
    );
    logger.info(
      `Run ${chalk.cyan("cirron init")} to initialize a project, or use ${chalk.cyan("cirron pull <resource> <name>")} to pull a specific artifact`
    );
    return;
  }

  const spinner = ora(
    `Fetching all artifacts for project: ${projectConfig.name}...`
  ).start();

  try {
    const fetchOptions: { projectName?: string; type?: string } = {};
    fetchOptions.projectName = projectConfig.name;
    if (options.type) {
      fetchOptions.type = options.type;
    }

    const artifacts = await api.getPullArtifacts(fetchOptions);

    if (!artifacts || artifacts.length === 0) {
      spinner.info("No artifacts found for this project");
      return;
    }

    // Apply --ignore patterns
    let filteredArtifacts = artifacts;
    if (options.ignore) {
      const patterns = options.ignore.split(",").map((p) => p.trim());
      const ignore = new CirronIgnore({ defaultPatterns: patterns });
      filteredArtifacts = artifacts.filter(
        (a) => !ignore.isIgnored(a.filename)
      );
    }

    if (filteredArtifacts.length === 0) {
      spinner.info("All artifacts were excluded by --ignore patterns");
      return;
    }

    const outputDir = options.output || process.cwd();

    if (options.dryRun) {
      spinner.stop();
      printDryRun(filteredArtifacts, outputDir, options.json ?? false);
      return;
    }

    spinner.succeed(
      `Found ${filteredArtifacts.length} artifact(s) for project ${chalk.cyan(projectConfig.name)}`
    );

    const results: PullResult[] = [];
    let successCount = 0;
    let skipCount = 0;
    let failCount = 0;

    for (const artifact of filteredArtifacts) {
      const itemSpinner = ora(`Pulling ${artifact.name}...`).start();

      try {
        const destPath = await resolveOutputPath(artifact, options.output);

        const shouldProceed = await checkConflict(
          destPath,
          options.force ?? false
        );
        if (!shouldProceed) {
          itemSpinner.info(`Skipped ${artifact.name} (file exists)`);
          skipCount++;
          results.push({
            artifact,
            outputPath: destPath,
            verified: false,
            skipped: true,
          });
          continue;
        }

        await downloadArtifact(api, artifact, destPath, itemSpinner);

        itemSpinner.succeed(
          `Pulled ${chalk.cyan(artifact.name)} -> ${destPath}`
        );
        successCount++;
        results.push({
          artifact,
          outputPath: destPath,
          verified: true,
          skipped: false,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : "Unknown error";
        itemSpinner.fail(`Failed to pull ${artifact.name}: ${msg}`);
        failCount++;
        results.push({
          artifact,
          outputPath: path.join(outputDir, artifact.filename),
          verified: false,
          skipped: false,
        });
      }
    }

    // Summary
    console.log();
    logger.info(chalk.bold("Pull summary:"));
    logger.info(`  Succeeded: ${chalk.green(String(successCount))}`);
    if (skipCount > 0) {
      logger.info(`  Skipped:   ${chalk.yellow(String(skipCount))}`);
    }
    if (failCount > 0) {
      logger.info(`  Failed:    ${chalk.red(String(failCount))}`);
    }

    if (options.json) {
      console.log(JSON.stringify(results, null, 2));
    }

    if (failCount > 0) {
      process.exit(1);
    }
  } catch (error) {
    spinner.fail("Failed to fetch project artifacts");
    handlePlatformError(error);
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown error occurred");
    }
    process.exit(1);
  }
}
