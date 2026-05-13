import { execSync } from "node:child_process";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type { ProjectConfig, ReplayOptions } from "../types";
import { executePythonScript } from "../utils/execution";
import { logger } from "../utils/logger";
import { PlanStorage } from "../utils/plan-storage";
import { loadProjectConfig } from "../utils/project-config";

export async function replayCommand(options: ReplayOptions): Promise<void> {
  const spinner = ora("Loading plan for replay...").start();

  try {
    // Load the plan
    const savedPlan = await PlanStorage.loadPlan(options.plan);

    // Validate the plan
    const validation = PlanStorage.validatePlan(savedPlan);
    if (!validation.valid) {
      spinner.fail(chalk.red("Invalid plan file"));
      for (const error of validation.errors) {
        logger.error(`  • ${error}`);
      }
      process.exit(1);
    }

    const plan = savedPlan.plan;

    spinner.text = `Replaying ${plan.command} plan from ${new Date(plan.timestamp).toLocaleString()}`;

    // Load current project configuration for comparison
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(
        chalk.red(
          "No cirron config found (cirron.yaml or cirron.json) in current directory"
        )
      );
      logger.error("Navigate to a Cirron project directory to replay plans");
      process.exit(1);
    }

    const currentConfig: ProjectConfig = projectConfigResult.config;

    // Validate environment compatibility
    if (options.validate !== false) {
      spinner.text = "Validating environment compatibility...";
      await validateEnvironmentCompatibility(plan, currentConfig, options);
      logger.success("✓ Environment compatibility validated");
    }

    if (options.dryRun) {
      spinner.succeed(chalk.green("Dry run completed - plan is compatible"));
      displayReplayPlan(plan, savedPlan.metadata, options);
      return;
    }

    // Execute the replay based on command type
    spinner.text = `Executing ${plan.command} replay...`;

    if (plan.command === "compile") {
      await replayCompile(plan, currentConfig, options);
    } else if (plan.command === "build") {
      await replayBuild(plan, currentConfig, options);
    } else {
      throw new Error(`Unsupported plan command for replay: ${plan.command}`);
    }

    spinner.succeed(
      chalk.green(`${plan.command} replay completed successfully`)
    );

    // Display results
    logger.info("\n Replay Results:");
    logger.info(`  • Command: ${chalk.cyan(plan.command)}`);
    logger.info(`  • Framework: ${chalk.cyan(plan.framework)}`);
    logger.info(`  • Architecture: ${chalk.cyan(plan.architecture)}`);
    logger.info(
      `  • Original plan: ${chalk.gray(new Date(plan.timestamp).toLocaleString())}`
    );
  } catch (error) {
    spinner.fail(chalk.red("Replay failed"));

    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error("Unknown replay error occurred");
    }

    process.exit(1);
  }
}

async function validateEnvironmentCompatibility(
  plan: any,
  currentConfig: ProjectConfig,
  options: ReplayOptions
): Promise<void> {
  const issues: string[] = [];

  // Check framework compatibility
  if (plan.framework !== currentConfig.framework) {
    if (options.force) {
      logger.warn(
        `Framework mismatch: plan uses ${plan.framework}, current project uses ${currentConfig.framework}`
      );
    } else {
      issues.push(
        `Framework mismatch: plan uses ${plan.framework}, current project uses ${currentConfig.framework}`
      );
    }
  }

  // Check Python version
  const currentPythonVersion = currentConfig.pythonVersion || "3.9";
  if (plan.pythonVersion && plan.pythonVersion !== currentPythonVersion) {
    if (options.force) {
      logger.warn(
        `Python version mismatch: plan uses ${plan.pythonVersion}, current project uses ${currentPythonVersion}`
      );
    } else {
      issues.push(
        `Python version mismatch: plan uses ${plan.pythonVersion}, current project uses ${currentPythonVersion}`
      );
    }
  }

  // Check required files
  const requiredFiles = ["src/model.py", "requirements.txt"];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      issues.push(`Required file missing: ${file}`);
    }
  }

  // Check GPU requirements for GPU architectures
  if (plan.architecture === "cuda" || plan.architecture === "gpu") {
    if (plan.framework === "pytorch") {
      try {
        const testScript = "import torch; assert torch.cuda.is_available()";
        const result = await executePythonScript(testScript);
        if (!result.success) {
          if (options.force) {
            logger.warn("CUDA not available - replay may fail");
          } else {
            issues.push("CUDA not available for PyTorch (plan requires GPU)");
          }
        }
      } catch {
        if (options.force) {
          logger.warn("Could not verify CUDA availability");
        } else {
          issues.push("Could not verify CUDA availability (plan requires GPU)");
        }
      }
    }

    if (plan.framework === "tensorflow") {
      try {
        const testScript =
          'import tensorflow as tf; assert len(tf.config.list_physical_devices("GPU")) > 0';
        const result = await executePythonScript(testScript);
        if (!result.success) {
          if (options.force) {
            logger.warn("GPU not available for TensorFlow - replay may fail");
          } else {
            issues.push("GPU not available for TensorFlow (plan requires GPU)");
          }
        }
      } catch {
        if (options.force) {
          logger.warn("Could not verify GPU availability for TensorFlow");
        } else {
          issues.push(
            "Could not verify GPU availability for TensorFlow (plan requires GPU)"
          );
        }
      }
    }
  }

  if (issues.length > 0 && !options.force) {
    throw new Error(
      `Environment compatibility issues:\n${issues.map((issue) => `  • ${issue}`).join("\n")}\n\nUse --force to proceed anyway.`
    );
  }
}

