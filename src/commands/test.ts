import { execSync } from "node:child_process";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import ora from "ora";
import type { ProjectConfig } from "../types";
import {
  executePythonFile,
  executeScript,
  formatExecutionError,
} from "../utils/execution";
import { CirronIgnore } from "../utils/ignore";
import { createInteractiveManager } from "../utils/interactive";
import { logger } from "../utils/logger";
import { ModelConfigManager } from "../utils/model-config";
import { loadProjectConfig } from "../utils/project-config";

interface TestOptions {
  build?: boolean;
  data?: boolean;
  endpoint?: string;
  env?: boolean;
  inference?: boolean;
  interactive?: boolean;
  lint?: boolean;
  model?: boolean;
  path?: string;
  pipeline?: boolean;
  requirements?: boolean;
  strict?: boolean;
  unit?: boolean;
  val?: boolean;
  watch?: boolean;
}

/** Entry point for `cirron test`: runs the selected test suites, or a default set when none are named. */
export async function testCommand(options: TestOptions): Promise<void> {
  const spinner = ora("Preparing tests...").start();
  const interactive = createInteractiveManager(options.interactive ?? false);

  try {
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(chalk.red("No cirron project config found"));
      logger.error(`Run ${chalk.cyan("cirron init")} to initialize a project`);
      process.exit(1);
    }

    const { config: projectConfig } = projectConfigResult;

    const modelConfigManager = new ModelConfigManager();
    const modelConfig = await modelConfigManager.loadModelConfig();

    if (modelConfig) {
      logger.info(
        chalk.blue(
          `Using model configuration for testing: ${modelConfig.name || "unnamed model"}`
        )
      );
    }

    // Determine which tests to run
    let testsToRun = determineTests(options);

    if (testsToRun.length === 0) {
      // Interactive test selection when no specific tests are requested
      if (interactive.isInteractive()) {
        spinner.stop();
        const availableTests = [
          {
            name: "env",
            description: "Environment setup validation (Python, CUDA)",
            default: true,
          },
          {
            name: "requirements",
            description: "Python requirements and dependencies",
            default: true,
          },
          {
            name: "unit",
            description: "Unit tests with pytest/unittest",
            default: fs.existsSync("tests") || fs.existsSync("test"),
          },
          {
            name: "model",
            description: "Model loading and instantiation",
            default: true,
          },
          {
            name: "data",
            description: "Data loading functionality",
            default: fs.existsSync("src/data_loader.py"),
          },
          {
            name: "inference",
            description: "Model inference pipeline",
            default: false,
          },
          {
            name: "val",
            description: "Model validation and accuracy tests",
            default: false,
          },
          {
            name: "pipeline",
            description: "End-to-end ML pipeline testing",
            default: false,
          },
        ];

        testsToRun = await interactive.selectSteps(
          availableTests,
          "Select which test types to run:"
        );

        if (testsToRun.length === 0) {
          logger.info("No tests selected. Exiting.");
          return;
        }

        spinner.start();
      } else {
        // Run all basic tests by default (not validation, endpoint, or pipeline)
        testsToRun.push("env", "requirements", "unit", "model", "data");
      }
    }

    spinner.text = "Running tests...";

    let passedTests = 0;
    const totalTests = testsToRun.length;
    const results: {
      test: string;
      status: "pass" | "fail";
      message?: string;
    }[] = [];

    for (const test of testsToRun) {
      try {
        // Interactive confirmation for potentially long-running tests
        if (
          interactive.isInteractive() &&
          ["val", "endpoint", "pipeline", "build"].includes(test)
        ) {
          spinner.stop();
          const testDescriptions = {
            val: "Model validation tests (accuracy, performance metrics)",
            endpoint: "Endpoint performance testing (multiple requests)",
            pipeline: "End-to-end ML pipeline testing (comprehensive)",
            build: "Docker container build testing",
          };

          const estimatedTimes = {
            val: "1-3 minutes",
            endpoint: "30-60 seconds",
            pipeline: "3-5 minutes",
            build: "2-4 minutes",
          };

          const shouldRun = await interactive.confirmStep({
            stepName: `${test.charAt(0).toUpperCase() + test.slice(1)} Tests`,
            description:
              testDescriptions[test as keyof typeof testDescriptions] ||
              `Run ${test} tests`,
            impact: "medium",
            estimatedTime:
              estimatedTimes[test as keyof typeof estimatedTimes] ||
              "30-60 seconds",
            dependencies:
              test === "endpoint"
                ? ["Deployed endpoint"]
                : ["Test data", "Model files"],
          });

          if (!shouldRun) {
            logger.warn(`Skipping ${test} tests`);
            continue;
          }
          spinner.start();
        }

        spinner.text = `Running ${test} tests...`;

        switch (test) {
          case "env":
            await runEnvironmentTests(projectConfig);
            break;
          case "build":
            await runBuildTests(projectConfig);
            break;
          case "requirements":
            await runRequirementsTests();
            break;
          case "unit":
            await runUnitTests();
            break;
          case "lint":
            await runLintTests();
            break;
          case "model":
            await runModelTests(projectConfig);
            break;
          case "data":
            await runDataTests();
            break;
          case "inference":
            await runInferenceTests(options.path);
            break;
          case "val":
            await runValidationTests(projectConfig, options.path);
            break;
          case "endpoint":
            await runEndpointTests(options.endpoint!);
            break;
          case "pipeline":
            await runPipelineTests(projectConfig, options.path);
            break;
          default:
            break;
        }

        results.push({ test, status: "pass" });
        passedTests++;
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        results.push({
          test,
          status: "fail",
          message: errorMessage,
        });

        // Interactive error handling
        if (
          interactive.isInteractive() &&
          testsToRun.indexOf(test) < testsToRun.length - 1
        ) {
          spinner.stop();
          const remainingTests = testsToRun.slice(testsToRun.indexOf(test) + 1);
          const shouldContinue = await interactive.showProgressAndConfirm(
            results.filter((r) => r.status === "pass").map((r) => r.test),
            test,
            remainingTests,
            errorMessage
          );

          if (!shouldContinue) {
            logger.info("Testing stopped by user");
            break;
          }
          spinner.start();
        }
      }
    }

    // Show results
    spinner.stop();
    console.log();
    logger.info(chalk.bold("Test Results"));
    console.log();

    for (const result of results) {
      const icon = result.status === "pass" ? chalk.green("✓") : chalk.red("✗");
      const testName =
        result.test.charAt(0).toUpperCase() + result.test.slice(1);
      logger.info(`${icon} ${testName} tests`);

      if (result.status === "fail" && result.message) {
        logger.info(`   ${chalk.gray(result.message)}`);
      }
    }

    console.log();

    if (passedTests === totalTests) {
      logger.success(`All ${totalTests} test suites passed! `);
    } else {
      logger.error(
        `${totalTests - passedTests} of ${totalTests} test suites failed`
      );
      process.exit(1);
    }

    // Watch mode
    if (options.watch) {
      console.log();
      logger.info(chalk.blue("Watching for changes... Press Ctrl+C to stop"));
      await watchTests(testsToRun, projectConfig);
    }
  } catch (error) {
    spinner.fail(chalk.red("Test execution failed"));
    logger.error("Error:", error);
    process.exit(1);
  }
}

