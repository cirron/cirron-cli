/**
 * JSON Schema validation for the settings files.
 *
 * Validates global and project settings against the schemas in `src/schemas/`
 * using Ajv, returning structured errors rather than throwing. Also owns the
 * version-stamping entry points that a future schema change would grow into
 * real migrations.
 */

import Ajv from "ajv";
import addFormats from "ajv-formats";
import globalSettingsSchema from "../schemas/global-settings.json";
import modelConfigSchema from "../schemas/model-config.json";
import projectSettingsSchema from "../schemas/project-settings.json";
import type {
  GlobalSettings,
  ModelConfig,
  ProjectSettings,
  SettingsValidationError,
} from "../types";

export class SchemaValidator {
  private readonly ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({
      allErrors: true,
      verbose: true,
      useDefaults: true,
      removeAdditional: true,
    });
    addFormats(this.ajv);

    // Add schemas
    this.ajv.addSchema(globalSettingsSchema, "global-settings");
    this.ajv.addSchema(projectSettingsSchema, "project-settings");
    this.ajv.addSchema(modelConfigSchema, "model-config");
  }

  validateGlobalSettings(settings: unknown): {
    valid: boolean;
    errors: SettingsValidationError[];
    data?: GlobalSettings;
  } {
    const validate = this.ajv.getSchema("global-settings");
    if (!validate) {
      throw new Error("Global settings schema not found");
    }

    const valid = validate(settings);
    const errors = this.formatErrors(validate.errors || []);

    if (valid) {
      return {
        valid: true,
        errors,
        data: settings as GlobalSettings,
      };
    }
    return {
      valid: false,
      errors,
    };
  }

  validateProjectSettings(settings: unknown): {
    valid: boolean;
    errors: SettingsValidationError[];
    data?: ProjectSettings;
  } {
    const validate = this.ajv.getSchema("project-settings");
    if (!validate) {
      throw new Error("Project settings schema not found");
    }

    const valid = validate(settings);
    const errors = this.formatErrors(validate.errors || []);

    if (valid) {
      return {
        valid: true,
        errors,
        data: settings as ProjectSettings,
      };
    }
    return {
      valid: false,
      errors,
    };
  }

  validateModelConfig(config: unknown): {
    valid: boolean;
    errors: SettingsValidationError[];
    data?: ModelConfig;
  } {
    const validate = this.ajv.getSchema("model-config");
    if (!validate) {
      throw new Error("Model config schema not found");
    }

    const valid = validate(config);
    const errors = this.formatErrors(validate.errors || []);

    if (valid) {
      return {
        valid: true,
        errors,
        data: config as ModelConfig,
      };
    }
    return {
      valid: false,
      errors,
    };
  }

  getDefaultGlobalSettings(): GlobalSettings {
    const defaults = {
      version: 1,
      general: {
        defaultTemplate: "pytorch",
        autoUpdate: true,
        telemetry: false,
        verboseLogging: false,
      },
      ui: {
        colorOutput: true,
        progressBars: true,
        confirmPrompts: true,
        interactiveMode: false,
      },
      development: {
        defaultPythonVersion: "3.9",
        preferredIDE: "vscode" as const,
        autoLint: true,
        autoFormat: false,
      },
      cloud: {
        syncSettings: false,
      },
      api: {
        url: "https://app.cirron.com",
        timeout: 30_000,
        retries: 3,
      },
    };

    // Validate defaults
    const result = this.validateGlobalSettings(defaults);
    if (!result.valid) {
      throw new Error(
        "Default global settings are invalid: " +
          result.errors.map((e) => e.message).join(", ")
      );
    }

    return result.data!;
  }

  getDefaultProjectSettings(): ProjectSettings {
    const defaults = {
      version: 1,
      general: {
        autoSave: true,
        buildOnChange: false,
        testOnBuild: true,
      },
      build: {
        defaultArch: "cpu",
        enableCache: true,
        pushOnBuild: false,
        validateBeforeBuild: true,
      },
      test: {
        runParallel: true,
        failFast: false,
        coverageThreshold: 80,
        includeBenchmarks: false,
      },
      deployment: {
        defaultEnvironment: "development" as const,
        autoRollback: true,
        healthCheckTimeout: 60,
      },
    };

    // Validate defaults
    const result = this.validateProjectSettings(defaults);
    if (!result.valid) {
      throw new Error(
        "Default project settings are invalid: " +
          result.errors.map((e) => e.message).join(", ")
      );
    }

    return result.data!;
  }

  private formatErrors(errors: any[]): SettingsValidationError[] {
    return errors.map((error) => ({
      path: error.instancePath || error.dataPath || "root",
      message: error.message || "Validation error",
      value: error.data,
      schema: error.schema,
    }));
  }

  /**
   * Stamp global settings with `toVersion` and validate them against the
   * current schema.
   *
   * Only schema version 1 exists, so there is no field-shape migration to
   * perform: this restamps and validates. The source version is accepted but
   * unread — hence `_fromVersion` — for the call sites that already thread it
   * through and for the per-version branching a future bump will need.
   */
  migrateGlobalSettings(
    settings: any,
    _fromVersion: number,
    toVersion = 1
  ): GlobalSettings {
    const migrated = { ...settings, version: toVersion };

    const result = this.validateGlobalSettings(migrated);
    if (!result.valid) {
      throw new Error(
        `Migration failed: ${result.errors.map((e) => e.message).join(", ")}`
      );
    }

    return result.data!;
  }

  /**
   * Stamp project settings with `toVersion` and validate them against the
   * current schema. See `migrateGlobalSettings` — same single-version story.
   */
  migrateProjectSettings(
    settings: any,
    _fromVersion: number,
    toVersion = 1
  ): ProjectSettings {
    const migrated = { ...settings, version: toVersion };

    const result = this.validateProjectSettings(migrated);
    if (!result.valid) {
      throw new Error(
        `Migration failed: ${result.errors.map((e) => e.message).join(", ")}`
      );
    }

    return result.data!;
  }
}

export const schemaValidator = new SchemaValidator();
