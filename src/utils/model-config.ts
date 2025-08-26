import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import { schemaValidator } from './schema';
import { ModelConfig } from '../types';

export class ModelConfigManager {
  private projectPath: string;
  
  constructor(projectPath: string = process.cwd()) {
    this.projectPath = projectPath;
  }

  async loadModelConfig(): Promise<ModelConfig | null> {
    const configFiles = [
      'model.yaml',
      'model.yml', 
      'model.json'
    ];

    for (const configFile of configFiles) {
      const configPath = path.join(this.projectPath, configFile);
      if (fs.existsSync(configPath)) {
        try {
          const config = await this.loadConfigFromFile(configPath);
          if (config) {
            return config;
          }
        } catch (error) {
          console.warn(`Could not load model config from ${configFile}:`, error);
        }
      }
    }

    // Fallback to cirron.json metadata
    const cirronConfigPath = path.join(this.projectPath, 'cirron.json');
    if (fs.existsSync(cirronConfigPath)) {
      try {
        const cirronConfig = JSON.parse(fs.readFileSync(cirronConfigPath, 'utf8'));
        if (cirronConfig.metadata) {
          return this.convertMetadataToModelConfig(cirronConfig.metadata);
        }
      } catch (error) {
        console.warn('Could not load cirron.json metadata:', error);
      }
    }

    return null;
  }

  async saveModelConfig(config: ModelConfig, format: 'yaml' | 'json' = 'yaml'): Promise<void> {
    const result = schemaValidator.validateModelConfig(config);
    if (!result.valid) {
      throw new Error('Invalid model configuration: ' + result.errors.map(e => e.message).join(', '));
    }

    const fileName = format === 'yaml' ? 'model.yaml' : 'model.json';
    const configPath = path.join(this.projectPath, fileName);
    
    if (format === 'yaml') {
      const yamlContent = yaml.dump(result.data, {
        indent: 2,
        lineWidth: 120,
        noRefs: true
      });
      await fs.writeFile(configPath, yamlContent, 'utf8');
    } else {
      await fs.writeFile(configPath, JSON.stringify(result.data, null, 2), 'utf8');
    }
  }

  private async loadConfigFromFile(configPath: string): Promise<ModelConfig | null> {
    try {
      const content = await fs.readFile(configPath, 'utf8');
      let config: any;
      
      if (configPath.endsWith('.yaml') || configPath.endsWith('.yml')) {
        config = yaml.load(content);
      } else {
        config = JSON.parse(content);
      }

      // Validate the configuration
      const result = schemaValidator.validateModelConfig(config);
      if (result.valid) {
        return result.data!;
      } else {
        console.warn(`Model config validation failed in ${path.basename(configPath)}:`, 
          result.errors.map(e => e.message).join(', '));
        return config; // Return unvalidated config for backwards compatibility
      }
    } catch (error) {
      console.warn(`Could not parse model config file ${configPath}:`, error);
      return null;
    }
  }

  private convertMetadataToModelConfig(metadata: any): ModelConfig {
    return {
      version: 1,
      name: metadata.modelClassName,
      architecture: metadata.architecture,
      inputShape: metadata.inputShape,
      metadata: {
        updated: metadata.lastUpdated,
        description: `Converted from cirron.json metadata`
      }
    };
  }

  getDefaultModelConfig(framework: string = 'pytorch'): ModelConfig {
    const defaults: Record<string, Partial<ModelConfig>> = {
      pytorch: {
        version: 1,
        framework: 'pytorch',
        architecture: 'custom',
        inference: {
          device: 'cpu',
          precision: 'fp32'
        },
        dependencies: {
          python: '>=3.8',
          packages: {
            torch: '>=1.9.0',
            torchvision: '>=0.10.0'
          }
        }
      },
      tensorflow: {
        version: 1,
        framework: 'tensorflow',
        architecture: 'custom',
        inference: {
          device: 'cpu',
          precision: 'fp32'
        },
        dependencies: {
          python: '>=3.8',
          packages: {
            tensorflow: '>=2.6.0'
          }
        }
      },
      sklearn: {
        version: 1,
        framework: 'sklearn',
        architecture: 'ensemble',
        inference: {
          device: 'cpu',
          precision: 'fp32'
        },
        dependencies: {
          python: '>=3.8',
          packages: {
            'scikit-learn': '>=1.0.0',
            numpy: '>=1.21.0',
            pandas: '>=1.3.0'
          }
        }
      }
    };

    return {
      ...defaults[framework] || defaults.pytorch,
      metadata: {
        created: new Date().toISOString(),
        updated: new Date().toISOString()
      }
    } as ModelConfig;
  }

  async findModelConfigFile(): Promise<string | null> {
    const configFiles = ['model.yaml', 'model.yml', 'model.json'];
    
    for (const configFile of configFiles) {
      const configPath = path.join(this.projectPath, configFile);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    
    return null;
  }

  async detectFrameworkFromConfig(): Promise<string | null> {
    const config = await this.loadModelConfig();
    return config?.framework || null;
  }
}

// Export singleton instance
export const modelConfigManager = new ModelConfigManager();