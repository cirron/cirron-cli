/**
 * Unified project configuration loader.
 * Resolves cirron.yaml, cirron.yml, or cirron.json (YAML preferred).
 */
import fs from 'fs-extra';
import path from 'path';
import yaml from 'js-yaml';
import type { ProjectConfig } from '../types';

const CONFIG_FILES = ['cirron.yaml', 'cirron.yml', 'cirron.json'] as const;

export interface ProjectConfigResult {
  /** Absolute path to the config file found */
  configPath: string;
  /** Filename (e.g., "cirron.yaml") */
  filename: string;
  /** Parsed config object */
  config: ProjectConfig;
}

/**
 * Finds and loads the project config from the given directory.
 * Tries cirron.yaml, cirron.yml, cirron.json in order.
 * Returns null if no config file is found.
 */
export function loadProjectConfig(dir?: string): ProjectConfigResult | null {
  const projectDir = dir || process.cwd();

  for (const filename of CONFIG_FILES) {
    const configPath = path.join(projectDir, filename);
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf8');
      const isYaml = filename.endsWith('.yaml') || filename.endsWith('.yml');
      const config = isYaml ? (yaml.load(raw) as ProjectConfig) : JSON.parse(raw);
      return { configPath, filename, config };
    }
  }

  return null;
}

/**
 * Finds the project config path without loading it.
 * Returns the path to the first config file found, or null.
 */
export function findProjectConfigPath(dir?: string): string | null {
  const projectDir = dir || process.cwd();

  for (const filename of CONFIG_FILES) {
    const configPath = path.join(projectDir, filename);
    if (fs.existsSync(configPath)) {
      return configPath;
    }
  }

  return null;
}

/**
 * Saves a config object back to disk.
 * If the original was YAML, saves as YAML. Otherwise JSON.
 */
export function saveProjectConfig(configPath: string, config: ProjectConfig): void {
  const isYaml = configPath.endsWith('.yaml') || configPath.endsWith('.yml');
  if (isYaml) {
    fs.writeFileSync(configPath, yaml.dump(config, { indent: 2, lineWidth: 120, noRefs: true }), 'utf8');
  } else {
    fs.writeJSONSync(configPath, config, { spaces: 2 });
  }
}

/**
 * List of config filenames to check (for use in findProjectRoot, etc.)
 */
export { CONFIG_FILES };