async function replayCompile(
  plan: any,
  currentConfig: ProjectConfig,
  options: ReplayOptions
): Promise<void> {
  // Generate compilation script based on the plan
  const compilationScript = generateReplayCompilationScript(
    plan,
    currentConfig
  );
  const scriptPath = "temp_replay_compile.py";

  try {
    await fs.writeFile(scriptPath, compilationScript);

    logger.info("Executing compilation replay...");
    if (options.verbose) {
      logger.info(`Using architecture: ${plan.architecture}`);
      logger.info(`Target framework: ${plan.framework}`);
    }

    const result = execSync(`python3 ${scriptPath}`, {
      encoding: "utf8",
      timeout: 300_000, // 5 minute timeout
      stdio: options.verbose ? "inherit" : "pipe",
    });

    if (options.verbose) {
      logger.info("Compilation output:", result);
    }

    // Verify expected artifacts were created
    for (const artifact of plan.artifacts) {
      if (!fs.existsSync(artifact.path)) {
        logger.warn(`Expected artifact not found: ${artifact.path}`);
      }
    }
  } finally {
    // Clean up temporary script
    if (fs.existsSync(scriptPath)) {
      await fs.remove(scriptPath);
    }
  }
}

async function replayBuild(
  plan: any,
  currentConfig: ProjectConfig,
  options: ReplayOptions
): Promise<void> {
  // Generate build script based on the plan
  const buildScript = generateReplayBuildScript(plan, currentConfig);
  const scriptPath = "temp_replay_build.py";

  try {
    await fs.writeFile(scriptPath, buildScript);

    logger.info("Executing build replay...");
    if (options.verbose) {
      logger.info(`Using architecture: ${plan.architecture}`);
      logger.info(`Target framework: ${plan.framework}`);
    }

    const result = execSync(`python3 ${scriptPath}`, {
      encoding: "utf8",
      timeout: 300_000, // 5 minute timeout
      stdio: options.verbose ? "inherit" : "pipe",
    });

    if (options.verbose) {
      logger.info("Build output:", result);
    }

    // Verify expected artifacts were created
    for (const artifact of plan.artifacts) {
      if (!fs.existsSync(artifact.path)) {
        logger.warn(`Expected artifact not found: ${artifact.path}`);
      } else if (options.verbose) {
        const stat = await fs.stat(artifact.path);
        logger.info(`✓ Created: ${artifact.path} (${formatBytes(stat.size)})`);
      }
    }
  } finally {
    // Clean up temporary script
    if (fs.existsSync(scriptPath)) {
      await fs.remove(scriptPath);
    }
  }
}

function generateReplayCompilationScript(
  plan: any,
  _currentConfig: ProjectConfig
): string {
  const framework = plan.framework;
  const architecture = plan.architecture;

  let script = `
import sys
import os
import json
sys.path.append('src')

print("Starting compilation replay for ${framework} framework...")
print("Target architecture: ${architecture}")

from model import create_model
model = create_model()
print("Model created successfully")
`;

  // Framework-specific compilation logic
  if (framework === "pytorch") {
    script += `
import torch

# Architecture optimization
if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model moved to CUDA")
    else:
        print("Warning: CUDA not available, using CPU")

# Save model
os.makedirs('models', exist_ok=True)
torch.save(model.state_dict(), 'models/model_${architecture}.pth')
print("Model saved to models/model_${architecture}.pth")
`;
  } else if (framework === "tensorflow") {
    script += `
import tensorflow as tf

# Architecture optimization
if "${architecture}" == "gpu":
    with tf.device('/GPU:0'):
        print("Using GPU for compilation")
else:
    with tf.device('/CPU:0'):
        print("Using CPU for compilation")

# Save model
os.makedirs('models', exist_ok=True)
model.save('models/model_${architecture}')
print("Model saved to models/model_${architecture}")
`;
  } else if (framework === "sklearn") {
    script += `
import joblib

# Save model
os.makedirs('models', exist_ok=True)
joblib.dump(model, 'models/model_${architecture}.joblib')
print("Model saved to models/model_${architecture}.joblib")
`;
  }

  script += `
# Save compilation info
compilation_info = {
    "framework": "${framework}",
    "architecture": "${architecture}", 
    "replayed_from": "${plan.timestamp}",
    "replay_time": "$(date)"
}
os.makedirs('artifacts', exist_ok=True)
with open('artifacts/compilation_info.json', 'w') as f:
    json.dump(compilation_info, f, indent=2)

print("Compilation replay completed successfully")
`;

  return script;
}