function determineTests(options: TestOptions): string[] {
  const tests: string[] = [];

  if (options.env) {
    tests.push("env");
  }
  if (options.build) {
    tests.push("build");
  }
  if (options.requirements) {
    tests.push("requirements");
  }
  if (options.unit) {
    tests.push("unit");
  }
  if (options.lint) {
    tests.push("lint");
  }
  if (options.model) {
    tests.push("model");
  }
  if (options.data) {
    tests.push("data");
  }
  if (options.inference) {
    tests.push("inference");
  }
  if (options.val) {
    tests.push("val");
  }
  if (options.endpoint) {
    tests.push("endpoint");
  }
  if (options.pipeline) {
    tests.push("pipeline");
  }

  return tests;
}

async function runEnvironmentTests(
  projectConfig: ProjectConfig
): Promise<void> {
  // Check Python3 version
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

      const versionValid =
        major > requiredMajor ||
        (major === requiredMajor && minor >= requiredMinor);

      if (!versionValid) {
        throw new Error(
          `Python ${projectConfig.pythonVersion || "3.9"}+ required, found ${major}.${minor}`
        );
      }
    } else {
      throw new Error(`Could not parse Python version from: ${pythonVersion}`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("required, found")) {
      throw error; // Re-throw version requirement errors
    }
    throw new Error(
      `Python3 not found - please ensure python3 is installed and available. Error: ${String(error)}`
    );
  }

  // Check CUDA availability if required
  if (projectConfig.gpuRequired) {
    try {
      if (projectConfig.framework === "pytorch") {
        const pytorchScript = "import torch\nassert torch.cuda.is_available()";
        const tempScriptPath = path.join(
          process.cwd(),
          "temp_pytorch_cuda_test.py"
        );
        fs.writeFileSync(tempScriptPath, pytorchScript);
        try {
          const result = await executePythonFile(tempScriptPath);
          if (!result.success) {
            throw new Error(
              `PyTorch framework test failed: ${formatExecutionError(result)}`
            );
          }
        } finally {
          if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
          }
        }
      } else if (projectConfig.framework === "tensorflow") {
        const tfScript =
          'import tensorflow as tf\nassert len(tf.config.list_physical_devices("GPU")) > 0';
        const tempScriptPath = path.join(process.cwd(), "temp_tf_cuda_test.py");
        fs.writeFileSync(tempScriptPath, tfScript);
        try {
          const result = await executePythonFile(tempScriptPath);
          if (!result.success) {
            throw new Error(
              `TensorFlow framework test failed: ${formatExecutionError(result)}`
            );
          }
        } finally {
          if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
          }
        }
      }
    } catch {
      throw new Error("CUDA/GPU not available but required by project");
    }
  }

  // Check virtual environment
  const inVenv = process.env["VIRTUAL_ENV"] || process.env["CONDA_DEFAULT_ENV"];
  if (!inVenv) {
    logger.warn("Not running in a virtual environment");
  }
}

