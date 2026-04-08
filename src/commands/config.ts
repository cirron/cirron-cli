import chalk from 'chalk';
import inquirer from 'inquirer';
import { ConfigManager } from '../utils/config';
import { settingsCommand } from './settings';
import { logger } from '../utils/logger';
import type { ConfigCommandOptions, SettingsOptions } from '../types';

interface CliConfigOptions {
  list?: boolean;
  get?: string;
  set?: string;
  delete?: string;
  reset?: boolean;
}

// Scope-based routing: delegates to cliConfigHandler or settingsCommand
export async function configCommand(options: ConfigCommandOptions): Promise<void> {
  try {
    const scope = determineScope(options);

    // Explicit --cli scope: delegate to CLI config handler
    if (scope === 'cli') {
      const cliOpts: CliConfigOptions = {};
      if (options.list) cliOpts.list = options.list;
      if (options.get) cliOpts.get = options.get;
      if (options.set) cliOpts.set = options.set;
      if (options.delete) cliOpts.delete = options.delete;
      if (options.reset) cliOpts.reset = options.reset;
      return cliConfigHandler(cliOpts);
    }

    // Explicit --global or --project scope: delegate to settings handler
    if (scope === 'global' || scope === 'project') {
      const settingsOpts: SettingsOptions = {};
      if (scope === 'global') settingsOpts.global = true;
      if (scope === 'project') settingsOpts.project = true;
      if (options.list) settingsOpts.list = options.list;
      if (options.get) settingsOpts.get = options.get;
      if (options.set) settingsOpts.set = options.set;
      if (options.delete) settingsOpts.delete = options.delete;
      if (options.edit) settingsOpts.edit = options.edit;
      if (options.export) settingsOpts.export = options.export;
      if (options.import) settingsOpts.import = options.import;
      if (options.template) settingsOpts.template = options.template;
      if (options.explain) settingsOpts.explain = options.explain;
      if (options.reset) settingsOpts.reset = options.reset;
      if (options.verbose) settingsOpts.verbose = options.verbose;
      if (options.json) settingsOpts.json = options.json;
      return settingsCommand(settingsOpts);
    }

    // No scope specified -- behavior depends on operation
    if (options.list) {
      // Show all scopes
      await cliConfigHandler({ list: true });
      await settingsCommand({ list: true });
      return;
    }

    if (options.get) {
      // Walk resolution chain: project > global > cli
      const opts: SettingsOptions = { explain: options.get };
      if (options.json) opts.json = options.json;
      return settingsCommand(opts);
    }

    if (options.set) {
      // Default to project scope
      const opts: SettingsOptions = { project: true, set: options.set };
      if (options.json) opts.json = options.json;
      return settingsCommand(opts);
    }

    if (options.explain) {
      const opts: SettingsOptions = { explain: options.explain };
      if (options.json) opts.json = options.json;
      return settingsCommand(opts);
    }

    if (options.edit) {
      // Show scope selector prompt
      const { selectedScope } = await inquirer.prompt([{
        type: 'select',
        name: 'selectedScope',
        message: 'Which configuration scope would you like to edit?',
        choices: [
          { name: 'CLI Configuration (API URL, timeout, retries)', value: 'cli' },
          { name: 'Global Settings (user preferences)', value: 'global' },
          { name: 'Project Settings (project behavior)', value: 'project' },
        ],
        loop: false,
      }]);

      if (selectedScope === 'cli') {
        return cliConfigHandler({});
      }
      return settingsCommand({
        global: selectedScope === 'global',
        project: selectedScope === 'project',
        edit: true,
      });
    }

    if (options.export || options.import || options.reset || options.delete) {
      logger.error('The --export, --import, --reset, and --delete operations require --scope (cli, global, or project)');
      process.exit(1);
    }

    // No operation specified -- show interactive scope selector
    const { selectedScope } = await inquirer.prompt([{
      type: 'select',
      name: 'selectedScope',
      message: 'Which configuration scope would you like to manage?',
      choices: [
        { name: 'CLI Configuration (API URL, timeout, retries)', value: 'cli' },
        { name: 'Global Settings (user preferences)', value: 'global' },
        { name: 'Project Settings (project behavior)', value: 'project' },
      ],
      loop: false,
    }]);

    if (selectedScope === 'cli') {
      return cliConfigHandler({});
    }
    return settingsCommand({
      global: selectedScope === 'global',
      project: selectedScope === 'project',
    });

  } catch (error) {
    logger.error('Config command failed:', error);
    process.exit(1);
  }
}

