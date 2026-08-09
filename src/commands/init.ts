import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import inquirer from "inquirer";
import ora from "ora";
import type { InitOptions, ProjectConfig, Template } from "../types";
import { CirronApi } from "../utils/api";
import { isAuthenticated } from "../utils/auth-guard";
import { ConfigManager } from "../utils/config";
import { executeScript, formatExecutionError } from "../utils/execution";
import { logger } from "../utils/logger";
import { findProjectConfigPath } from "../utils/project-config";
import {
  createCommonMLFiles,
  createCustomFiles,
  createPyTorchFiles,
  createPyTorchTrainingFiles,
  createSklearnFiles,
  createSklearnPipelineFiles,
  createTensorFlowFiles,
  createTensorFlowTrainingFiles,
} from "./files";

export const TEMPLATES: Record<string, Template> = {
  pytorch: {
    name: "PyTorch",
    description: "PyTorch model with training and inference",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  tensorflow: {
    name: "TensorFlow",
    description: "TensorFlow/Keras model with training and inference",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  sklearn: {
    name: "Scikit-Learn",
    description: "Scikit-learn model with preprocessing and inference",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  "pytorch-train": {
    name: "PyTorch Training",
    description: "PyTorch training pipeline with data loading",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  "tensorflow-train": {
    name: "TensorFlow Training",
    description: "TensorFlow training pipeline with data loading",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  "sklearn-pipeline": {
    name: "Scikit-Learn Pipeline",
    description: "Full ML pipeline with preprocessing and training",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
  custom: {
    name: "Custom Framework",
    description: "Blank Python project for any ML framework",
    files: [],
    postInstall: ["pip install -r requirements.txt"],
  },
};

// Keys are kebab-case to match the cirron-sample-models reference shape
// (e.g. `type: time-series` in cirron.yaml).
const MODEL_TYPES = {
  classification: "Classification",
  regression: "Regression",
  "computer-vision": "Computer Vision",
  nlp: "Natural Language Processing",
  "time-series": "Time Series",
  embedding: "Embedding",
  custom: "Custom",
};

/**
 * Ask what to do about a directory that already has a Cirron config.
 *
 * Both entry points (running inside an existing project, and targeting an
 * existing directory by name) offer the same three choices; only the message
 * differs.
 */
async function promptExistingProjectAction(
  message: string
): Promise<"register" | "overwrite" | "cancel"> {
  const { action } = await inquirer.prompt([
    {
      type: "select",
      name: "action",
      message,
      choices: [
        {
          name: "Register existing project with Cirron (no file changes)",
          value: "register",
        },
        { name: "Overwrite and reinitialize", value: "overwrite" },
        { name: "Cancel", value: "cancel" },
      ],
      loop: false,
    },
  ]);
  return action;
}

/** Entry point for `cirron init`: scaffold a project from a framework template. */
export async function initCommand(
  projectName?: string,
  options: InitOptions = { template: "pytorch" }
): Promise<void> {
  try {
    // Check if running from a directory that already has a cirron config
    const existingConfigInCwd = findProjectConfigPath(process.cwd());
    if (existingConfigInCwd) {
      const action = await promptExistingProjectAction(
        `Current directory already has a Cirron config (${path.basename(existingConfigInCwd)}). What would you like to do?`
      );

      if (action === "cancel") {
        logger.info("Initialization cancelled");
        return;
      }

      if (action === "register") {
        const { registerCommand } = await import("./register");
        await registerCommand({});
        return;
      }
      // action === 'overwrite' falls through to normal init flow
    }

    // Get project name if not provided
    let resolvedName = projectName;
    if (!resolvedName) {
      const answers = await inquirer.prompt([
        {
          type: "input",
          name: "name",
          message: "Project name:",
          default: "my-ml-project",
          validate: (input: string) => {
            if (!input.trim()) {
              return "Project name is required";
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
              return "Project name can only contain letters, numbers, hyphens, and underscores";
            }
            return true;
          },
        },
      ]);
      resolvedName = answers.name;
    }

    const projectPath = path.resolve(process.cwd(), resolvedName!);
    // Use only the final path segment as the project name (the input may be a relative path).
    resolvedName = path.basename(projectPath);

    // Check for existing project/model with the same name in the current directory
    const existingProjectPath = projectPath;
    if (fs.existsSync(existingProjectPath)) {
      // Check for cirron config (cirron.yaml/yml/json) or model.py as a sign of an existing project/model
      const cirronConfigExists = !!findProjectConfigPath(existingProjectPath);
      const modelPyExists = fs.existsSync(
        path.join(existingProjectPath, "src", "model.py")
      );
      const files = fs.readdirSync(existingProjectPath);
      const hasExistingFiles = files.length > 0;

      if (cirronConfigExists) {
        // Existing project with config - offer to register instead of overwrite
        const action = await promptExistingProjectAction(
          `Directory "${resolvedName}" already has a Cirron config. What would you like to do?`
        );

        if (action === "cancel") {
          logger.info("Initialization cancelled");
          return;
        }

        if (action === "register") {
          const { registerCommand } = await import("./register");
          await registerCommand({ dir: existingProjectPath });
          return;
        }
        // action === 'overwrite' falls through to scaffolding
      } else if (modelPyExists || hasExistingFiles) {
        const answers = await inquirer.prompt([
          {
            type: "confirm",
            name: "proceed",
            message: `WARNING: There is already a model with this name (${resolvedName}) and this action will overwrite existing files. This cannot be undone. Continue anyway?`,
            default: false,
          },
        ]);
        if (!answers.proceed) {
          logger.info("Initialization cancelled");
          return;
        }
      }
    }

    // Template and model type selection
    let template = options.template;
    let modelType = "classification";
    let includeSampleData = true; // Default to true for better testing
    let includeNotebook = true; // Default to true for better development experience

    if (!TEMPLATES[template]) {
      const templateAnswers = await inquirer.prompt([
        {
          type: "select",
          name: "template",
          message: "Choose a framework:",
          choices: Object.entries(TEMPLATES).map(([key, template]) => ({
            name: `${template.name} - ${template.description}`,
            value: key,
          })),
        },
        {
          type: "select",
          name: "modelType",
          message: "Choose model type:",
          choices: Object.entries(MODEL_TYPES).map(([key, name]) => ({
            name,
            value: key,
          })),
        },
        {
          type: "confirm",
          name: "includeSampleData",
          message: "Include sample data?",
          default: true,
        },
        {
          type: "confirm",
          name: "includeNotebook",
          message: "Include Jupyter notebook?",
          default: true,
        },
      ]);

      template = templateAnswers.template;
      modelType = templateAnswers.modelType;
      includeSampleData = templateAnswers.includeSampleData;
      includeNotebook = templateAnswers.includeNotebook;
    }

    const selectedTemplate = TEMPLATES[template];
    if (!selectedTemplate) {
      throw new Error(`Unknown template: ${template}`);
    }

    const spinner = ora(`Creating ${selectedTemplate.name} project...`).start();

    try {
      // Create project directory
      await fs.ensureDir(projectPath);

      // Create project files based on template
      await createProjectFiles(projectPath, resolvedName!, template, {
        modelType,
        includeSampleData,
        includeNotebook,
      });

      // Initialize git if requested
      if (options.git) {
        spinner.text = "Initializing git repository...";
        try {
          const gitInitResult = await executeScript("git", ["init"], {
            cwd: projectPath,
          });
          if (!gitInitResult.success) {
            throw new Error(`Git init failed: ${gitInitResult.stderr}`);
          }

          const gitAddResult = await executeScript("git", ["add", "."], {
            cwd: projectPath,
          });
          if (!gitAddResult.success) {
            throw new Error(`Git add failed: ${gitAddResult.stderr}`);
          }

          const gitCommitResult = await executeScript(
            "git",
            ["commit", "-m", "Initial commit"],
            { cwd: projectPath }
          );
          if (!gitCommitResult.success) {
            throw new Error(`Git commit failed: ${gitCommitResult.stderr}`);
          }

          logger.info("Git repository initialized");
        } catch {
          logger.warn("Failed to initialize git repository");
        }
      }

      // Install dependencies if requested
      if (
        options.install &&
        selectedTemplate.postInstall &&
        selectedTemplate.postInstall.length > 0
      ) {
        spinner.text = "Installing dependencies...";
        for (const command of selectedTemplate.postInstall) {
          try {
            const [cmd, ...args] = command.split(" ");
            const result = await executeScript(cmd || "", args, {
              cwd: projectPath,
            });
            if (!result.success) {
              logger.warn(`Failed to run: ${command}`);
              if (result.parsedErrors && result.parsedErrors.length > 0) {
                logger.debug(
                  "Command error details:",
                  formatExecutionError(result)
                );
              }
            }
          } catch {
            logger.warn(`Failed to run: ${command}`);
          }
        }
      }

      // Register project with Cirron API (if authenticated)
      const config = new ConfigManager();
      const currentConfig = config.load();

      if (isAuthenticated(currentConfig)) {
        spinner.text = "Registering project with Cirron...";
        try {
          const api = new CirronApi(currentConfig);
          await api.createProject({
            name: resolvedName!,
            framework: deriveFramework(template),
            path: projectPath,
          });
          logger.info("Project registered with Cirron");
        } catch {
          logger.warn(
            "Failed to register project with Cirron (continuing anyway)"
          );
        }
      }

      spinner.succeed(
        chalk.green(`Project ${resolvedName} created successfully!`)
      );

      // Show next steps
      console.log();
      logger.info(chalk.bold("Next steps:"));
      logger.info(`  ${chalk.cyan(`cd ${resolvedName}`)}`);

      if (
        !options.install &&
        selectedTemplate.postInstall &&
        selectedTemplate.postInstall.length > 0
      ) {
        logger.info(`  ${chalk.cyan("pip install -r requirements.txt")}`);
      }

      logger.info(`  ${chalk.cyan("python train.py")}`);
      logger.info(`  ${chalk.cyan("python serve.py")}`);

      if (!isAuthenticated(currentConfig)) {
        console.log();
        logger.info(
          chalk.yellow("Tip: Run ") +
            chalk.cyan("cirron auth login") +
            chalk.yellow(" to connect to Cirron")
        );
      }
    } catch (error) {
      spinner.fail(chalk.red("Project creation failed"));
      throw error;
    }
  } catch (error) {
    logger.error("Failed to initialize project:", error);
    process.exit(1);
  }
}

function deriveFramework(template: string): ProjectConfig["framework"] {
  if (template.startsWith("pytorch")) {
    return "pytorch";
  }
  if (template.startsWith("tensorflow")) {
    return "tensorflow";
  }
  if (template.startsWith("sklearn")) {
    return "sklearn";
  }
  return "custom";
}

function deriveType(modelType: string): string {
  // The picker already emits kebab-case; normalize anything else.
  return modelType.replace(/_/g, "-");
}

async function createProjectFiles(
  projectPath: string,
  projectName: string,
  template: string,
  options: {
    modelType: string;
    includeSampleData: boolean;
    includeNotebook: boolean;
  }
): Promise<void> {
  const framework = deriveFramework(template);
  const modelType = deriveType(options.modelType || "classification");

  // Per-template servingConfig + cirron.yaml are produced by the framework
  // file generator, since input/output schemas are framework-specific.
  switch (template) {
    case "pytorch":
      await createPyTorchFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "pytorch-train":
      await createPyTorchTrainingFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "tensorflow":
      await createTensorFlowFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "tensorflow-train":
      await createTensorFlowTrainingFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "sklearn":
      await createSklearnFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "sklearn-pipeline":
      await createSklearnPipelineFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    case "custom":
      await createCustomFiles(projectPath, projectName, {
        ...options,
        modelType,
      });
      break;
    default:
      break;
  }

  await createCommonMLFiles(projectPath, projectName, {
    ...options,
    framework,
    modelType,
  });
}
