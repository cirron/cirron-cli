import { execSync, spawn } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type { BuildOptions, HardwareConfig, ProjectConfig } from "../types";
import { CirronApi } from "../utils/api";
import { ConfigManager } from "../utils/config";
import { executePythonScript, formatExecutionError } from "../utils/execution";
import { HardwareDetector } from "../utils/hardware";
import { CirronIgnore } from "../utils/ignore";
import { createInteractiveManager } from "../utils/interactive";
import { logger } from "../utils/logger";
import { ModelConfigManager } from "../utils/model-config";
import { loadProjectConfig } from "../utils/project-config";

interface ValidationResult {
  critical: string[];
  nonCritical: string[];
}

interface MetadataMismatch {
  description: string;
  detectedValue: string;
  field: string;
  severity: "critical" | "warning" | "info";
  storedValue?: string;
}

function categorizeValidationErrors(errors: string[]): ValidationResult {
  const critical: string[] = [];
  const nonCritical: string[] = [];

  for (const error of errors) {
    // Critical errors that always cause build failure
    if (
      error.includes("Required file missing") ||
      error.includes("Invalid cirron.json") ||
      error.includes("Invalid cirron.yaml") ||
      error.includes("No cirron config found") ||
      error.includes("No cirron.json found") ||
      error.includes("Project configuration invalid")
    ) {
      critical.push(error);
    } else {
      // Non-critical errors that can be bypassed with --force
      nonCritical.push(error);
    }
  }

  return { critical, nonCritical };
}

function displayForceWarnings(
  nonCriticalErrors: string[],
  metadataMismatches: MetadataMismatch[],
  options: BuildOptions
): void {
  if (nonCriticalErrors.length === 0 && metadataMismatches.length === 0) {
    return;
  }

  console.log();
  console.log(chalk.bold.yellow("Build Warnings (proceeding with --force)"));
  console.log(chalk.gray("─".repeat(50)));

  // Display non-critical validation errors
  if (nonCriticalErrors.length > 0) {
    console.log(chalk.bold("Validation Issues:"));
    for (const error of nonCriticalErrors) {
      console.log(`  ${chalk.yellow("⚠")} ${error}`);
    }
    console.log();
  }

  // Display metadata mismatches
  if (metadataMismatches.length > 0) {
    console.log(chalk.bold("Metadata Mismatches:"));
    for (const mismatch of metadataMismatches) {
      const severityIcon =
        mismatch.severity === "critical" ? chalk.red("●") : chalk.yellow("⚠");
      console.log(`  ${severityIcon} ${mismatch.description}`);
    }
    console.log();
    console.log(
      chalk.gray("Run ") +
        chalk.cyan("cirron info --update metadata") +
        chalk.gray(" to refresh metadata.")
    );
    console.log();
  }

  if (options.force) {
    console.log(
      chalk.yellow(
        "Continuing build with --force flag. Build traceability maintained."
      )
    );
  }
  console.log();
}

async function checkMetadataMismatches(
  projectConfig: ProjectConfig
): Promise<MetadataMismatch[]> {
  // This is a simplified version of metadata checking
  // In a full implementation, we would import and use the analysis from info.ts
  const mismatches: MetadataMismatch[] = [];

  try {
    const modelPath = path.join(process.cwd(), "src", "model.py");
    if (fs.existsSync(modelPath) && projectConfig.metadata) {
      // Simple git commit check
      try {
        const currentCommit = execSync("git rev-parse --short HEAD", {
          encoding: "utf8",
        }).trim();
        if (
          projectConfig.metadata.gitCommitHash &&
          currentCommit !== projectConfig.metadata.gitCommitHash
        ) {
          mismatches.push({
            field: "gitCommitHash",
            storedValue: projectConfig.metadata.gitCommitHash,
            detectedValue: currentCommit,
            description: `Git commit changed: ${projectConfig.metadata.gitCommitHash} → ${currentCommit}`,
            severity: "warning",
          });
        }
      } catch {
        // Git not available or not a git repo - not critical
      }
    }
  } catch (error) {
    // Metadata checking failed - not critical for build
    logger.debug("Metadata mismatch check failed:", error);
  }

  return mismatches;
}

export async function buildCommand(options: BuildOptions): Promise<void> {
  const spinner = ora("Preparing build...").start();

  try {
    // Load project configuration
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(
        chalk.red("No cirron config found (cirron.yaml or cirron.json)")
      );
      logger.error(`Run ${chalk.cyan("cirron init")} to initialize a project`);
      process.exit(1);
    }

    const { config: projectConfig } = projectConfigResult;

    // Check if this is an ML project
    const isMLProject =
      projectConfig.framework &&
      ["pytorch", "tensorflow", "sklearn"].includes(projectConfig.framework);

    if (isMLProject) {
      // Handle ML model compilation
      await handleMLBuild(projectConfig, options, spinner);
    } else {
      // Handle traditional application build
      await handleTraditionalBuild(projectConfig, options, spinner);
    }
  } catch (error) {
    spinner.fail(chalk.red("Build failed"));

    // Report failure to API
    try {
      const failConfigResult = loadProjectConfig();
      if (failConfigResult) {
        await reportBuildStatus(
          failConfigResult.config,
          options,
          "failed",
          error
        );
      }
    } catch {
      // Ignore API reporting errors
    }

    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown build error occurred");
    }

    process.exit(1);
  }
}

