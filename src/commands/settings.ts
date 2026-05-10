import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import type { SettingsOptions } from "../types";
import { logger } from "../utils/logger";
import { settingsManager } from "../utils/settings";

export async function settingsCommand(options: SettingsOptions): Promise<void> {
  try {
    // Determine scope - default to global if not in project
    const scope = determineScope(options);

    if (options.list) {
      await listSettings(scope, options);
    } else if (options.get) {
      await getSetting(options.get, scope, options);
    } else if (options.set) {
      await setSetting(options.set, scope, options);
    } else if (options.delete) {
      await deleteSetting(options.delete, scope, options);
    } else if (options.edit) {
      await editSettings(scope, options);
    } else if (options.export) {
      await exportSettings(options.export, scope, options);
    } else if (options.import) {
      await importSettings(options.import, scope, options);
    } else if (options.template) {
      await applyTemplate(options.template, options);
    } else if (options.explain) {
      await explainSetting(options.explain, options);
    } else if (options.reset) {
      await resetSettings(scope, options);
    } else {
      // Interactive mode
      await interactiveSettings(scope, options);
    }
  } catch (error) {
    logger.error("Settings command failed:", error);
    process.exit(1);
  }
}

function determineScope(options: SettingsOptions): "global" | "project" {
  if (options.global) {
    return "global";
  }
  if (options.project) {
    return "project";
  }

  // Auto-detect: use project if we're in a project directory
  const projectRoot = settingsManager.findProjectRoot();
  return projectRoot ? "project" : "global";
}

async function listSettings(
  scope: "global" | "project",
  options: SettingsOptions
): Promise<void> {
  if (scope === "global" || !options.project) {
    const globalSettings = settingsManager.loadGlobalSettings();

    if (options.json) {
      console.log(JSON.stringify(globalSettings, null, 2));
      return;
    }

    console.log();
    logger.info(chalk.bold("Global Settings"));
    console.log();

    displaySettingsSection("General", globalSettings.general);
    displaySettingsSection("UI", globalSettings.ui);
    displaySettingsSection("Development", globalSettings.development);
    displaySettingsSection("Cloud", globalSettings.cloud);
    displaySettingsSection("API", globalSettings.api, true); // mask sensitive data
  }

  if (scope === "project" || !(options.global || options.project)) {
    const projectSettings = settingsManager.loadProjectSettings();

    if (projectSettings) {
      if (options.json) {
        console.log(JSON.stringify(projectSettings, null, 2));
        return;
      }

      console.log();
      logger.info(chalk.bold("Project Settings"));
      console.log();

      displaySettingsSection("General", projectSettings.general);
      displaySettingsSection("Build", projectSettings.build);
      displaySettingsSection("Test", projectSettings.test);
      displaySettingsSection("Deployment", projectSettings.deployment);
    } else if (scope === "project") {
      logger.warn(
        "No project settings found. Not in a Cirron project directory?"
      );
      return;
    }
  }
}

function displaySettingsSection(
  title: string,
  section: any,
  maskSensitive = false
): void {
  logger.info(chalk.cyan(`${title}:`));

  Object.entries(section).forEach(([key, value]) => {
    let displayValue = value;

    if (
      maskSensitive &&
      key.toLowerCase().includes("token") &&
      typeof value === "string"
    ) {
      displayValue =
        value.substring(0, 8) + "*".repeat(Math.max(0, value.length - 8));
    }

    logger.info(`  ${chalk.yellow(key)}: ${displayValue}`);
  });

  console.log();
}

async function getSetting(
  key: string,
  scope: "global" | "project",
  options: SettingsOptions
): Promise<void> {
  try {
    let value: any;

    if (scope === "global") {
      const settings = settingsManager.loadGlobalSettings();
      value = getNestedValue(settings, key);
    } else {
      const settings = settingsManager.loadProjectSettings();
      if (!settings) {
        logger.error("No project settings found");
        return;
      }
      value = getNestedValue(settings, key);
    }

    if (value === undefined) {
      logger.error(`Setting '${key}' not found`);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify({ [key]: value }, null, 2));
    } else {
      // Mask sensitive values
      let displayValue = value;
      if (key.toLowerCase().includes("token") && typeof value === "string") {
        displayValue =
          value.substring(0, 8) + "*".repeat(Math.max(0, value.length - 8));
      }

      logger.info(`${chalk.cyan(key)}: ${displayValue}`);
    }
  } catch (error) {
    logger.error(`Failed to get setting '${key}':`, error);
  }
}