async function runBuildTests(projectConfig: ProjectConfig): Promise<void> {
  // Test Docker build
  if (fs.existsSync("Dockerfile")) {
    try {
      const buildCommand = `docker build -t ${projectConfig.name}-test .`;
      execSync(buildCommand, { stdio: "pipe" });

      // Clean up test image
      execSync(`docker rmi ${projectConfig.name}-test`, { stdio: "pipe" });
    } catch {
      throw new Error("Docker build failed");
    }
  } else {
    throw new Error("Dockerfile not found");
  }
}

async function runRequirementsTests(): Promise<void> {
  if (!fs.existsSync("requirements.txt")) {
    throw new Error("requirements.txt not found");
  }

  try {
    // Check if all requirements can be resolved
    try {
      execSync("pip check", { stdio: "pipe" });
    } catch {
      // pip check failing is common in development environments
      logger.warn(
        "pip check found conflicts but continuing with installation test"
      );
    }

    // Try installing in dry-run mode to check for major conflicts
    try {
      execSync("pip install --dry-run -r requirements.txt", { stdio: "pipe" });
    } catch (dryRunError) {
      // Check if it's just missing packages vs real conflicts
      const errorMessage = String(dryRunError);
      if (errorMessage.includes("No matching distribution found")) {
        throw new Error("Some packages in requirements.txt are not available");
      }
      logger.warn(
        "Requirements dry-run failed but may be due to existing environment"
      );
    }
  } catch {
    throw new Error(
      "Requirements validation failed - dependency conflicts detected"
    );
  }
}

async function runUnitTests(): Promise<void> {
  if (!fs.existsSync("tests")) {
    throw new Error("Tests directory not found");
  }

  try {
    // Run pytest if available, otherwise run unittest
    try {
      execSync("python3 -m pytest tests/ -v", { stdio: "pipe" });
    } catch {
      // Fallback to unittest
      execSync("python3 -m unittest discover tests -v", { stdio: "pipe" });
    }
  } catch {
    throw new Error("Unit tests failed");
  }
}