async function handleMLBuild(
  projectConfig: ProjectConfig,
  options: BuildOptions,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  const interactive = createInteractiveManager(options.interactive ?? false);

  // Load model configuration
  const modelConfigManager = new ModelConfigManager();
  const modelConfig = await modelConfigManager.loadModelConfig();

  if (modelConfig) {
    logger.info(
      chalk.blue(
        `Found model configuration: ${modelConfig.name || "unnamed model"}`
      )
    );
    if (modelConfig.architecture) {
      logger.info(chalk.gray(`Architecture: ${modelConfig.architecture}`));
    }
  }

  // Log force flag usage for traceability
  if (options.force) {
    logger.info(chalk.yellow("Build running with --force flag"));
  }

  // Interactive confirmation for build start
  if (interactive.isInteractive()) {
    spinner.stop();
    const shouldProceed = await interactive.confirmStep({
      stepName: "ML Model Build",
      description: `Build ML model for ${projectConfig.framework || "custom"} framework`,
      impact: "high",
      estimatedTime: "3-8 minutes",
      dependencies: [
        "Model files",
        "Requirements",
        "Docker (if containerizing)",
      ],
    });

    if (!shouldProceed) {
      logger.info("Build cancelled by user");
      return;
    }
    spinner.start();
  }

  // Determine architecture from options, model config, or hardware detection
  const architecture =
    options.arch ||
    modelConfig?.inference?.device ||
    (await determineArchitectureFromHardware(projectConfig));

  // Interactive architecture confirmation
  if (interactive.isInteractive() && !options.arch) {
    spinner.stop();
    const confirmedArch = await interactive.selectOption({
      message: "Confirm target architecture",
      type: "select",
      choices: [
        { name: `${architecture} (detected)`, value: architecture },
        { name: "cpu", value: "cpu" },
        { name: "cuda", value: "cuda" },
        { name: "gpu", value: "gpu" },
      ],
      description:
        "The architecture determines optimization targets and hardware compatibility",
    });

    if (confirmedArch !== architecture) {
      logger.info(
        `Architecture changed from ${architecture} to ${confirmedArch}`
      );
    }
    spinner.start();
  }

  spinner.text = `Building ML model for architecture: ${architecture}`;
  logger.info(`Target architecture: ${chalk.cyan(architecture)}`);

  // Load index/manifest file if specified
  let indexConfig: any = null;
  if (options.index) {
    if (fs.existsSync(options.index)) {
      indexConfig = await loadIndexFile(options.index);
      logger.info(`Using index file: ${chalk.cyan(options.index)}`);
    } else if (options.force) {
      logger.warn(
        `Index file not found: ${options.index} (continuing with --force)`
      );
    } else {
      spinner.fail(chalk.red(`Index file not found: ${options.index}`));
      process.exit(1);
    }
  }

  // Validate hardware compatibility if hardware config exists
  if (projectConfig.hardware && !options.force) {
    spinner.text = "Validating hardware compatibility...";
    try {
      await validateHardwareCompatibility(
        projectConfig.hardware,
        architecture,
        projectConfig.framework
      );
      logger.success("✓ Hardware compatibility validated");
    } catch (error) {
      if (options.force) {
        logger.warn(
          `Hardware validation failed but continuing with --force: ${error}`
        );
      } else {
        spinner.fail("Hardware validation failed");
        throw error;
      }
    }
  }

  // Pre-build validation (always run if validate is enabled, force logic is handled inside)
  if (options.validate) {
    if (interactive.isInteractive()) {
      spinner.stop();
      const shouldValidate = await interactive.confirmStep({
        stepName: "Pre-build Validation",
        description:
          "Verify model files, dependencies, and hardware compatibility",
        impact: "medium",
        estimatedTime: "30-60 seconds",
        dependencies: ["Model files", "Requirements.txt", "Python environment"],
      });

      if (shouldValidate) {
        spinner.start();
        spinner.text = "Running validation checks...";
        await runValidationChecks(
          projectConfig,
          indexConfig,
          architecture,
          options
        );
        logger.success("✓ Validation checks passed");
      } else {
        logger.warn("Skipping validation checks");
        spinner.start();
      }
    } else {
      spinner.text = "Running validation checks...";
      await runValidationChecks(
        projectConfig,
        indexConfig,
        architecture,
        options
      );
      logger.success("✓ Validation checks passed");
    }
  }

  // Actual ML model build
  spinner.text = "Building ML model...";
  const artifacts = await performMLBuild(
    projectConfig,
    architecture,
    indexConfig
  );

  // Post-build tests
  spinner.text = "Running integrity tests...";
  await runIntegrityTests(projectConfig, artifacts);

  // Container build if Docker is present
  if (fs.existsSync("Dockerfile")) {
    if (interactive.isInteractive()) {
      spinner.stop();
      const shouldBuildContainer = await interactive.confirmStep({
        stepName: "Container Build",
        description: "Build Docker container with compiled model",
        impact: "high",
        estimatedTime: "2-5 minutes",
        dependencies: ["Dockerfile", "Docker daemon", "Compiled artifacts"],
      });

      if (shouldBuildContainer) {
        spinner.start();
        spinner.text = "Building container...";
        const imageName = generateImageName(projectConfig, options);
        try {
          await buildDockerImage(imageName, options, spinner);

          if (options.push) {
            if (interactive.isInteractive()) {
              spinner.stop();
              const shouldPush = await interactive.confirmCriticalOperation(
                "Push to Registry",
                [
                  `Push image ${imageName} to registry`,
                  "Make image available for deployment",
                  "Upload potentially large image data",
                ],
                "This will upload your image to the configured registry"
              );

              if (shouldPush) {
                spinner.start();
                await pushImage(imageName, spinner);
              } else {
                logger.warn("Skipping image push");
              }
            } else {
              await pushImage(imageName, spinner);
            }
          }
        } catch (error) {
          if (options.force) {
            logger.warn(
              `Docker build failed (continuing with --force): ${error instanceof Error ? error.message : error}`
            );
          } else {
            throw error;
          }
        }
      } else {
        logger.warn("Skipping container build");
      }
    } else {
      spinner.text = "Building container...";
      const imageName = generateImageName(projectConfig, options);
      try {
        await buildDockerImage(imageName, options, spinner);

        if (options.push) {
          await pushImage(imageName, spinner);
        }
      } catch (error) {
        if (options.force) {
          logger.warn(
            `Docker build failed (continuing with --force): ${error instanceof Error ? error.message : error}`
          );
        } else {
          throw error;
        }
      }
    }
  }

  // Report build to API
  await reportBuildStatus(projectConfig, options, "success");

  spinner.succeed(chalk.green("Build completed successfully"));

  // Display results
  logger.info("\nBuild Results:");
  logger.info(`  • Architecture: ${chalk.cyan(architecture)}`);
  logger.info(`  • Artifacts: ${chalk.cyan(artifacts.length)} files generated`);
  artifacts.forEach((artifact) => {
    logger.info(`    - ${chalk.gray(artifact)}`);
  });

  logger.success("ML model build completed successfully!");
}

