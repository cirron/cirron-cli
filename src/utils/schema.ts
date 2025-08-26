import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { GlobalSettings, ProjectSettings, SettingsValidationError, ModelConfig } from '../types';
import globalSettingsSchema from '../schemas/global-settings.json';
import projectSettingsSchema from '../schemas/project-settings.json';
import modelConfigSchema from '../schemas/model-config.json';

export class SchemaValidator {
  private ajv: Ajv;

  constructor() {
    this.ajv = new Ajv({ 
      allErrors: true, 
      verbose: true,
      useDefaults: true,
      removeAdditional: true
    });
    addFormats(this.ajv);
    
    // Add schemas
    this.ajv.addSchema(globalSettingsSchema, 'global-settings');
    this.ajv.addSchema(projectSettingsSchema, 'project-settings');
    this.ajv.addSchema(modelConfigSchema, 'model-config');
  }

  validateGlobalSettings(settings: unknown): { valid: boolean; errors: SettingsValidationError[]; data?: GlobalSettings } {
    const validate = this.ajv.getSchema('global-settings');
    if (!validate) {
      throw new Error('Global settings schema not found');
    }

    const valid = validate(settings);
    const errors = this.formatErrors(validate.errors || []);
    
    if (valid) {
      return {
        valid: true,
        errors,
        data: settings as GlobalSettings
      };
    } else {
      return {
        valid: false,
        errors
      };
    }
  }

  validateProjectSettings(settings: unknown): { valid: boolean; errors: SettingsValidationError[]; data?: ProjectSettings } {
    const validate = this.ajv.getSchema('project-settings');
    if (!validate) {
      throw new Error('Project settings schema not found');
    }

    const valid = validate(settings);
    const errors = this.formatErrors(validate.errors || []);
    
    if (valid) {
      return {
        valid: true,
        errors,
        data: settings as ProjectSettings
      };
    } else {
      return {
        valid: false,
        errors
      };
    }
  }

  validateModelConfig(config: unknown): { valid: boolean; errors: SettingsValidationError[]; data?: ModelConfig } {
    const validate = this.ajv.getSchema('model-config');
    if (!validate) {
      throw new Error('Model config schema not found');
    }

    const valid = validate(config);
    const errors = this.formatErrors(validate.errors || []);
    
    if (valid) {
      return {
        valid: true,
        errors,
        data: config as ModelConfig
      };
    } else {
      return {
        valid: false,
        errors
      };
    }
  }

  getDefaultGlobalSettings(): GlobalSettings {
    const defaults = {
      version: 1,
      general: {
        defaultTemplate: 'pytorch',
        autoUpdate: true,
        telemetry: false,
        verboseLogging: false
      },
      ui: {
        colorOutput: true,
        progressBars: true,
        confirmPrompts: true,
        interactiveMode: false
      },
      development: {
        defaultPythonVersion: '3.9',
        preferredIDE: 'vscode' as const,
        autoLint: true,
        autoFormat: false
      },
      cloud: {
        syncSettings: false
      },
      api: {
        url: 'https://api.cirron.com',
        timeout: 30000,
        retries: 3
      }
    };

    // Validate defaults
    const result = this.validateGlobalSettings(defaults);
    if (!result.valid) {
      throw new Error('Default global settings are invalid: ' + result.errors.map(e => e.message).join(', '));
    }

    return result.data!;
  }

  getDefaultProjectSettings(): ProjectSettings {
    const defaults = {
      version: 1,
      general: {
        autoSave: true,
        buildOnChange: false,
        testOnBuild: true
      },
      build: {
        defaultArch: 'cpu',
        enableCache: true,
        pushOnBuild: false,
        validateBeforeBuild: true
      },
      test: {
        runParallel: true,
        failFast: false,
        coverageThreshold: 80,
        includeBenchmarks: false
      },
      deployment: {
        defaultEnvironment: 'development' as const,
        autoRollback: true,
        healthCheckTimeout: 60
      }
    };

    // Validate defaults
    const result = this.validateProjectSettings(defaults);
    if (!result.valid) {
      throw new Error('Default project settings are invalid: ' + result.errors.map(e => e.message).join(', '));
    }

    return result.data!;
  }

  private formatErrors(errors: any[]): SettingsValidationError[] {
    return errors.map(error => ({
      path: error.instancePath || error.dataPath || 'root',
      message: error.message || 'Validation error',
      value: error.data,
      schema: error.schema
    }));
  }

  migrateGlobalSettings(settings: any, _fromVersion: number, toVersion: number = 1): GlobalSettings {
    // For now, just ensure we have the current structure
    // Future versions can implement migration logic here
    const migrated = { ...settings, version: toVersion };
    
    const result = this.validateGlobalSettings(migrated);
    if (!result.valid) {
      throw new Error('Migration failed: ' + result.errors.map(e => e.message).join(', '));
    }
    
    return result.data!;
  }

  migrateProjectSettings(settings: any, _fromVersion: number, toVersion: number = 1): ProjectSettings {
    // For now, just ensure we have the current structure
    // Future versions can implement migration logic here
    const migrated = { ...settings, version: toVersion };
    
    const result = this.validateProjectSettings(migrated);
    if (!result.valid) {
      throw new Error('Migration failed: ' + result.errors.map(e => e.message).join(', '));
    }
    
    return result.data!;
  }
}

export const schemaValidator = new SchemaValidator();