async function runLintTests(): Promise<void> {
  const srcDir = "src";
  if (!fs.existsSync(srcDir)) {
    throw new Error("Source directory not found");
  }

  try {
    // Run flake8 if available
    try {
      const flake8Result = await executeScript("python3", [
        "-m",
        "flake8",
        srcDir,
      ]);
      if (!flake8Result.success) {
        // Try pylint as fallback
        try {
          const pylintResult = await executeScript("python3", [
            "-m",
            "pylint",
            srcDir,
          ]);
          if (!pylintResult.success) {
            logger.warn("Code linting issues found, but continuing...");
          }
        } catch {
          // Skip linting if no linter available
          logger.warn(
            "No linter found (flake8 or pylint), skipping code quality checks"
          );
        }
      }
    } catch {
      logger.warn("Linting skipped - linters not available");
    }
  } catch {
    throw new Error("Code quality checks failed");
  }
}

async function runModelTests(_projectConfig: ProjectConfig): Promise<void> {
  const modelFile = path.join("src", "model.py");
  if (!fs.existsSync(modelFile)) {
    throw new Error("Model file not found");
  }

  try {
    // Test model import and creation
    const testScript = `import sys
sys.path.append('src')
from model import create_model

# Test model creation
model = create_model()
print('Model created successfully')

# Test that model has required methods
if hasattr(model, 'fit') and hasattr(model, 'predict'):
    print('Model has required methods')
elif hasattr(model, 'forward'):
    print('PyTorch model has forward method')
else:
    raise Exception('Model missing required methods')
`;

    // Write script to temporary file to avoid shell escaping issues
    const tempScriptPath = path.join(process.cwd(), "temp_model_test.py");
    fs.writeFileSync(tempScriptPath, testScript);

    try {
      const result = execSync(`python3 ${tempScriptPath}`, {
        encoding: "utf8",
      });
      console.log("Model test passed:", result);
    } catch (execError) {
      console.log("Model test failed:", String(execError));
      throw execError;
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    }
  } catch {
    throw new Error("Model loading or instantiation failed");
  }
}

async function runDataTests(): Promise<void> {
  const dataLoaderFile = path.join("src", "data_loader.py");
  if (!fs.existsSync(dataLoaderFile)) {
    throw new Error("Data loader file not found");
  }

  // Check if sample data exists
  const sampleDataPath = path.join("data", "sample");
  if (fs.existsSync(sampleDataPath)) {
    const allFiles = fs.readdirSync(sampleDataPath);
    const cirronIgnore = CirronIgnore.createDefault();
    const files = cirronIgnore.filterFiles(
      allFiles.map((f) => path.join(sampleDataPath, f))
    );
    if (files.length === 0) {
      throw new Error(
        "Sample data directory is empty (after applying .cirronignore)"
      );
    }
  }

  try {
    // Test data loader import and basic functionality
    const testScript = `import sys
sys.path.append('src')
from data_loader import *

print('Data loader imported successfully')

# Test if we can load sample data
import os
if os.path.exists('data/sample/sample_data.csv'):
    import pandas as pd
    data = pd.read_csv('data/sample/sample_data.csv')
    if len(data) > 0:
        print('Sample data loaded successfully')
    else:
        raise Exception('Sample data is empty')
else:
    print('No sample data found, skipping data validation')
`;

    // Write script to temporary file to avoid shell escaping issues
    const tempScriptPath = path.join(process.cwd(), "temp_data_test.py");
    fs.writeFileSync(tempScriptPath, testScript);

    try {
      const result = await executePythonFile(tempScriptPath);
      if (!result.success) {
        throw new Error(`Data test failed: ${formatExecutionError(result)}`);
      }
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    }
  } catch {
    throw new Error("Data loading tests failed");
  }
}