async function setSetting(
  keyValue: string,
  scope: "global" | "project",
  _options: SettingsOptions
): Promise<void> {
  const [key, ...valueParts] = keyValue.split("=");
  const value = valueParts.join("=");

  if (!key || value === undefined) {
    logger.error("Invalid format. Use: key=value");
    return;
  }

  try {
    if (scope === "global") {
      const settings = settingsManager.loadGlobalSettings();
      setNestedValue(settings, key, parseValue(value));
      settingsManager.saveGlobalSettings(settings);
    } else {
      let settings = settingsManager.loadProjectSettings();
      if (!settings) {
        settings = settingsManager.getDefaultProjectSettings();
      }
      setNestedValue(settings, key, parseValue(value));
      settingsManager.saveProjectSettings(settings);
    }

    logger.info(
      `${chalk.green("✓")} Set ${chalk.cyan(key)} = ${chalk.yellow(value)} (${scope})`
    );
  } catch (error) {
    logger.error(`Failed to set setting '${key}':`, error);
  }
}

async function deleteSetting(
  key: string,
  scope: "global" | "project",
  _options: SettingsOptions
): Promise<void> {
  try {
    if (scope === "global") {
      const settings = settingsManager.loadGlobalSettings();
      if (deleteNestedValue(settings, key)) {
        settingsManager.saveGlobalSettings(settings);
        logger.info(`${chalk.green("✓")} Deleted ${chalk.cyan(key)} (global)`);
      } else {
        logger.error(`Setting '${key}' not found`);
      }
    } else {
      const settings = settingsManager.loadProjectSettings();
      if (!settings) {
        logger.error("No project settings found");
        return;
      }
      if (deleteNestedValue(settings, key)) {
        settingsManager.saveProjectSettings(settings);
        logger.info(`${chalk.green("✓")} Deleted ${chalk.cyan(key)} (project)`);
      } else {
        logger.error(`Setting '${key}' not found`);
      }
    }
  } catch (error) {
    logger.error(`Failed to delete setting '${key}':`, error);
  }
}

async function editSettings(
  scope: "global" | "project",
  _options: SettingsOptions
): Promise<void> {
  // Interactive settings editor
  if (scope === "global") {
    await editGlobalSettings(_options);
  } else {
    await editProjectSettings(_options);
  }
}

async function editGlobalSettings(_options: SettingsOptions): Promise<void> {
  const settings = settingsManager.loadGlobalSettings();

  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "category",
      message: "Which category would you like to edit?",
      choices: [
        { name: "General Settings", value: "general" },
        { name: "UI Settings", value: "ui" },
        { name: "Development Settings", value: "development" },
        { name: "Cloud Settings", value: "cloud" },
        { name: "API Settings", value: "api" },
      ],
      loop: false,
    },
  ]);

  switch (answers.category) {
    case "general":
      await editGeneralSettings(settings, "global");
      break;
    case "ui":
      await editUISettings(settings);
      break;
    case "development":
      await editDevelopmentSettings(settings);
      break;
    case "cloud":
      await editCloudSettings(settings);
      break;
    case "api":
      await editAPISettings(settings);
      break;
  }

  settingsManager.saveGlobalSettings(settings);
  logger.info(`${chalk.green("✓")} Global settings updated`);
}

async function editProjectSettings(_options: SettingsOptions): Promise<void> {
  let settings = settingsManager.loadProjectSettings();
  if (!settings) {
    settings = settingsManager.getDefaultProjectSettings();
  }

  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "category",
      message: "Which category would you like to edit?",
      choices: [
        { name: "General Settings", value: "general" },
        { name: "Build Settings", value: "build" },
        { name: "Test Settings", value: "test" },
        { name: "Deployment Settings", value: "deployment" },
      ],
      loop: false,
    },
  ]);

  switch (answers.category) {
    case "general":
      await editGeneralSettings(settings, "project");
      break;
    case "build":
      await editBuildSettings(settings);
      break;
    case "test":
      await editTestSettings(settings);
      break;
    case "deployment":
      await editDeploymentSettings(settings);
      break;
  }

  settingsManager.saveProjectSettings(settings);
  logger.info(`${chalk.green("✓")} Project settings updated`);
}

