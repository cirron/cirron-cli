import { execSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type { ProjectConfig } from "../types";
import {
  determineArchitectureFromHardware,
  loadIndexFile,
  validateHardwareCompatibility,
} from "../utils/architecture";
import { CLIError, CLIErrorCode, handleCLIError } from "../utils/errors";
import { executePythonScript, formatExecutionError } from "../utils/execution";
import { createInteractiveManager } from "../utils/interactive";
import { logger } from "../utils/logger";
import { ModelConfigManager } from "../utils/model-config";
import { loadProjectConfig } from "../utils/project-config";
import {
  checkCudaPytorch,
  checkIndexConfig,
  checkModelCreation,
  checkPythonVersion,
  checkRequiredFiles,
  checkTensorflowGpu,
} from "../utils/validation";

interface CompileOptions {
  arch?: string;
  index?: string;
  interactive?: boolean;
  strict?: boolean;
  validate?: boolean;
  verbose?: boolean;
}

export async function compileCommand(options: CompileOptions): Promise<void> {
  const spinner = ora("Preparing compilation...").start();
  const strictMode = options.strict ?? false;
  const interactive = createInteractiveManager(options.interactive ?? false);

  try {
    // Load project configuration
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(
        chalk.red("No cirron config found (cirron.yaml or cirron.json)")
      );
      if (strictMode) {
        handleCLIError(new Error("Project configuration not found"), true);
      }
      logger.error(`Run ${chalk.cyan("cirron init")} to initialize a project`);
      process.exit(CLIErrorCode.PROJECT_NOT_FOUND);
    }

    const { config: projectConfig } = projectConfigResult;

    // Load model configuration
    const modelConfigManager = new ModelConfigManager();
    const modelConfig = await modelConfigManager.loadModelConfig();

    if (modelConfig) {
      logger.info(
        chalk.blue(
          `Using model configuration: ${modelConfig.name || "unnamed model"}`
        )
      );
      if (
        modelConfig.framework &&
        modelConfig.framework !== projectConfig.framework
      ) {
        logger.warn(
          chalk.yellow(
            `Framework mismatch: model.yaml (${modelConfig.framework}) vs project config (${projectConfig.framework})`
          )
        );
      }
    }

    // Interactive confirmation for compilation start
    if (interactive.isInteractive()) {
      spinner.stop();
      const shouldProceed = await interactive.confirmStep({
        stepName: "Model Compilation",
        description: `Compile ${projectConfig.framework || "custom"} model with optimization`,
        impact: "medium",
        estimatedTime: "1-3 minutes",
        dependencies: [
          "Model source files",
          "Python environment",
          "Framework libraries",
        ],
      });

      if (!shouldProceed) {
        logger.info("Compilation cancelled by user");
        return;
      }
      spinner.start();
    }

    // Determine architecture from options, model config, or hardware detection
    let architecture =
      options.arch ||
      modelConfig?.inference?.device ||
      (await determineArchitectureFromHardware(projectConfig));

    // Interactive architecture confirmation
    if (interactive.isInteractive() && !options.arch) {
      spinner.stop();
      const confirmedArch = await interactive.selectOption({
        message: "Select target architecture for compilation",
        type: "select",
        choices: [
          { name: `${architecture} (detected/default)`, value: architecture },
          { name: "cpu (CPU optimized)", value: "cpu" },
          { name: "cuda (NVIDIA GPU)", value: "cuda" },
          { name: "gpu (General GPU)", value: "gpu" },
        ],
        description:
          "Architecture affects model optimization and runtime performance",
      });

      if (confirmedArch !== architecture) {
        logger.info(
          `Architecture changed from ${architecture} to ${confirmedArch}`
        );
        architecture = confirmedArch;
      }
      spinner.start();
    }

    spinner.text = `Compiling for architecture: ${architecture}`;
    logger.info(`Target architecture: ${chalk.cyan(architecture)}`);

    // Load index/manifest file if specified
    let indexConfig: any = null;
    if (options.index) {
      if (!fs.existsSync(options.index)) {
        spinner.fail(chalk.red(`Index file not found: ${options.index}`));
        process.exit(1);
      }
      indexConfig = await loadIndexFile(options.index);
      logger.info(`Using index file: ${chalk.cyan(options.index)}`);
    }

    // Pre-compilation validation
    if (options.validate) {
      if (interactive.isInteractive()) {
        spinner.stop();
        const shouldValidate = await interactive.confirmStep({
          stepName: "Pre-compilation Validation",
          description:
            "Verify model files, dependencies, and environment setup",
          impact: "low",
          estimatedTime: "30-60 seconds",
          dependencies: [
            "Model files",
            "Python environment",
            "Framework libraries",
          ],
        });

        if (shouldValidate) {
          spinner.start();
          spinner.text = "Running validation checks...";
          await runValidationChecks(
            projectConfig,
            indexConfig,
            architecture,
            strictMode
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
          strictMode
        );
        logger.success("✓ Validation checks passed");
      }
    }

    // Validate hardware compatibility if hardware config exists
    if (projectConfig.hardware) {
      spinner.text = "Validating hardware compatibility...";
      await validateHardwareCompatibility(
        projectConfig.hardware,
        architecture,
        projectConfig.framework
      );
      logger.success("✓ Hardware compatibility validated");
    }

    // Actual compilation
    if (interactive.isInteractive()) {
      spinner.stop();
      const shouldCompile = await interactive.confirmStep({
        stepName: "Model Compilation",
        description: `Generate optimized model artifacts for ${architecture} architecture`,
        impact: "medium",
        estimatedTime: "1-3 minutes",
        dependencies: [
          "Validated model files",
          "Target architecture",
          "Framework",
        ],
      });

      if (!shouldCompile) {
        logger.warn("Compilation skipped by user");
        return;
      }
      spinner.start();
    }

    spinner.text = "Compiling model...";
    const artifacts = await performCompilation(
      projectConfig,
      architecture,
      indexConfig
    );

    // Post-compilation tests
    if (interactive.isInteractive()) {
      spinner.stop();
      const shouldTest = await interactive.confirmStep({
        stepName: "Integrity Tests",
        description: "Verify compiled artifacts can be loaded and used",
        impact: "low",
        estimatedTime: "15-30 seconds",
        dependencies: ["Compiled artifacts", "Framework libraries"],
      });

      if (shouldTest) {
        spinner.start();
        spinner.text = "Running integrity tests...";
        await runIntegrityTests(projectConfig, artifacts);
      } else {
        logger.warn("Skipping integrity tests");
      }
    } else {
      spinner.text = "Running integrity tests...";
      await runIntegrityTests(projectConfig, artifacts);
    }

    spinner.succeed(chalk.green("Compilation completed successfully"));

    // Display results
    logger.info("\n Compilation Results:");
    logger.info(`  • Architecture: ${chalk.cyan(architecture)}`);
    logger.info(
      `  • Artifacts: ${chalk.cyan(artifacts.length)} files generated`
    );
    for (const artifact of artifacts) {
      logger.info(`    - ${chalk.gray(artifact)}`);
    }

    logger.success("Model compilation completed successfully!");
  } catch (error) {
    spinner.fail(chalk.red("Compilation failed"));

    // Handle CLI errors with proper exit codes
    if (error instanceof CLIError) {
      handleCLIError(error, strictMode, options.verbose);
    } else {
      // Handle generic errors
      const errorDetails: any = {
        code: CLIErrorCode.COMPILE_FAILED,
        message: error instanceof Error ? error.message : String(error),
        suggestions: [
          "Check compilation logs for specific errors",
          "Verify project configuration and dependencies",
          "Try running with --validate flag first",
        ],
        recoverable: true,
      };

      if (error instanceof Error) {
        errorDetails.cause = error;
      }

      const compileError = new CLIError(errorDetails);

      handleCLIError(compileError, strictMode, options.verbose);
    }
  }
}

async function runValidationChecks(
  projectConfig: ProjectConfig,
  indexConfig: any,
  architecture: string,
  strictMode: boolean
): Promise<void> {
  const validationErrors: string[] = [
    ...checkRequiredFiles(),
    ...checkPythonVersion(projectConfig.pythonVersion),
  ];

  // Architecture-specific validation
  if (architecture === "cuda" || architecture === "gpu") {
    if (!projectConfig.gpuRequired) {
      logger.warn("GPU architecture selected but project does not require GPU");
    }

    if (projectConfig.framework === "pytorch") {
      validationErrors.push(
        ...(await checkCudaPytorch({
          strictMode,
          handleResult: true,
          debugLog: true,
        }))
      );
    }

    if (projectConfig.framework === "tensorflow") {
      validationErrors.push(
        ...(await checkTensorflowGpu({
          strictMode,
          handleResult: true,
          debugLog: true,
        }))
      );
    }
  }

  validationErrors.push(
    ...checkIndexConfig(indexConfig, { requireDataTypes: true })
  );

  validationErrors.push(
    ...(await checkModelCreation({
      script: `
import sys
sys.path.append('src')
from model import create_model

# Test model creation
model = create_model()
print('Model validation passed')
`,
      strictMode,
      baseErrorCode: CLIErrorCode.MODEL_CREATION_FAILED,
      handleResult: true,
      debugLog: true,
    }))
  );

  if (validationErrors.length > 0) {
    const validationError = new CLIError({
      code: CLIErrorCode.VALIDATION_FAILED,
      message: "Validation checks failed",
      details: { errors: validationErrors },
      suggestions: ["Fix validation errors and retry"],
      recoverable: true,
    });

    if (strictMode) {
      handleCLIError(validationError, strictMode);
    }

    throw new Error(
      `Validation failed:\n${validationErrors.map((err) => `  • ${err}`).join("\n")}`
    );
  }
}

async function performCompilation(
  projectConfig: ProjectConfig,
  architecture: string,
  indexConfig: any
): Promise<string[]> {
  const artifacts: string[] = [];

  // Ensure output directories exist
  const outputDirs = ["models", "artifacts", "build"];
  for (const dir of outputDirs) {
    await fs.ensureDir(dir);
  }

  // Create compilation script based on framework
  const compilationScript = generateCompilationScript(
    projectConfig,
    architecture,
    indexConfig
  );
  const scriptPath = "temp_compile.py";

  try {
    await fs.writeFile(scriptPath, compilationScript);

    // Run compilation
    logger.info("Executing model compilation...");
    const result = execSync(`python3 ${scriptPath}`, {
      encoding: "utf8",
      timeout: 300_000, // 5 minute timeout
    });

    logger.info("Compilation output:", result);

    // Collect generated artifacts
    const artifactDirs = ["models", "artifacts"];
    for (const dir of artifactDirs) {
      if (fs.existsSync(dir)) {
        const files = await fs.readdir(dir);
        artifacts.push(...files.map((f) => path.join(dir, f)));
      }
    }
  } finally {
    // Clean up temporary script
    if (fs.existsSync(scriptPath)) {
      await fs.remove(scriptPath);
    }
  }

  return artifacts;
}

function generateCompilationScript(
  projectConfig: ProjectConfig,
  architecture: string,
  indexConfig: any
): string {
  const framework = projectConfig.framework || "custom";

  let script = `
import sys
import os
import json
sys.path.append('src')

print("Starting compilation for ${framework} framework...")
print("Target architecture: ${architecture}")
`;

  // Framework-specific compilation logic
  if (framework === "pytorch") {
    script += `
from model import create_model
import torch

# Create model
model = create_model()
print("Model created successfully")

# Optimize for architecture
if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model moved to CUDA")
    else:
        print("Warning: CUDA not available, using CPU")

# Save compiled model
os.makedirs('models', exist_ok=True)
torch.save(model.state_dict(), 'models/model_${architecture}.pth')
print("Model saved to models/model_${architecture}.pth")

# Save model info
model_info = {
    "framework": "pytorch",
    "architecture": "${architecture}",
    "parameters": sum(p.numel() for p in model.parameters()),
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else if (framework === "tensorflow") {
    script += `
from model import create_model
import tensorflow as tf

# Create model
model = create_model()
print("Model created successfully")

# Architecture-specific optimization
if "${architecture}" == "gpu":
    with tf.device('/GPU:0'):
        print("Using GPU for compilation")
else:
    with tf.device('/CPU:0'):
        print("Using CPU for compilation")

# Save compiled model
os.makedirs('models', exist_ok=True)
model.save('models/model_${architecture}')
print("Model saved to models/model_${architecture}")

# Save model info
model_info = {
    "framework": "tensorflow",
    "architecture": "${architecture}",
    "parameters": model.count_params(),
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else if (framework === "sklearn") {
    script += `
from model import create_model
import joblib

# Create model
model = create_model()
print("Model created successfully")

# Save model
os.makedirs('models', exist_ok=True)
joblib.dump(model, 'models/model_${architecture}.joblib')
print("Model saved to models/model_${architecture}.joblib")

# Save model info
model_info = {
    "framework": "sklearn",
    "architecture": "${architecture}",
    "model_type": type(model).__name__,
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else {
    script += `
from model import create_model

# Create model
model = create_model()
print("Model created successfully")

# Generic model info
model_info = {
    "framework": "custom",
    "architecture": "${architecture}",
    "compilation_time": "$(date)"
}
os.makedirs('artifacts', exist_ok=True)
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  }

  // Add index configuration handling if provided
  if (indexConfig) {
    script += `
# Save index configuration
index_config = ${JSON.stringify(indexConfig)}
with open('artifacts/index_config.json', 'w') as f:
    json.dump(index_config, f, indent=2)
print("Index configuration saved")
`;
  }

  script += `
print("Compilation completed successfully")
`;

  return script;
}

async function runIntegrityTests(
  projectConfig: ProjectConfig,
  artifacts: string[]
): Promise<void> {
  // Test model loading and basic functionality
  const framework = projectConfig.framework || "custom";

  const testScript = `
import sys
import os
sys.path.append('src')

print("Running integrity tests...")

# Test model files exist
required_files = ${JSON.stringify(artifacts)}
for file_path in required_files:
    if not os.path.exists(file_path):
        raise Exception(f"Artifact missing: {file_path}")
print("✓ All artifacts present")

# Test model loading based on framework
if "${framework}" == "pytorch":
    import torch
    from model import create_model
    
    model = create_model()
    
    # Try loading compiled model
    for artifact in required_files:
        if artifact.endswith('.pth'):
            model.load_state_dict(torch.load(artifact, map_location='cpu'))
            print("✓ PyTorch model loaded successfully")
            break
            
elif "${framework}" == "tensorflow":
    import tensorflow as tf
    
    # Try loading compiled model
    for artifact in required_files:
        if 'model_' in artifact and not artifact.endswith('.json'):
            model = tf.keras.models.load_model(artifact)
            print("✓ TensorFlow model loaded successfully")
            break
            
elif "${framework}" == "sklearn":
    import joblib
    
    # Try loading compiled model
    for artifact in required_files:
        if artifact.endswith('.joblib'):
            model = joblib.load(artifact)
            print("✓ Scikit-learn model loaded successfully")
            break

# Test basic data processing if sample data exists
if os.path.exists('data/sample'):
    print("✓ Sample data directory found")
    import pandas as pd
    sample_files = [f for f in os.listdir('data/sample') if f.endswith('.csv')]
    if sample_files:
        data = pd.read_csv(f'data/sample/{sample_files[0]}')
        if len(data) > 0:
            print("✓ Sample data can be loaded")
        else:
            print("⚠ Sample data is empty")

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
        `Compilation test failed: ${formatExecutionError(result)}`
      );
    }
  } finally {
    if (fs.existsSync(tempScriptPath)) {
      await fs.remove(tempScriptPath);
    }
  }
}