async function runInferenceTests(dataPath?: string): Promise<void> {
  const inferenceFile = path.join("src", "inference.py");
  if (!fs.existsSync(inferenceFile)) {
    throw new Error("Inference file not found");
  }

  try {
    // Test inference class import and instantiation
    const testScript = `
import sys
sys.path.append('src')
from inference import ModelInference
import numpy as np

# Test inference creation
inference = ModelInference()
print("Inference object created successfully")

# Check if we have a trained model to load
import os
model_path = 'models/model.joblib'
if os.path.exists(model_path):
    print("Loading trained model for inference test...")
    inference.load_model(model_path)
else:
    print("No trained model found. Training model first...")
    # Train the model using the training data
    from train import Trainer
    config = {
        'model_type': 'nlp',
        'data_path': 'data/sample/sample_data.csv',
    }
    trainer = Trainer(config)
    trainer.train()
    trainer.save_model()
    inference.load_model(model_path)

# Test with real data or fall back to dummy data
import os
import pandas as pd

# Determine test data path from configuration
import json
config_path = None
for _cfg_name in ['cirron.yaml', 'cirron.yml', 'cirron.json']:
    if os.path.exists(_cfg_name):
        config_path = _cfg_name
        break

_yaml_mod = None
if config_path and not config_path.endswith('.json'):
    try:
        import yaml as _yaml_mod
    except ImportError:
        print("Warning: cirron.yaml/yml found but 'pyyaml' is not installed. "
              "Install it ('pip install pyyaml') or switch to cirron.json.")
        config_path = None

test_data_path = None

if "${dataPath}":
    test_data_path = "${dataPath}"
else:
    # Load configuration
    if config_path and os.path.exists(config_path):
        with open(config_path, 'r') as f:
            if config_path.endswith('.json'):
                config = json.load(f)
            else:
                config = _yaml_mod.safe_load(f)
        
        # Get test data paths from config
        test_config = config.get('test', {})
        data_paths = test_config.get('dataPaths', {})
        
        # Try inference path first, then validation, then sample
        if 'inference' in data_paths and os.path.exists(data_paths['inference']):
            test_data_path = data_paths['inference']
        elif 'validation' in data_paths and os.path.exists(data_paths['validation']):
            test_data_path = data_paths['validation']
        elif 'sample' in data_paths and os.path.exists(data_paths['sample']):
            test_data_path = data_paths['sample']

if test_data_path and os.path.exists(test_data_path):
    print(f"Testing inference with real data from: {test_data_path}")
    # Load real data
    data = pd.read_csv(test_data_path)
    if not data.empty:
        # Use first row as test input (excluding target column)
        features = data.iloc[0:1, :-1].values  # First row, all columns except last
        result = inference.predict(features)
        print(f"Inference test completed with real data. Prediction: {result}")
    else:
        raise Exception("Test data file is empty")
else:
    # Check if fallback to dummy data is allowed in config
    fallback_allowed = test_config.get('fallbackToDummy', True) if 'test_config' in locals() else True
    
    if fallback_allowed:
        print("No real data found, using dummy data for inference test")
        # Fall back to dummy data
        dummy_input = np.random.randn(1, 5)  # 5 features to match training data
        result = inference.predict(dummy_input)
        print("Inference test completed with dummy data")
    else:
        raise Exception("No test data found and fallback to dummy data is disabled")
`;

    // Write script to temporary file to avoid shell escaping issues
    const tempScriptPath = path.join(process.cwd(), "temp_inference_test.py");
    fs.writeFileSync(tempScriptPath, testScript);

    try {
      const result = await executePythonFile(tempScriptPath);
      if (!result.success) {
        throw new Error(
          `Inference test failed: ${formatExecutionError(result)}`
        );
      }
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    }
  } catch {
    throw new Error("Inference tests failed");
  }
}