// Interactive editing helpers
async function editGeneralSettings(
  settings: any,
  scope: "global" | "project"
): Promise<void> {
  if (scope === "global") {
    const answers = await inquirer.prompt([
      {
        type: "select",
        name: "defaultTemplate",
        message: "Default project template:",
        default: settings.general.defaultTemplate,
        choices: [
          "pytorch",
          "pytorch-train",
          "tensorflow",
          "tensorflow-train",
          "sklearn",
          "sklearn-pipeline",
          "custom",
        ],
        loop: false,
      },
      {
        type: "confirm",
        name: "autoUpdate",
        message: "Enable automatic updates:",
        default: settings.general.autoUpdate,
      },
      {
        type: "confirm",
        name: "telemetry",
        message: "Enable telemetry:",
        default: settings.general.telemetry,
      },
      {
        type: "confirm",
        name: "verboseLogging",
        message: "Enable verbose logging:",
        default: settings.general.verboseLogging,
      },
    ]);

    Object.assign(settings.general, answers);
  } else {
    const answers = await inquirer.prompt([
      {
        type: "confirm",
        name: "autoSave",
        message: "Auto-save configuration changes:",
        default: settings.general.autoSave,
      },
      {
        type: "confirm",
        name: "buildOnChange",
        message: "Build automatically when files change:",
        default: settings.general.buildOnChange,
      },
      {
        type: "confirm",
        name: "testOnBuild",
        message: "Run tests after successful builds:",
        default: settings.general.testOnBuild,
      },
    ]);

    Object.assign(settings.general, answers);
  }
}

async function editUISettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "confirm",
      name: "colorOutput",
      message: "Enable colored output:",
      default: settings.ui.colorOutput,
    },
    {
      type: "confirm",
      name: "progressBars",
      message: "Show progress bars:",
      default: settings.ui.progressBars,
    },
    {
      type: "confirm",
      name: "confirmPrompts",
      message: "Show confirmation prompts:",
      default: settings.ui.confirmPrompts,
    },
    {
      type: "confirm",
      name: "interactiveMode",
      message: "Enable interactive mode by default:",
      default: settings.ui.interactiveMode,
    },
  ]);

  Object.assign(settings.ui, answers);
}

async function editDevelopmentSettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "defaultPythonVersion",
      message: "Default Python version:",
      default: settings.development.defaultPythonVersion,
      choices: ["3.8", "3.9", "3.10", "3.11", "3.12"],
      loop: false,
    },
    {
      type: "select",
      name: "preferredIDE",
      message: "Preferred IDE:",
      default: settings.development.preferredIDE,
      choices: ["vscode", "pycharm", "jupyter", "none"],
      loop: false,
    },
    {
      type: "confirm",
      name: "autoLint",
      message: "Auto-run linting:",
      default: settings.development.autoLint,
    },
    {
      type: "confirm",
      name: "autoFormat",
      message: "Auto-format code:",
      default: settings.development.autoFormat,
    },
  ]);

  Object.assign(settings.development, answers);
}

async function editCloudSettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "confirm",
      name: "syncSettings",
      message: "Sync settings across devices:",
      default: settings.cloud.syncSettings,
    },
  ]);

  if (answers.syncSettings) {
    const cloudAnswers = await inquirer.prompt([
      {
        type: "input",
        name: "defaultRegion",
        message: "Default cloud region:",
        default: settings.cloud.defaultRegion,
      },
      {
        type: "select",
        name: "preferredProvider",
        message: "Preferred cloud provider:",
        default: settings.cloud.preferredProvider,
        choices: ["aws", "azure", "gcp"],
        loop: false,
      },
    ]);

    Object.assign(answers, cloudAnswers);
  }

  Object.assign(settings.cloud, answers);
}

async function editAPISettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "url",
      message: "API URL:",
      default: settings.api.url,
      validate: (input: string) => {
        try {
          new URL(input);
          return true;
        } catch {
          return "Please enter a valid URL";
        }
      },
    },
    {
      type: "input",
      name: "timeout",
      message: "Request timeout (ms):",
      default: settings.api.timeout.toString(),
      validate: (input: string) => {
        const num = Number.parseInt(input, 10);
        return (
          (!Number.isNaN(num) && num >= 1000 && num <= 300_000) ||
          "Timeout must be between 1000 and 300000 ms"
        );
      },
    },
    {
      type: "input",
      name: "retries",
      message: "Retry count:",
      default: settings.api.retries.toString(),
      validate: (input: string) => {
        const num = Number.parseInt(input, 10);
        return (
          (!Number.isNaN(num) && num >= 0 && num <= 10) ||
          "Retries must be between 0 and 10"
        );
      },
    },
  ]);

  // Convert string inputs to numbers
  answers.timeout = Number.parseInt(answers.timeout, 10);
  answers.retries = Number.parseInt(answers.retries, 10);

  Object.assign(settings.api, answers);
}