const VALID_SCOPES = ['cli', 'global', 'project'] as const;

function determineScope(options: ConfigCommandOptions): 'cli' | 'global' | 'project' | null {
  if (!options.scope) return null;
  if (!VALID_SCOPES.includes(options.scope)) {
    logger.error(`Invalid scope '${options.scope}'. Valid scopes: ${VALID_SCOPES.join(', ')}`);
    process.exit(1);
  }
  return options.scope;
}

// --- CLI config handler (previously configCommand) ---
// Handles CLI-scoped configuration: API URL, timeout, retries

async function cliConfigHandler(options: CliConfigOptions): Promise<void> {
  try {
    const config = new ConfigManager();

    if (options.list) {
      await listConfig(config);
    } else if (options.get) {
      await getConfig(config, options.get);
    } else if (options.set) {
      await setConfig(config, options.set);
    } else if (options.delete) {
      await deleteConfig(config, options.delete);
    } else if (options.reset) {
      await resetConfig(config);
    } else {
      // Interactive mode
      await interactiveConfig(config);
    }

  } catch (error) {
    logger.error('Config command failed:', error);
    process.exit(1);
  }
}

async function listConfig(config: ConfigManager): Promise<void> {
  const currentConfig = config.load();

  console.log();
  logger.info(chalk.bold('Current Configuration'));
  console.log();

  logger.info(`${chalk.cyan('API URL:')} ${currentConfig.apiUrl}`);
  logger.info(`${chalk.cyan('Default Environment:')} ${currentConfig.defaultEnv}`);
  logger.info(`${chalk.cyan('Timeout:')} ${currentConfig.timeout}ms`);
  logger.info(`${chalk.cyan('Retries:')} ${currentConfig.retries}`);

  if (currentConfig.token) {
    logger.info(`${chalk.cyan('Authentication:')} ${chalk.green('✓ Logged in')}`);
  } else {
    logger.info(`${chalk.cyan('Authentication:')} ${chalk.red('✗ Not logged in')}`);
  }
}

async function getConfig(config: ConfigManager, key: string): Promise<void> {
  const currentConfig = config.load();
  const value = getNestedValue(currentConfig, key);

  if (value !== undefined) {
    if (key.toLowerCase().includes('token') && typeof value === 'string') {
      // Mask token for security
      const maskedToken = value.substring(0, 8) + '*'.repeat(value.length - 8);
      logger.info(`${key}: ${maskedToken}`);
    } else {
      logger.info(`${key}: ${value}`);
    }
  } else {
    logger.error(`Configuration key '${key}' not found`);
    process.exit(1);
  }
}

async function setConfig(config: ConfigManager, keyValue: string): Promise<void> {
  const [key, ...valueParts] = keyValue.split('=');
  const value = valueParts.join('='); // Handle values with = signs

  if (!key || value === undefined) {
    logger.error('Invalid format. Use: key=value');
    process.exit(1);
  }

  const currentConfig = config.load();

  // Validate key
  const validKeys = [
    'apiUrl',
    'defaultEnv',
    'timeout',
    'retries'
  ];

  if (!validKeys.includes(key)) {
    logger.error(`Invalid configuration key: ${key}`);
    logger.info('Valid keys:', validKeys.join(', '));
    process.exit(1);
  }

  // Type conversion
  let parsedValue: any = value;
  if (key === 'timeout' || key === 'retries') {
    parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue)) {
      logger.error(`${key} must be a number`);
      process.exit(1);
    }
  }

  // Validation
  if (key === 'apiUrl' && !isValidUrl(value)) {
    logger.error('Invalid URL format');
    process.exit(1);
  }

  if (key === 'defaultEnv' && !['development', 'staging', 'production'].includes(value)) {
    logger.error('defaultEnv must be one of: development, staging, production');
    process.exit(1);
  }

  if (key === 'timeout' && (parsedValue < 1000 || parsedValue > 300000)) {
    logger.error('timeout must be between 1000 and 300000 ms');
    process.exit(1);
  }

  if (key === 'retries' && (parsedValue < 0 || parsedValue > 10)) {
    logger.error('retries must be between 0 and 10');
    process.exit(1);
  }

  // Update config
  setNestedValue(currentConfig, key, parsedValue);
  config.save(currentConfig);

  logger.info(`${chalk.green('✓')} Set ${chalk.cyan(key)} = ${chalk.yellow(value)}`);
}