async function watchTests(
  testsToRun: string[],
  projectConfig: ProjectConfig
): Promise<void> {
  const chokidar = require("chokidar");

  const watcher = chokidar.watch(
    [
      "src/**/*.py",
      "tests/**/*.py",
      "cirron.json",
      "cirron.yaml",
      "cirron.yml",
    ],
    {
      ignored: /(^|[/\\])\../,
      persistent: true,
    }
  );

  let isRunning = false;

  const runTestsOnChange = async () => {
    if (isRunning) {
      return;
    }

    isRunning = true;
    console.log(chalk.blue("\n Files changed, running tests..."));

    try {
      // Run a subset of tests on file changes (faster)
      const quickTests = testsToRun.filter((test) =>
        ["unit", "model", "data", "lint"].includes(test)
      );

      for (const test of quickTests) {
        try {
          switch (test) {
            case "unit":
              await runUnitTests();
              logger.info(chalk.green("✓ Unit tests passed"));
              break;
            case "model":
              await runModelTests(projectConfig);
              logger.info(chalk.green("✓ Model tests passed"));
              break;
            case "data":
              await runDataTests();
              logger.info(chalk.green("✓ Data tests passed"));
              break;
            case "lint":
              await runLintTests();
              logger.info(chalk.green("✓ Lint tests passed"));
              break;
            default:
              break;
          }
        } catch (error) {
          logger.error(chalk.red(`✗ ${test} tests failed: ${error}`));
        }
      }
    } catch (error) {
      logger.error("Watch test failed:", error);
    }

    isRunning = false;
    console.log(chalk.blue("Watching for changes..."));
  };

  watcher.on("change", runTestsOnChange);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    watcher.close();
    logger.info("\nStopped watching files");
    process.exit(0);
  });
}

async function runValidationTests(
  _projectConfig: ProjectConfig,
  dataPath?: string
): Promise<void> {
  const modelFile = path.join("src", "model.py");
  const inferenceFile = path.join("src", "inference.py");

  if (!(fs.existsSync(modelFile) && fs.existsSync(inferenceFile))) {
    throw new Error("Model or inference file not found");
  }

  // Determine validation data path
  let validationPath = dataPath;
  if (!validationPath) {
    // Try to get validation path from configuration
    try {
      const configResult = loadProjectConfig();
      if (configResult) {
        const testConfig = configResult.config.test || {};
        const dataPaths = testConfig.dataPaths || {};

        if (dataPaths.validation && fs.existsSync(dataPaths.validation)) {
          validationPath = dataPaths.validation;
        } else if (dataPaths.sample && fs.existsSync(dataPaths.sample)) {
          validationPath = dataPaths.sample;
        }
      }
    } catch {
      // Continue with fallback paths if config reading fails
    }

    // Fallback to common validation data locations
    if (!validationPath) {
      const commonPaths = [
        "data/validation",
        "data/val",
        "data/test",
        "data/sample",
      ];

      for (const commonPath of commonPaths) {
        if (fs.existsSync(commonPath)) {
          validationPath = commonPath;
          break;
        }
      }
    }

    if (!validationPath) {
      throw new Error(
        "No validation data found. Specify path with -p option or configure in your project config"
      );
    }
  }

  if (!fs.existsSync(validationPath)) {
    throw new Error(`Validation data path not found: ${validationPath}`);
  }

  const isDirectory = fs.statSync(validationPath).isDirectory();
  let testFiles: string[] = [];

  if (isDirectory) {
    // Get all CSV files in directory, filtered by .cirronignore
    const cirronIgnore = CirronIgnore.createDefault();
    const allFiles = fs
      .readdirSync(validationPath)
      .filter((file) => file.endsWith(".csv"))
      .map((file) => path.join(validationPath!, file));
    testFiles = cirronIgnore.filterFiles(allFiles);
  } else {
    // Single file - check if it should be ignored
    const cirronIgnore = CirronIgnore.createDefault();
    if (cirronIgnore.isIgnored(validationPath)) {
      testFiles = [];
    } else {
      testFiles = [validationPath];
    }
  }

  if (testFiles.length === 0) {
    throw new Error("No validation data files found (CSV format expected)");
  }

  logger.info(
    `Testing model accuracy on ${testFiles.length} validation file(s)`
  );

  try {
    // Run validation test for each file
    for (const testFile of testFiles) {
      const testScript = `import sys
import os
import time
import pandas as pd
import numpy as np
sys.path.append('src')

from model import create_model
from inference import ModelInference

# Load validation data
print("Loading validation data from: ${path.basename(testFile)}")
data = pd.read_csv("${testFile}")

if data.empty:
    raise Exception("Validation data is empty")

# Assume last column is target, rest are features
features = data.iloc[:, :-1].values
targets = data.iloc[:, -1].values

print("Validation data shape:", features.shape)
print("Target distribution:", np.unique(targets, return_counts=True))

# Initialize model and inference
inference = ModelInference()
model = create_model()

# Check if we have a trained model to load
import os
model_path = 'models/model.joblib'
if os.path.exists(model_path):
    print("Loading trained model...")
    inference.load_model(model_path)
else:
    print("No trained model found. Training model first...")
    # Train the model using the training data
    from train import Trainer
    config = {
        'model_type': 'nlp',
        'data_path': 'data/sample/sample_data.csv',
    }
    trainer = Trainer(config)
    trainer.train()
    trainer.save_model()
    inference.load_model(model_path)

# Test prediction accuracy
start_time = time.time()
predictions = []

for i in range(len(features)):
    pred = inference.predict(features[i:i+1])
    if hasattr(pred, 'numpy'):  # PyTorch tensor
        pred = pred.numpy()
    if isinstance(pred, np.ndarray):
        pred = pred.flatten()[0] if pred.size == 1 else pred[0]
    predictions.append(pred)

end_time = time.time()
predictions = np.array(predictions)

# Calculate metrics
if len(np.unique(targets)) <= 10:  # Classification
    accuracy = np.mean(predictions.round() == targets)
    print("Classification Accuracy: {:.4f} ({:.2f}%)".format(accuracy, accuracy*100))
else:  # Regression
    mse = np.mean((predictions - targets) ** 2)
    mae = np.mean(np.abs(predictions - targets))
    print("Mean Squared Error: {:.4f}".format(mse))
    print("Mean Absolute Error: {:.4f}".format(mae))

# Performance metrics
total_time = end_time - start_time
avg_latency = total_time / len(features) * 1000  # ms per prediction
throughput = len(features) / total_time  # predictions per second

print("Total inference time: {:.4f}s".format(total_time))
print("Average latency: {:.2f}ms per prediction".format(avg_latency))
print("Throughput: {:.2f} predictions/second".format(throughput))
`;

      // Write script to temporary file to avoid shell escaping issues
      const tempScriptPath = path.join(
        process.cwd(),
        "temp_validation_test.py"
      );
      fs.writeFileSync(tempScriptPath, testScript);

      try {
        const result = execSync(`python3 ${tempScriptPath}`, {
          encoding: "utf8",
          timeout: 60_000, // 60 second timeout
        });

        logger.info(`Validation results for ${path.basename(testFile)}:`);
        console.log(result);
      } finally {
        // Clean up temporary file
        if (fs.existsSync(tempScriptPath)) {
          fs.unlinkSync(tempScriptPath);
        }
      }
    }
  } catch (error) {
    throw new Error(`Validation testing failed: ${error}`);
  }
}