async function handleTraditionalBuild(
  projectConfig: ProjectConfig,
  options: BuildOptions,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  // Log force flag usage for traceability
  if (options.force) {
    logger.info(chalk.yellow("Build running with --force flag"));
  }

  const buildConfig = projectConfig.build;

  if (!buildConfig) {
    if (options.force) {
      logger.warn(
        "No build configuration found in project config (continuing with --force)"
      );
      return; // Skip traditional build if no config and force is used
    }
    spinner.fail(chalk.red("No build configuration found"));
    logger.error(
      "Add build configuration to your project config (cirron.yaml or cirron.json)"
    );
    process.exit(1);
  }

  spinner.text = `Building for ${options.env} environment...`;

  // Clean output directory if requested
  if (options.clean && buildConfig.outputDir) {
    const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
    if (fs.existsSync(outputPath)) {
      await fs.remove(outputPath);
      logger.info(`Cleaned output directory: ${buildConfig.outputDir}`);
    }
  }

  // Set environment variables
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined
      )
    ),
    NODE_ENV: options.env === "production" ? "production" : "development",
    CIRRON_ENV: options.env,
  };

  // Load environment-specific variables
  const envConfig = projectConfig.environments?.[options.env];
  if (envConfig?.variables) {
    Object.assign(env, envConfig.variables);
  }

  // Run pre-build commands
  if (buildConfig.beforeBuild) {
    spinner.text = "Running pre-build commands...";
    for (const command of buildConfig.beforeBuild) {
      logger.info(`Running: ${command}`);
      try {
        execSync(command, {
          stdio: process.env["CIRRON_VERBOSE"] ? "inherit" : "pipe",
          env,
          cwd: process.cwd(),
        });
      } catch (error) {
        if (options.force) {
          logger.warn(
            `Pre-build command failed: ${command} (continuing with --force)`
          );
        } else {
          spinner.fail(chalk.red(`Pre-build command failed: ${command}`));
          throw error;
        }
      }
    }
  }

  // Run main build command
  spinner.text = "Building project...";

  if (options.watch) {
    spinner.stop();
    logger.info(chalk.blue("Starting build in watch mode..."));
    logger.info("Press Ctrl+C to stop watching");

    await runBuildWatch(buildConfig.command, env);
  } else {
    await runBuild(buildConfig.command, env, spinner);

    // Run post-build commands
    if (buildConfig.afterBuild) {
      spinner.text = "Running post-build commands...";
      for (const command of buildConfig.afterBuild) {
        logger.info(`Running: ${command}`);
        try {
          execSync(command, {
            stdio: process.env["CIRRON_VERBOSE"] ? "inherit" : "pipe",
            env,
            cwd: process.cwd(),
          });
        } catch (error) {
          if (options.force) {
            logger.warn(
              `Post-build command failed: ${command} (continuing with --force)`
            );
          } else {
            spinner.fail(chalk.red(`Post-build command failed: ${command}`));
            throw error;
          }
        }
      }
    }

    // Analyze bundle if requested
    if (options.analyze) {
      await analyzeBuild(projectConfig, options);
    }

    // Report build to Cirron API
    await reportBuildStatus(projectConfig, options, "success");

    spinner.succeed(chalk.green("Build completed successfully!"));

    // Show build output info
    if (buildConfig.outputDir) {
      const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
      if (fs.existsSync(outputPath)) {
        const stats = await getBuildStats(outputPath);
        logger.info(`Output directory: ${chalk.cyan(buildConfig.outputDir)}`);
        logger.info(`Build size: ${chalk.cyan(formatBytes(stats.totalSize))}`);
        logger.info(`Files: ${chalk.cyan(stats.fileCount.toString())}`);
      }
    }

    logger.info(`Environment: ${chalk.cyan(options.env)}`);

    if (options.env !== "production") {
      logger.info(`Run ${chalk.cyan("cirron deploy")} to deploy this build`);
    }
  }
}