async function editBuildSettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "defaultArch",
      message: "Default architecture:",
      default: settings.build.defaultArch,
      choices: [
        "cpu",
        "cuda",
        "gpu",
        "transformer",
        "xgboost",
        "resnet",
        "lstm",
        "autoencoder",
      ],
      loop: false,
    },
    {
      type: "confirm",
      name: "enableCache",
      message: "Enable build caching:",
      default: settings.build.enableCache,
    },
    {
      type: "confirm",
      name: "pushOnBuild",
      message: "Auto-push images after build:",
      default: settings.build.pushOnBuild,
    },
    {
      type: "confirm",
      name: "validateBeforeBuild",
      message: "Validate before building:",
      default: settings.build.validateBeforeBuild,
    },
  ]);

  Object.assign(settings.build, answers);
}

async function editTestSettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "confirm",
      name: "runParallel",
      message: "Run tests in parallel:",
      default: settings.test.runParallel,
    },
    {
      type: "confirm",
      name: "failFast",
      message: "Fail fast on first error:",
      default: settings.test.failFast,
    },
    {
      type: "input",
      name: "coverageThreshold",
      message: "Coverage threshold (%):",
      default: settings.test.coverageThreshold.toString(),
      validate: (input: string) => {
        const num = Number.parseFloat(input);
        return (
          (!Number.isNaN(num) && num >= 0 && num <= 100) ||
          "Coverage threshold must be between 0 and 100"
        );
      },
    },
    {
      type: "confirm",
      name: "includeBenchmarks",
      message: "Include performance benchmarks:",
      default: settings.test.includeBenchmarks,
    },
  ]);

  answers.coverageThreshold = Number.parseFloat(answers.coverageThreshold);
  Object.assign(settings.test, answers);
}

async function editDeploymentSettings(settings: any): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "defaultEnvironment",
      message: "Default deployment environment:",
      default: settings.deployment.defaultEnvironment,
      choices: ["development", "staging", "production"],
      loop: false,
    },
    {
      type: "confirm",
      name: "autoRollback",
      message: "Auto-rollback failed deployments:",
      default: settings.deployment.autoRollback,
    },
    {
      type: "input",
      name: "healthCheckTimeout",
      message: "Health check timeout (seconds):",
      default: settings.deployment.healthCheckTimeout.toString(),
      validate: (input: string) => {
        const num = Number.parseInt(input, 10);
        return (
          (!Number.isNaN(num) && num >= 5 && num <= 300) ||
          "Timeout must be between 5 and 300 seconds"
        );
      },
    },
  ]);

  answers.healthCheckTimeout = Number.parseInt(answers.healthCheckTimeout, 10);
  Object.assign(settings.deployment, answers);
}

async function exportSettings(
  filePath: string,
  _scope: "global" | "project",
  options: SettingsOptions
): Promise<void> {
  try {
    const type = options.global
      ? "global"
      : options.project
        ? "project"
        : "combined";
    settingsManager.exportSettings(type, filePath);
    logger.info(
      `${chalk.green("✓")} Settings exported to ${chalk.cyan(filePath)}`
    );
  } catch (error) {
    logger.error(`Failed to export settings: ${error}`);
  }
}

async function importSettings(
  filePath: string,
  _scope: "global" | "project",
  _options: SettingsOptions
): Promise<void> {
  try {
    settingsManager.importSettings(filePath);
    logger.info(
      `${chalk.green("✓")} Settings imported from ${chalk.cyan(filePath)}`
    );
  } catch (error) {
    logger.error(`Failed to import settings: ${error}`);
  }
}

async function applyTemplate(
  templateName: string,
  _options: SettingsOptions
): Promise<void> {
  try {
    const templates = settingsManager.listTemplates();
    const template = templates.find(
      (t) => t.name.toLowerCase() === templateName.toLowerCase()
    );

    if (!template) {
      logger.error(`Template not found: ${templateName}`);
      logger.info("Available templates:");
      templates.forEach((t) => {
        logger.info(`  ${chalk.cyan(t.name)} - ${t.description}`);
      });
      return;
    }

    const confirm = await inquirer.prompt([
      {
        type: "confirm",
        name: "apply",
        message: `Apply template "${template.name}"? This will modify your current settings.`,
        default: false,
      },
    ]);

    if (confirm.apply) {
      settingsManager.applyTemplate(templateName);
      logger.info(
        `${chalk.green("✓")} Applied template: ${chalk.cyan(template.name)}`
      );
    } else {
      logger.info("Template application cancelled");
    }
  } catch (error) {
    logger.error(`Failed to apply template: ${error}`);
  }
}