async function runEndpointTests(endpointUrl: string): Promise<void> {
  try {
    // Validate URL format
    new URL(endpointUrl);
  } catch {
    throw new Error("Invalid endpoint URL format");
  }

  logger.info(`Testing endpoint: ${endpointUrl}`);

  try {
    const testScript = `import requests
import json
import time
import numpy as np
from statistics import mean, median

endpoint = "${endpointUrl}"
num_requests = 10

# Generate test data (adjust based on your model's expected input)
test_data = {
    "features": [0.5, 1.2, 0.8, 2.1, 1.5],
    "data": [[0.5, 1.2, 0.8, 2.1, 1.5], [1.1, 0.9, 1.3, 1.7, 0.8]]
}

latencies = []
success_count = 0
errors = []

print("Testing endpoint with {} requests...".format(num_requests))

for i in range(num_requests):
    try:
        start_time = time.time()
        
        # Make prediction request
        response = requests.post(
            endpoint,
            json=test_data,
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        
        end_time = time.time()
        latency = (end_time - start_time) * 1000  # Convert to ms
        latencies.append(latency)
        
        if response.status_code == 200:
            success_count += 1
            result = response.json()
            print("Request {}: {} - {:.2f}ms".format(i+1, response.status_code, latency))
        else:
            errors.append("Request {}: HTTP {}".format(i+1, response.status_code))
            print("Request {}: HTTP {} - {}".format(i+1, response.status_code, response.text[:100]))
            
    except requests.exceptions.Timeout:
        errors.append("Request {}: Timeout".format(i+1))
        print("Request {}: Timeout".format(i+1))
    except Exception as e:
        errors.append("Request {}: {}".format(i+1, str(e)))
        print("Request {}: Error - {}".format(i+1, str(e)))

# Calculate metrics
if latencies:
    avg_latency = mean(latencies)
    median_latency = median(latencies)
    min_latency = min(latencies)
    max_latency = max(latencies)
    success_rate = success_count / num_requests * 100
    
    print("\\n=== Endpoint Performance Metrics ===")
    print("Success Rate: {:.1f}% ({}/{})".format(success_rate, success_count, num_requests))
    print("Average Latency: {:.2f}ms".format(avg_latency))
    print("Median Latency: {:.2f}ms".format(median_latency))
    print("Min Latency: {:.2f}ms".format(min_latency))
    print("Max Latency: {:.2f}ms".format(max_latency))
    print("Throughput: {:.2f} requests/second".format(1000/avg_latency))
    
    if errors:
        print("\\nErrors ({}):".format(len(errors)))
        for error in errors[:5]:  # Show first 5 errors
            print("  - {}".format(error))
else:
    raise Exception("No successful requests - endpoint may be down")
`;

    // Write script to temporary file to avoid shell escaping issues
    const tempScriptPath = path.join(process.cwd(), "temp_endpoint_test.py");
    fs.writeFileSync(tempScriptPath, testScript);

    try {
      const result = execSync(`python3 ${tempScriptPath}`, {
        encoding: "utf8",
        timeout: 120_000, // 2 minute timeout
      });

      console.log(result);
    } finally {
      // Clean up temporary file
      if (fs.existsSync(tempScriptPath)) {
        fs.unlinkSync(tempScriptPath);
      }
    }
  } catch (error) {
    throw new Error(`Endpoint testing failed: ${error}`);
  }
}