function generateImageName(
  projectConfig: ProjectConfig,
  _options: BuildOptions
): string {
  // Get registry/organization from config or environment
  const registry = process.env["CIRRON_REGISTRY"] || "localhost:5000";
  const organization =
    process.env["CIRRON_ORG"] || process.env["USER"] || "cirron";

  // Generate tag
  let tag = "latest";
  if (_options.tag) {
    tag = _options.tag;
  } else if (_options.env !== "development") {
    tag = `${_options.env}-${projectConfig.version}`;
  }

  // Format: registry/organization/project:tag
  const imageName = `${registry}/${organization}/${projectConfig.name}:${tag}`;

  return imageName;
}

async function buildDockerImage(
  imageName: string,
  options: BuildOptions,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  let tempDockerIgnore: string | null = null;

  try {
    // Create temporary .dockerignore from .cirronignore if it exists
    tempDockerIgnore = await createDockerIgnoreFromCirronIgnore();

    return new Promise((resolve, reject) => {
      const buildArgs = ["build", "-t", imageName, "."];

      // Add build args if specified
      if (options.env) {
        buildArgs.push("--build-arg", `CIRRON_ENV=${options.env}`);
      }

      // Add no-cache flag if clean build requested
      if (options.clean) {
        buildArgs.push("--no-cache");
      }

      const child = spawn("docker", buildArgs, {
        stdio: process.env["CIRRON_VERBOSE"] ? "inherit" : "pipe",
        cwd: process.cwd(),
      });

      let errorOutput = "";

      if (child.stdout) {
        child.stdout.on("data", (data) => {
          const text = data.toString();

          // Update spinner with build progress
          const lines = text.split("\n");
          for (const line of lines) {
            if (
              line.includes("Step ") ||
              line.includes("COPY") ||
              line.includes("RUN")
            ) {
              spinner.text = `Building container: ${line.trim()}`;
            }
          }

          if (process.env["CIRRON_VERBOSE"]) {
            process.stdout.write(data);
          }
        });
      }

      if (child.stderr) {
        child.stderr.on("data", (data) => {
          errorOutput += data.toString();
          if (process.env["CIRRON_VERBOSE"]) {
            process.stderr.write(data);
          }
        });
      }

      child.on("close", async (code) => {
        // Cleanup temporary .dockerignore
        if (tempDockerIgnore) {
          await cleanupDockerIgnore(tempDockerIgnore);
        }

        if (code === 0) {
          resolve();
        } else {
          const error = new Error(`Docker build failed with exit code ${code}`);
          if (errorOutput) {
            logger.error("Docker build error:", errorOutput);
          }
          reject(error);
        }
      });

      child.on("error", async (error) => {
        // Cleanup temporary .dockerignore
        if (tempDockerIgnore) {
          await cleanupDockerIgnore(tempDockerIgnore);
        }

        spinner.fail(chalk.red("Failed to start Docker build"));
        reject(error);
      });
    });
  } catch (error) {
    // Cleanup temporary .dockerignore if creation failed
    if (tempDockerIgnore) {
      await cleanupDockerIgnore(tempDockerIgnore);
    }
    throw error;
  }
}