async function explainSetting(
  key: string,
  options: SettingsOptions
): Promise<void> {
  try {
    const resolution = settingsManager.resolveSettings(key as any);

    if (options.json) {
      console.log(JSON.stringify(resolution, null, 2));
      return;
    }

    console.log();
    logger.info(chalk.bold(`Setting Resolution: ${chalk.cyan(key)}`));
    console.log();

    logger.info(`${chalk.yellow("Current Value")}: ${resolution.value}`);
    logger.info(
      `${chalk.yellow("Source")}: ${resolution.source.type}${resolution.source.file ? ` (${path.basename(resolution.source.file)})` : ""}`
    );

    if (resolution.overriddenBy && resolution.overriddenBy.length > 0) {
      console.log();
      logger.info(chalk.yellow("Resolution Chain:"));
      resolution.overriddenBy.forEach((source, index) => {
        logger.info(
          `  ${index + 1}. ${source.type}${source.file ? ` (${path.basename(source.file)})` : ""}: ${source.value}`
        );
      });
      logger.info(
        `  ${resolution.overriddenBy.length + 1}. ${chalk.green(resolution.source.type)}${resolution.source.file ? ` (${path.basename(resolution.source.file)})` : ""}: ${chalk.green(resolution.value)} ${chalk.dim("← final value")}`
      );
    }

    console.log();
  } catch (error) {
    logger.error(`Failed to explain setting '${key}': ${error}`);
  }
}

async function resetSettings(
  scope: "global" | "project",
  _options: SettingsOptions
): Promise<void> {
  const confirm = await inquirer.prompt([
    {
      type: "confirm",
      name: "reset",
      message: `Reset ${scope} settings to defaults? This cannot be undone.`,
      default: false,
    },
  ]);

  if (!confirm.reset) {
    logger.info("Reset cancelled");
    return;
  }

  try {
    if (scope === "global") {
      const defaults = settingsManager.getDefaultGlobalSettings();
      settingsManager.saveGlobalSettings(defaults);
      logger.info(`${chalk.green("✓")} Global settings reset to defaults`);
    } else {
      const defaults = settingsManager.getDefaultProjectSettings();
      settingsManager.saveProjectSettings(defaults);
      logger.info(`${chalk.green("✓")} Project settings reset to defaults`);
    }
  } catch (error) {
    logger.error(`Failed to reset settings: ${error}`);
  }
}

async function interactiveSettings(
  scope: "global" | "project",
  options: SettingsOptions
): Promise<void> {
  const choices = [
    { name: "List all settings", value: "list" },
    { name: "Edit settings", value: "edit" },
    { name: "Export settings", value: "export" },
    { name: "Import settings", value: "import" },
    { name: "Apply template", value: "template" },
    { name: "Reset to defaults", value: "reset" },
  ];

  const answers = await inquirer.prompt([
    {
      type: "select",
      name: "action",
      message: `What would you like to do with ${scope} settings?`,
      choices,
      loop: false,
    },
  ]);

  switch (answers.action) {
    case "list":
      await listSettings(scope, options);
      break;
    case "edit":
      await editSettings(scope, options);
      break;
    case "export": {
      const exportAnswers = await inquirer.prompt([
        {
          type: "input",
          name: "file",
          message: "Export file path:",
          default: `${scope}-settings.json`,
        },
      ]);
      await exportSettings(exportAnswers.file, scope, options);
      break;
    }
    case "import": {
      const importAnswers = await inquirer.prompt([
        {
          type: "input",
          name: "file",
          message: "Import file path:",
        },
      ]);
      await importSettings(importAnswers.file, scope, options);
      break;
    }
    case "template": {
      const templates = settingsManager.listTemplates();
      const templateAnswers = await inquirer.prompt([
        {
          type: "select",
          name: "template",
          message: "Select template:",
          choices: templates.map((t) => ({
            name: `${t.name} - ${t.description}`,
            value: t.name,
          })),
          loop: false,
        },
      ]);
      await applyTemplate(templateAnswers.template, options);
      break;
    }
    case "reset":
      await resetSettings(scope, options);
      break;
  }
}

// Utility functions
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => {
    if (!(key in current)) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
}

function deleteNestedValue(obj: any, path: string): boolean {
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => current?.[key], obj);

  if (target && lastKey in target) {
    delete target[lastKey];
    return true;
  }
  return false;
}

function parseValue(value: string): any {
  // Try to parse as JSON first
  try {
    return JSON.parse(value);
  } catch {
    // If not JSON, return as string
    return value;
  }
}
