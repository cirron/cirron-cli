import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { load as loadYaml } from "js-yaml";
import type {
  CirronConfig,
  GlobalSettings,
  ProjectConfig,
  ProjectSettings,
  SettingsExport,
  SettingsResolution,
  SettingsSource,
  SettingsTemplate,
} from "../types";
import { ConfigManager } from "./config";
import { schemaValidator } from "./schema";

export class SettingsManager {
  private readonly globalSettingsPath: string;
  private readonly configManager: ConfigManager;

  constructor() {
    const configDir = path.join(os.homedir(), ".cirron");
    this.globalSettingsPath = path.join(configDir, "settings.json");
    this.configManager = new ConfigManager();
  }

  // Global settings methods
  loadGlobalSettings(): GlobalSettings {
    try {
      if (fs.existsSync(this.globalSettingsPath)) {
        const settingsData = fs.readFileSync(this.globalSettingsPath, "utf8");
        const settings = JSON.parse(settingsData);

        // Validate and migrate if necessary
        const result = schemaValidator.validateGlobalSettings(settings);
        if (!result.valid) {
          console.warn(
            "Global settings validation failed, using defaults:",
            result.errors.map((e) => e.message).join(", ")
          );
          return this.getDefaultGlobalSettings();
        }

        // Handle version migration
        if (settings.version !== 1) {
          return schemaValidator.migrateGlobalSettings(
            settings,
            settings.version || 0,
            1
          );
        }

        return result.data!;
      }
    } catch (error) {
      console.warn("Could not load global settings, using defaults:", error);
    }

    return this.getDefaultGlobalSettings();
  }

  saveGlobalSettings(settings: GlobalSettings): void {
    try {
      const result = schemaValidator.validateGlobalSettings(settings);
      if (!result.valid) {
        throw new Error(
          "Invalid global settings: " +
            result.errors.map((e) => e.message).join(", ")
        );
      }

      const configDir = path.dirname(this.globalSettingsPath);
      fs.ensureDirSync(configDir);
      fs.writeFileSync(
        this.globalSettingsPath,
        JSON.stringify(result.data, null, 2)
      );
    } catch (error) {
      throw new Error(`Failed to save global settings: ${error}`);
    }
  }

  getDefaultGlobalSettings(): GlobalSettings {
    return schemaValidator.getDefaultGlobalSettings();
  }

  // Project settings methods
  loadProjectSettings(projectPath?: string): ProjectSettings | null {
    const projectRoot = this.findProjectRoot(projectPath);
    if (!projectRoot) {
      return null;
    }

    // Try multiple config file formats (YAML preferred)
    const configFiles = [
      "cirron.yaml",
      "cirron.yml",
      "cirron.json",
      ".cirronrc",
      ".cirronrc.json",
      ".cirronrc.yaml",
      ".cirronrc.yml",
    ];

    for (const configFile of configFiles) {
      const configPath = path.join(projectRoot, configFile);
      if (fs.existsSync(configPath)) {
        try {
          const config = this.loadProjectConfig(configPath);
          if (config?.settings) {
            const result = schemaValidator.validateProjectSettings(
              config.settings
            );
            if (result.valid) {
              return result.data!;
            }
            console.warn(
              `Project settings validation failed in ${configFile}:`,
              result.errors.map((e) => e.message).join(", ")
            );
          }
        } catch (error) {
          console.warn(
            `Could not load project config from ${configFile}:`,
            error
          );
        }
      }
    }

    return null;
  }

  saveProjectSettings(settings: ProjectSettings, projectPath?: string): void {
    const projectRoot = this.findProjectRoot(projectPath);
    if (!projectRoot) {
      throw new Error("Not in a Cirron project directory");
    }

    const result = schemaValidator.validateProjectSettings(settings);
    if (!result.valid) {
      throw new Error(
        "Invalid project settings: " +
          result.errors.map((e) => e.message).join(", ")
      );
    }

    const configPath = path.join(projectRoot, "cirron.json");
    let config: ProjectConfig;

    try {
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      } else {
        throw new Error("Project configuration not found");
      }
    } catch (error) {
      throw new Error(`Could not load project configuration: ${error}`);
    }