async function pushImage(
  imageName: string,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  spinner.text = `Pushing image to registry: ${imageName}...`;

  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["push", imageName], {
      stdio: process.env["CIRRON_VERBOSE"] ? "inherit" : "pipe",
      cwd: process.cwd(),
    });

    let errorOutput = "";

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        const text = data.toString();

        // Update spinner with push progress
        if (text.includes("Pushing") || text.includes("Pushed")) {
          const lines = text.split("\n").filter((line: string) => line.trim());
          if (lines.length > 0) {
            spinner.text = `Pushing: ${lines[lines.length - 1].trim()}`;
          }
        }

        if (process.env["CIRRON_VERBOSE"]) {
          process.stdout.write(data);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        errorOutput += data.toString();
        if (process.env["CIRRON_VERBOSE"]) {
          process.stderr.write(data);
        }
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Docker push failed with exit code ${code}`);
        if (errorOutput) {
          logger.error("Docker push error:", errorOutput);
        }
        reject(error);
      }
    });

    child.on("error", (error) => {
      spinner.fail(chalk.red("Failed to start Docker push"));
      reject(error);
    });
  });
}

async function runBuild(
  command: string,
  env: Record<string, string>,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(" ");

    if (!cmd) {
      reject(new Error("Invalid command: empty command string"));
      return;
    }

    const child = spawn(cmd, args, {
      stdio: process.env["CIRRON_VERBOSE"] ? "inherit" : "pipe",
      env,
      cwd: process.cwd(),
      shell: true,
    });

    let errorOutput = "";

    if (child.stdout) {
      child.stdout.on("data", (data) => {
        if (process.env["CIRRON_VERBOSE"]) {
          process.stdout.write(data);
        }
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        errorOutput += data.toString();
        if (process.env["CIRRON_VERBOSE"]) {
          process.stderr.write(data);
        }
      });
    }

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const error = new Error(`Build command failed with exit code ${code}`);
        if (errorOutput) {
          logger.error("Build output:", errorOutput);
        }
        reject(error);
      }
    });

    child.on("error", (error) => {
      spinner.fail(chalk.red("Failed to start build process"));
      reject(error);
    });
  });
}

async function runBuildWatch(
  command: string,
  env: Record<string, string>
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(" ");

    if (!cmd) {
      reject(new Error("Invalid command: empty command string"));
      return;
    }

    // Add watch flag if not present
    if (!(args.includes("--watch") || args.includes("-w"))) {
      args.push("--watch");
    }

    const child = spawn(cmd, args, {
      stdio: "inherit",
      env,
      cwd: process.cwd(),
      shell: true,
    });

    // Handle graceful shutdown
    process.on("SIGINT", () => {
      logger.info("\nStopping build watch...");
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Watch process exited with code ${code}`));
      }
    });

    child.on("error", (error) => {
      reject(error);
    });
  });
}

async function analyzeBuild(
  projectConfig: ProjectConfig,
  _options: BuildOptions
): Promise<void> {
  const spinner = ora("Analyzing build...").start();

  try {
    const buildConfig = projectConfig.build;
    if (!buildConfig?.outputDir) {
      spinner.warn("No output directory configured for analysis");
      return;
    }

    const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
    if (!fs.existsSync(outputPath)) {
      spinner.warn("Build output directory not found");
      return;
    }

    const stats = await getBuildStats(outputPath);
    const analysis = await analyzeBuildOutput(outputPath);

    spinner.succeed("Build analysis complete");

    // Display analysis results
    console.log();
    logger.info(chalk.bold("Build Analysis"));
    logger.info(`Total size: ${chalk.cyan(formatBytes(stats.totalSize))}`);
    logger.info(`File count: ${chalk.cyan(stats.fileCount.toString())}`);

    if (analysis.largestFiles.length > 0) {
      console.log();
      logger.info(chalk.bold(" Largest files:"));
      analysis.largestFiles.slice(0, 5).forEach((file) => {
        logger.info(`  ${file.name}: ${chalk.cyan(formatBytes(file.size))}`);
      });
    }

    if (analysis.recommendations.length > 0) {
      console.log();
      logger.info(chalk.bold("Recommendations:"));
      analysis.recommendations.forEach((rec) => {
        logger.info(`  ${chalk.yellow("•")} ${rec}`);
      });
    }
  } catch (error) {
    spinner.fail("Build analysis failed");
    logger.error("Analysis error:", error);
  }
}

async function getBuildStats(
  outputPath: string
): Promise<{ totalSize: number; fileCount: number }> {
  let totalSize = 0;
  let fileCount = 0;

  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = await fs.stat(itemPath);

      if (stat.isDirectory()) {
        await walk(itemPath);
      } else {
        totalSize += stat.size;
        fileCount++;
      }
    }
  };

  await walk(outputPath);
  return { totalSize, fileCount };
}

async function analyzeBuildOutput(outputPath: string): Promise<{
  largestFiles: Array<{ name: string; size: number }>;
  recommendations: string[];
}> {
  const files: Array<{ name: string; size: number; path: string }> = [];
  const recommendations: string[] = [];

  const walk = async (dir: string, relativePath = ""): Promise<void> => {
    const items = await fs.readdir(dir);

    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = await fs.stat(itemPath);
      const relativeItemPath = path.join(relativePath, item);

      if (stat.isDirectory()) {
        await walk(itemPath, relativeItemPath);
      } else {
        files.push({
          name: relativeItemPath,
          size: stat.size,
          path: itemPath,
        });
      }
    }
  };

  await walk(outputPath);

  // Sort by size
  const largestFiles = files
    .sort((a, b) => b.size - a.size)
    .map((f) => ({ name: f.name, size: f.size }));

  // Generate recommendations
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const largeMBFiles = files.filter((f) => f.size > 1024 * 1024); // > 1MB

  if (totalSize > 10 * 1024 * 1024) {
    // > 10MB
    recommendations.push("Consider code splitting to reduce bundle size");
  }

  if (largeMBFiles.length > 0) {
    recommendations.push(
      "Some files are quite large - consider compression or optimization"
    );
  }

  const jsFiles = files.filter((f) => f.name.endsWith(".js"));
  const hasSourceMaps = files.some((f) => f.name.endsWith(".map"));

  if (jsFiles.length > 0 && !hasSourceMaps) {
    recommendations.push("Enable source maps for better debugging");
  }

  return { largestFiles, recommendations };
}