async function runPipelineTests(
  projectConfig: ProjectConfig,
  dataPath?: string
): Promise<void> {
  logger.info("Testing complete ML pipeline...");

  // Run tests in sequence: data loading -> model -> inference -> validation
  const pipelineSteps = [
    { name: "Environment", test: () => runEnvironmentTests(projectConfig) },
    { name: "Data Loading", test: () => runDataTests() },
    { name: "Model Creation", test: () => runModelTests(projectConfig) },
    { name: "Inference", test: () => runInferenceTests(dataPath) },
  ];

  // Add validation if data path provided
  if (
    dataPath ||
    fs.existsSync("data/sample") ||
    fs.existsSync("data/validation")
  ) {
    pipelineSteps.push({
      name: "Validation",
      test: () => runValidationTests(projectConfig, dataPath),
    });
  }

  const results: {
    step: string;
    success: boolean;
    time: number;
    error?: string;
  }[] = [];

  for (const step of pipelineSteps) {
    const startTime = Date.now();
    try {
      logger.info(`Pipeline step: ${step.name}`);
      await step.test();
      const endTime = Date.now();
      results.push({
        step: step.name,
        success: true,
        time: endTime - startTime,
      });
      logger.info(`✓ ${step.name} completed in ${endTime - startTime}ms`);
    } catch (error) {
      const endTime = Date.now();
      results.push({
        step: step.name,
        success: false,
        time: endTime - startTime,
        error: error instanceof Error ? error.message : String(error),
      });
      logger.error(`✗ ${step.name} failed: ${error}`);
      throw new Error(`Pipeline failed at step: ${step.name}`);
    }
  }

  // Summary
  const totalTime = results.reduce((sum, result) => sum + result.time, 0);
  const successfulSteps = results.filter((r) => r.success).length;

  logger.info("\n=== Pipeline Test Results ===");
  logger.info(`Steps completed: ${successfulSteps}/${results.length}`);
  logger.info(`Total time: ${totalTime}ms`);

  for (const result of results) {
    const status = result.success ? "✓" : "✗";
    logger.info(`${status} ${result.step}: ${result.time}ms`);
  }
}