    config.settings = result.data!;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  }

  getDefaultProjectSettings(): ProjectSettings {
    return schemaValidator.getDefaultProjectSettings();
  }

  // Settings resolution with inheritance
  resolveSettings<T extends keyof (GlobalSettings & ProjectSettings)>(
    key: T,
    cliValue?: any,
    projectPath?: string
  ): SettingsResolution {
    const sources: SettingsSource[] = [];

    // 1. Default values
    const defaultGlobal = this.getDefaultGlobalSettings();
    const defaultProject = this.getDefaultProjectSettings();
    const defaultValue =
      this.getNestedValue(defaultGlobal, key) ??
      this.getNestedValue(defaultProject, key);

    sources.push({
      type: "default",
      value: defaultValue,
    });

    // 2. Global settings
    const globalSettings = this.loadGlobalSettings();
    const globalValue = this.getNestedValue(globalSettings, key);
    if (globalValue !== undefined) {
      sources.push({
        type: "global",
        file: this.globalSettingsPath,
        value: globalValue,
      });
    }

    // 3. Project settings
    const projectSettings = this.loadProjectSettings(projectPath);
    if (projectSettings) {
      const projectValue = this.getNestedValue(projectSettings, key);
      if (projectValue !== undefined) {
        const projectRoot = this.findProjectRoot(projectPath);
        if (projectRoot) {
          sources.push({
            type: "project",
            file: path.join(projectRoot, "cirron.json"),
            value: projectValue,
          });
        }
      }
    }

    // 4. CLI arguments
    if (cliValue !== undefined) {
      sources.push({
        type: "cli",
        value: cliValue,
      });
    }

    // Return the highest precedence value
    const finalSource = sources[sources.length - 1];
    if (!finalSource) {
      throw new Error(`No source found for setting: ${key}`);
    }

    const overriddenBy = sources.slice(0, -1);

    const result: SettingsResolution = {
      key: key as string,
      value: finalSource.value,
      source: finalSource,
    };

    if (overriddenBy.length > 0) {
      result.overriddenBy = overriddenBy;
    }

    return result;
  }

  // Settings export/import
  exportSettings(
    type: "global" | "project" | "combined",
    filePath: string,
    projectPath?: string,
    metadata?: { description?: string; tags?: string[] }
  ): void {
    const exportData: SettingsExport = {
      version: 1,
      timestamp: new Date().toISOString(),
      type,
      metadata: {
        exportedBy: os.userInfo().username,
        ...metadata,
      },
    };

    if (type === "global" || type === "combined") {
      exportData.globalSettings = this.loadGlobalSettings();
    }

    if (type === "project" || type === "combined") {
      const projectSettings = this.loadProjectSettings(projectPath);
      if (projectSettings) {
        exportData.projectSettings = projectSettings;
      } else if (type === "project") {
        throw new Error("No project settings found");
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
  }

  importSettings(filePath: string, projectPath?: string): void {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Settings file not found: ${filePath}`);
    }

    const exportData: SettingsExport = JSON.parse(
      fs.readFileSync(filePath, "utf8")
    );

    if (exportData.globalSettings) {
      this.saveGlobalSettings(exportData.globalSettings);
    }

    if (exportData.projectSettings) {
      this.saveProjectSettings(exportData.projectSettings, projectPath);
    }
  }

  // Settings templates
  applyTemplate(templateName: string, projectPath?: string): void {
    const template = this.getTemplate(templateName);
    if (!template) {
      throw new Error(`Template not found: ${templateName}`);
    }

    if (template.globalSettings) {
      const current = this.loadGlobalSettings();
      const merged = this.mergeSettings(current, template.globalSettings);
      this.saveGlobalSettings(merged);
    }

    if (template.projectSettings) {
      const current =
        this.loadProjectSettings(projectPath) ||
        this.getDefaultProjectSettings();
      const merged = this.mergeSettings(current, template.projectSettings);
      this.saveProjectSettings(merged, projectPath);
    }
  }

  getTemplate(name: string): SettingsTemplate | undefined {
    const templates: Record<string, SettingsTemplate> = {
      "ml-team": {
        name: "ML Team",
        description: "Settings optimized for ML team collaboration",
        category: "ml",
        globalSettings: {
          development: {
            defaultPythonVersion: "3.9",
            preferredIDE: "vscode",
            autoLint: true,
            autoFormat: true,
          },
          ui: {
            interactiveMode: true,
            confirmPrompts: true,
            colorOutput: true,
            progressBars: true,
          },
        },
        projectSettings: {
          build: {
            validateBeforeBuild: true,
            enableCache: true,
            pushOnBuild: false,
            defaultArch: "cpu",
          },
          test: {
            runParallel: true,
            failFast: false,
            coverageThreshold: 85,
            includeBenchmarks: true,
          },
        },
      },
      production: {
        name: "Production",
        description: "Settings optimized for production deployments",
        category: "general",
        projectSettings: {
          build: {
            validateBeforeBuild: true,
            enableCache: true,
            pushOnBuild: true,
            defaultArch: "gpu",
          },
          test: {
            runParallel: true,
            failFast: true,
            coverageThreshold: 90,
            includeBenchmarks: true,
          },
          deployment: {
            defaultEnvironment: "production",
            autoRollback: true,
            healthCheckTimeout: 120,
          },
        },
      },
    };

    return templates[name];
  }

  listTemplates(): SettingsTemplate[] {
    return Object.values(["ml-team", "production"]).map(
      (name) => this.getTemplate(name)!
    );
  }

  // Backward compatibility with ConfigManager
  loadLegacyConfig(): CirronConfig {
    return this.configManager.load();
  }

  saveLegacyConfig(config: CirronConfig): void {
    this.configManager.save(config);
  }

  // Utility methods
  findProjectRoot(startPath?: string): string | null {
    let currentPath = startPath || process.cwd();

    while (currentPath !== path.dirname(currentPath)) {
      const configFiles = [
        "cirron.yaml",
        "cirron.yml",
        "cirron.json",
        ".cirronrc",
        ".cirronrc.json",
        ".cirronrc.yaml",
        ".cirronrc.yml",
      ];

      for (const configFile of configFiles) {
        if (fs.existsSync(path.join(currentPath, configFile))) {
          return currentPath;
        }
      }

      currentPath = path.dirname(currentPath);
    }

    return null;
  }

  private loadProjectConfig(configPath: string): ProjectConfig | null {
    try {
      const content = fs.readFileSync(configPath, "utf8");

      if (configPath.endsWith(".yaml") || configPath.endsWith(".yml")) {
        return loadYaml(content) as ProjectConfig;
      }
      return JSON.parse(content) as ProjectConfig;
    } catch (error) {
      console.warn(`Could not parse config file ${configPath}:`, error);
      return null;
    }
  }

  private getNestedValue(obj: any, path: string): any {
    return path.split(".").reduce((current, key) => current?.[key], obj);
  }

  private mergeSettings<T>(target: T, source: Partial<T>): T {
    const result = { ...target };

    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) {
        if (typeof value === "object" && !Array.isArray(value)) {
          (result as any)[key] = this.mergeSettings(
            (result as any)[key] || {},
            value
          );
        } else {
          (result as any)[key] = value;
        }
      }
    }

    return result;
  }
}

export const settingsManager = new SettingsManager();