async function reportBuildStatus(
  projectConfig: ProjectConfig,
  options: BuildOptions,
  status: "success" | "failed",
  error?: any
): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!currentConfig.token) {
      return; // Not authenticated, skip reporting
    }

    const api = new CirronApi(currentConfig);

    const buildReport: any = {
      projectName: projectConfig.name,
      environment: options.env,
      status,
      timestamp: new Date().toISOString(),
      error: error ? error.message : undefined,
      forceUsed: options.force,
      metadata: {
        buildFlags: {
          force: options.force,
          validate: options.validate,
          clean: options.clean,
          analyze: options.analyze,
        },
      },
    };

    await api.reportBuild(buildReport);
  } catch (apiError) {
    // Don't fail the build if API reporting fails
    logger.debug("Failed to report build status to API:", apiError);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 Bytes";
  }

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

// ML-specific build functions
async function determineArchitectureFromHardware(
  projectConfig: ProjectConfig
): Promise<string> {
  // First check if hardware configuration exists in project
  if (projectConfig.hardware) {
    const hardwareType = projectConfig.hardware.type;

    // Map hardware type to architecture based on framework
    if (projectConfig.framework === "pytorch") {
      return hardwareType === "cuda"
        ? "cuda"
        : hardwareType === "gpu"
          ? "cuda"
          : "cpu";
    }
    if (projectConfig.framework === "tensorflow") {
      return hardwareType === "cuda" || hardwareType === "gpu" ? "gpu" : "cpu";
    }
    return "cpu"; // sklearn and custom default to CPU
  }

  // Fallback to legacy logic
  return await determineDefaultArchitecture(projectConfig);
}

async function determineDefaultArchitecture(
  projectConfig: ProjectConfig
): Promise<string> {
  if (projectConfig.framework === "pytorch") {
    return projectConfig.gpuRequired ? "cuda" : "cpu";
  }
  if (projectConfig.framework === "tensorflow") {
    return projectConfig.gpuRequired ? "gpu" : "cpu";
  }
  if (projectConfig.framework === "sklearn") {
    return "cpu";
  }
  return "cpu";
}