async function deleteConfig(config: ConfigManager, key: string): Promise<void> {
  const currentConfig = config.load();

  if (key === 'token') {
    delete currentConfig.token;
    config.save(currentConfig);
    logger.info(`${chalk.green('✓')} Cleared authentication token`);
  } else {
    logger.error(`Cannot delete configuration key: ${key}`);
    logger.info('Use ' + chalk.cyan('cirron auth logout') + ' to clear authentication');
    process.exit(1);
  }
}

async function resetConfig(config: ConfigManager): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'confirm',
      message: 'Reset all configuration to defaults?',
      default: false
    }
  ]);

  if (!answers.confirm) {
    logger.info('Reset cancelled');
    return;
  }

  config.reset();
  logger.info(`${chalk.green('✓')} Configuration reset to defaults`);
}

async function interactiveConfig(config: ConfigManager): Promise<void> {
  const currentConfig = config.load();

  const answers = await inquirer.prompt([
    {
      type: 'select',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'View current configuration', value: 'list' },
        { name: 'Update API URL', value: 'apiUrl' },
        { name: 'Change default environment', value: 'defaultEnv' },
        { name: 'Set request timeout', value: 'timeout' },
        { name: 'Set retry count', value: 'retries' },
        { name: 'Reset to defaults', value: 'reset' }
      ],
      loop: false,
    }
  ]);

  switch (answers.action) {
    case 'list':
      await listConfig(config);
      break;

    case 'apiUrl':
      const urlAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: 'Enter API URL:',
          default: currentConfig.apiUrl,
          validate: (input: string) => {
            return isValidUrl(input) || 'Please enter a valid URL';
          }
        }
      ]);
      await setConfig(config, `apiUrl=${urlAnswer.value}`);
      break;

    case 'defaultEnv':
      const envAnswer = await inquirer.prompt([
        {
          type: 'select',
          name: 'value',
          message: 'Select default environment:',
          default: currentConfig.defaultEnv,
          choices: ['development', 'staging', 'production'],
          loop: false,
        }
      ]);
      await setConfig(config, `defaultEnv=${envAnswer.value}`);
      break;

    case 'timeout':
      const timeoutAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: 'Enter timeout (ms):',
          default: currentConfig.timeout.toString(),
          validate: (input: string) => {
            const num = parseInt(input, 10);
            return (!isNaN(num) && num >= 1000 && num <= 300000) ||
                   'Timeout must be between 1000 and 300000 ms';
          }
        }
      ]);
      await setConfig(config, `timeout=${timeoutAnswer.value}`);
      break;

    case 'retries':
      const retryAnswer = await inquirer.prompt([
        {
          type: 'input',
          name: 'value',
          message: 'Enter retry count:',
          default: currentConfig.retries.toString(),
          validate: (input: string) => {
            const num = parseInt(input, 10);
            return (!isNaN(num) && num >= 0 && num <= 10) ||
                   'Retries must be between 0 and 10';
          }
        }
      ]);
      await setConfig(config, `retries=${retryAnswer.value}`);
      break;

    case 'reset':
      await resetConfig(config);
      break;
  }
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split('.');
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => {
    if (!(key in current)) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
}

function isValidUrl(string: string): boolean {
  try {
    new URL(string);
    return true;
  } catch {
    return false;
  }
}