function generateReplayBuildScript(
  plan: any,
  _currentConfig: ProjectConfig
): string {
  const framework = plan.framework;
  const architecture = plan.architecture;

  let script = `
import sys
import os
import json
sys.path.append('src')

print("Starting build replay for ${framework} framework...")
print("Target architecture: ${architecture}")

from model import create_model
model = create_model()
print("Model created successfully")
`;

  // Framework-specific build logic (similar to compilation but with build-specific steps)
  if (framework === "pytorch") {
    script += `
import torch

# Architecture optimization
if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model optimized for CUDA")
    else:
        print("Warning: CUDA not available, using CPU")

# Save model with build optimizations
os.makedirs('models', exist_ok=True)
torch.save({
    'model_state_dict': model.state_dict(),
    'architecture': "${architecture}",
    'framework': "${framework}"
}, 'models/model_${architecture}.pth')
print("Model saved to models/model_${architecture}.pth")
`;
  } else if (framework === "sklearn") {
    script += `
import joblib

# Save model
os.makedirs('models', exist_ok=True)
joblib.dump(model, 'models/model_${architecture}.joblib')
print("Model saved to models/model_${architecture}.joblib")
`;
  }

  script += `
# Save build info
build_info = {
    "framework": "${framework}",
    "architecture": "${architecture}",
    "replayed_from": "${plan.timestamp}",
    "replay_time": "$(date)",
    "command": "build"
}
os.makedirs('artifacts', exist_ok=True)
with open('artifacts/build_info.json', 'w') as f:
    json.dump(build_info, f, indent=2)

print("Build replay completed successfully")
`;

  return script;
}

function displayReplayPlan(
  plan: any,
  metadata: any,
  _options: ReplayOptions
): void {
  const useColors = process.stdout.isTTY;
  const colorize = (text: string, colorFn: (text: string) => string) =>
    useColors ? colorFn(text) : text;

  console.log(`\n${colorize(" Replay Plan:", chalk.bold.blue)}`);
  console.log(colorize(`  • Command: ${plan.command}`, chalk.cyan));
  console.log(colorize(`  • Framework: ${plan.framework}`, chalk.green));
  console.log(colorize(`  • Architecture: ${plan.architecture}`, chalk.yellow));
  console.log(
    colorize(
      `  • Original timestamp: ${new Date(plan.timestamp).toLocaleString()}`,
      chalk.gray
    )
  );
  console.log(
    colorize(
      `  • Plan saved: ${new Date(metadata.savedAt).toLocaleString()}`,
      chalk.gray
    )
  );

  if (metadata.description) {
    console.log(
      colorize(`  • Description: ${metadata.description}`, chalk.gray)
    );
  }

  console.log("");
  console.log(colorize(" Expected Artifacts:", chalk.bold.yellow));
  for (const artifact of plan.artifacts) {
    console.log(
      colorize(
        `  • ${artifact.path} (${formatBytes(artifact.estimatedSize)})`,
        chalk.cyan
      )
    );
  }

  console.log("");
  console.log(colorize(" Build Steps:", chalk.bold.green));
  for (let i = 0; i < plan.buildSteps.length; i++) {
    console.log(colorize(`  ${i + 1}. ${plan.buildSteps[i]}`, chalk.gray));
  }

  if (plan.warnings && plan.warnings.length > 0) {
    console.log("");
    console.log(colorize("Warnings:", chalk.bold.yellow));
    for (const warning of plan.warnings) {
      console.log(colorize(`  • ${warning}`, chalk.yellow));
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return "0 B";
  }

  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${Number.parseFloat((bytes / k ** i).toFixed(1))} ${sizes[i]}`;
}