async function validateHardwareCompatibility(
  hardwareConfig: HardwareConfig,
  targetArch: string,
  framework?: string
): Promise<void> {
  const validationErrors: string[] = [];

  // Validate hardware configuration
  const validation = HardwareDetector.validateHardwareConfig(hardwareConfig);
  if (!validation.valid) {
    validationErrors.push(...validation.errors);
  }

  // Check architecture compatibility
  if (targetArch === "cuda" && hardwareConfig.type !== "cuda") {
    validationErrors.push(
      "CUDA architecture selected but hardware configuration is not CUDA-capable"
    );
  }

  if (targetArch === "gpu" && hardwareConfig.type === "cpu") {
    validationErrors.push(
      "GPU architecture selected but hardware configuration is CPU-only"
    );
  }

  // Framework-specific validation
  if (framework) {
    const frameworkCompatible =
      hardwareConfig.compatibility[
        framework as keyof typeof hardwareConfig.compatibility
      ];
    if (typeof frameworkCompatible === "boolean" && !frameworkCompatible) {
      validationErrors.push(
        `Hardware not compatible with ${framework} framework`
      );
    }
  }

  // Check for compatibility warnings
  if (
    hardwareConfig.compatibility.warnings &&
    hardwareConfig.compatibility.warnings.length > 0
  ) {
    hardwareConfig.compatibility.warnings.forEach((warning) => {
      logger.warn(`Hardware warning: ${warning}`);
    });
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Hardware compatibility validation failed:\n${validationErrors.map((err) => `  • ${err}`).join("\n")}`
    );
  }
}

async function loadIndexFile(indexPath: string): Promise<any> {
  try {
    const ext = path.extname(indexPath).toLowerCase();

    if (ext === ".json") {
      return await fs.readJSON(indexPath);
    }
    if (ext === ".yaml" || ext === ".yml") {
      const yaml = require("yaml");
      const content = await fs.readFile(indexPath, "utf8");
      return yaml.parse(content);
    }
    throw new Error(`Unsupported index file format: ${ext}. Use JSON or YAML.`);
  } catch (error) {
    throw new Error(`Failed to load index file: ${error}`);
  }
}

async function runValidationChecks(
  projectConfig: ProjectConfig,
  indexConfig: any,
  architecture: string,
  options: BuildOptions
): Promise<void> {
  const validationErrors: string[] = [];

  const requiredFiles = ["src/model.py", "requirements.txt"];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      validationErrors.push(`Required file missing: ${file}`);
    }
  }

  try {
    const pythonVersion = execSync("python3 --version", {
      encoding: "utf8",
    }).trim();
    const versionMatch = pythonVersion.match(/Python (\d+\.\d+\.\d+)/);

    if (versionMatch && versionMatch[1]) {
      const versionParts = versionMatch[1].split(".");
      const major = Number.parseInt(versionParts[0] || "0", 10);
      const minor = Number.parseInt(versionParts[1] || "0", 10);
      const requiredParts = (projectConfig.pythonVersion || "3.9").split(".");
      const requiredMajor = Number.parseInt(requiredParts[0] || "3", 10);
      const requiredMinor = Number.parseInt(requiredParts[1] || "9", 10);

      if (
        major < requiredMajor ||
        (major === requiredMajor && minor < requiredMinor)
      ) {
        validationErrors.push(
          `Python ${projectConfig.pythonVersion || "3.9"}+ required, found ${major}.${minor}`
        );
      }
    }
  } catch {
    validationErrors.push("Python3 not available");
  }

  if (
    (architecture === "cuda" || architecture === "gpu") &&
    projectConfig.framework === "pytorch"
  ) {
    try {
      const testScript = "import torch; assert torch.cuda.is_available()";
      const result = await executePythonScript(testScript);
      if (!result.success) {
        validationErrors.push("CUDA not available for PyTorch");
        if (
          result.parsedErrors &&
          result.parsedErrors.length > 0 &&
          result.parsedErrors[0]
        ) {
          logger.debug(
            "CUDA validation details:",
            result.parsedErrors[0].message
          );
        }
      }
    } catch {
      validationErrors.push("CUDA not available for PyTorch");
    }
  }

  if (
    indexConfig &&
    !(indexConfig.features && Array.isArray(indexConfig.features))
  ) {
    validationErrors.push("Index file missing or invalid features array");
  }

  try {
    const testScript =
      'import sys; sys.path.append("src"); from model import create_model; create_model()';
    const result = await executePythonScript(testScript);
    if (!result.success) {
      validationErrors.push("Model creation failed during validation");
      if (result.parsedErrors && result.parsedErrors.length > 0) {
        const firstError = result.parsedErrors[0];
        if (firstError) {
          logger.debug("Model validation error:", firstError.message);
          if (firstError.file && firstError.line) {
            logger.debug(
              `Error location: ${firstError.file}:${firstError.line}`
            );
          }
        }
      }
    }
  } catch {
    validationErrors.push("Model creation failed during validation");
  }

  // Categorize validation errors
  const { critical, nonCritical } =
    categorizeValidationErrors(validationErrors);

  // Check for metadata mismatches
  const metadataMismatches = await checkMetadataMismatches(projectConfig);

  // Always fail on critical errors
  if (critical.length > 0) {
    throw new Error(
      `Critical validation errors:\n${critical.map((err) => `  • ${err}`).join("\n")}`
    );
  }

  // Handle non-critical errors based on force flag
  if (nonCritical.length > 0 || metadataMismatches.length > 0) {
    if (options.force) {
      // Force mode: show warnings and continue
      displayForceWarnings(nonCritical, metadataMismatches, options);
    } else {
      // Show message about force option for metadata mismatches
      if (metadataMismatches.length > 0) {
        console.log();
        console.log(
          chalk.yellow(
            "Metadata mismatch detected. Use --force to continue or run:"
          )
        );
        console.log(chalk.cyan("cirron info --update metadata"));
        console.log();
      }

      const allErrors = [...nonCritical];
      if (metadataMismatches.length > 0) {
        allErrors.push(...metadataMismatches.map((m) => m.description));
      }

      throw new Error(
        `Validation failed:\n${allErrors.map((err) => `  • ${err}`).join("\n")}\n\nUse --force to proceed despite these warnings.`
      );
    }
  }
}

async function performMLBuild(
  projectConfig: ProjectConfig,
  architecture: string,
  _indexConfig: any
): Promise<string[]> {
  const artifacts: string[] = [];

  const outputDirs = ["models", "artifacts", "build"];
  for (const dir of outputDirs) {
    await fs.ensureDir(dir);
  }

  const compilationScript = generateMLBuildScript(
    projectConfig,
    architecture,
    _indexConfig
  );
  const scriptPath = "temp_build.py";

  try {
    await fs.writeFile(scriptPath, compilationScript);

    logger.info("Executing ML model build...");
    const result = execSync(`python3 ${scriptPath}`, {
      encoding: "utf8",
      timeout: 300_000,
    });

    logger.info("Build output:", result);

    const artifactDirs = ["models", "artifacts"];
    for (const dir of artifactDirs) {
      if (fs.existsSync(dir)) {
        const files = await fs.readdir(dir);
        artifacts.push(...files.map((f) => path.join(dir, f)));
      }
    }
  } finally {
    if (fs.existsSync(scriptPath)) {
      await fs.remove(scriptPath);
    }
  }

  return artifacts;
}

function generateMLBuildScript(
  projectConfig: ProjectConfig,
  architecture: string,
  _indexConfig: any
): string {
  const framework = projectConfig.framework || "custom";

  let script = `
import sys
import os
import json
sys.path.append('src')

print("Starting ML build for ${framework} framework...")
print("Target architecture: ${architecture}")

from model import create_model
model = create_model()
print("Model created successfully")
`;

  if (framework === "pytorch") {
    script += `
import torch

if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model moved to CUDA")
    else:
        print("Warning: CUDA not available, using CPU")

os.makedirs('models', exist_ok=True)
torch.save(model.state_dict(), 'models/model_${architecture}.pth')
print("Model saved to models/model_${architecture}.pth")
`;
  } else if (framework === "sklearn") {
    script += `
import joblib

os.makedirs('models', exist_ok=True)
joblib.dump(model, 'models/model_${architecture}.joblib')
print("Model saved to models/model_${architecture}.joblib")
`;
  }

  script += `
model_info = {
    "framework": "${framework}",
    "architecture": "${architecture}",
    "build_time": "$(date)"
}
os.makedirs('artifacts', exist_ok=True)
with open('artifacts/build_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)

print("ML build completed successfully")
`;

  return script;
}

async function runIntegrityTests(
  projectConfig: ProjectConfig,
  artifacts: string[]
): Promise<void> {
  const framework = projectConfig.framework || "custom";

  const testScript = `
import sys
import os
sys.path.append('src')

print("Running build integrity tests...")

required_files = ${JSON.stringify(artifacts)}
for file_path in required_files:
    if not os.path.exists(file_path):
        raise Exception(f"Artifact missing: {file_path}")
print("✓ All artifacts present")

if "${framework}" == "pytorch":
    import torch
    from model import create_model
    
    model = create_model()
    for artifact in required_files:
        if artifact.endswith('.pth'):
            model.load_state_dict(torch.load(artifact, map_location='cpu'))
            print("✓ PyTorch model loaded successfully")
            break
            
elif "${framework}" == "sklearn":
    import joblib
    
    for artifact in required_files:
        if artifact.endswith('.joblib'):
            model = joblib.load(artifact)
            print("✓ Scikit-learn model loaded successfully")
            break

print("Integrity tests completed successfully")
`;

  const tempScriptPath = "temp_integrity_test.py";

  try {
    await fs.writeFile(tempScriptPath, testScript);
    const result = await executePythonScript(testScript, {
      cwd: process.cwd(),
    });
    if (!result.success) {
      throw new Error(
        `Architecture test failed: ${formatExecutionError(result)}`
      );
    }
  } finally {
    if (fs.existsSync(tempScriptPath)) {
      await fs.remove(tempScriptPath);
    }
  }
}

async function createDockerIgnoreFromCirronIgnore(): Promise<string | null> {
  const cirronIgnorePath = path.join(process.cwd(), ".cirronignore");
  const dockerIgnorePath = path.join(process.cwd(), ".dockerignore");
  const tempDockerIgnorePath = path.join(
    process.cwd(),
    ".dockerignore.cirron-temp"
  );

  // Check if .cirronignore exists
  if (!fs.existsSync(cirronIgnorePath)) {
    return null;
  }

  try {
    // Load .cirronignore patterns
    const cirronIgnore = new CirronIgnore();
    const patterns = cirronIgnore.getPatterns();

    // Read existing .dockerignore if it exists
    let existingDockerIgnore = "";
    if (fs.existsSync(dockerIgnorePath)) {
      existingDockerIgnore = await fs.readFile(dockerIgnorePath, "utf8");
    }

    // Combine patterns
    const combinedContent = [
      "# Existing .dockerignore content",
      existingDockerIgnore.trim(),
      "",
      "# Added from .cirronignore",
      ...patterns.map((pattern) => {
        // Convert some common .cirronignore patterns to .dockerignore format
        if (pattern.endsWith("/**")) {
          return `${pattern.slice(0, -3)}/`;
        }
        return pattern;
      }),
    ]
      .filter((line) => line !== "")
      .join("\n");

    // Write temporary .dockerignore
    await fs.writeFile(tempDockerIgnorePath, combinedContent);

    // Replace original .dockerignore temporarily
    if (fs.existsSync(dockerIgnorePath)) {
      await fs.move(dockerIgnorePath, `${dockerIgnorePath}.backup`);
    }
    await fs.move(tempDockerIgnorePath, dockerIgnorePath);

    logger.debug("Created temporary .dockerignore with .cirronignore patterns");
    return `${dockerIgnorePath}.backup`;
  } catch (error) {
    logger.debug("Failed to create temporary .dockerignore:", error);
    // Clean up any partial files
    if (fs.existsSync(tempDockerIgnorePath)) {
      await fs.remove(tempDockerIgnorePath);
    }
    return null;
  }
}

async function cleanupDockerIgnore(backupPath: string): Promise<void> {
  const dockerIgnorePath = path.join(process.cwd(), ".dockerignore");

  try {
    // Remove temporary .dockerignore
    if (fs.existsSync(dockerIgnorePath)) {
      await fs.remove(dockerIgnorePath);
    }

    // Restore original .dockerignore if it existed
    if (fs.existsSync(backupPath)) {
      await fs.move(backupPath, dockerIgnorePath);
    }
  } catch (error) {
    logger.debug("Failed to cleanup .dockerignore:", error);
  }
}
