// src/commands/register.ts
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import { loadProjectConfig } from '../utils/project-config';

interface RegisterOptions {
  name?: string;
  repo?: string;
  path?: string;
  dryRun?: boolean;
}

function deriveAppUrl(apiUrl: string, modelId: string): string {
  try {
    const url = new URL(apiUrl);
    url.hostname = url.hostname.replace(/^api\./, 'app.');
    url.pathname = `/models/${modelId}`;
    return url.toString();
  } catch {
    return '';
  }
}

export async function registerCommand(options: RegisterOptions = {}): Promise<void> {
  // Auth check
  const configManager = new ConfigManager();
  const currentConfig = configManager.load();

  if (!currentConfig.token && !currentConfig.auth?.accessToken) {
    logger.error('Not authenticated');
    logger.info(`Run ${chalk.cyan('cirron auth login')} to authenticate`);
    process.exit(1);
  }

  // Load project config
  const projectConfigResult = loadProjectConfig(options.path);

  if (!projectConfigResult) {
    const searchDir = options.path || 'current directory';
    logger.error(`No cirron config found in ${searchDir} (cirron.yaml, cirron.yml, or cirron.json)`);
    logger.info(`Run ${chalk.cyan('cirron init')} to create a new project, or add a cirron.yaml config file`);
    process.exit(1);
  }

  const { config } = projectConfigResult;

  // Validate required fields
  const projectName = options.name || config.name;
  if (!projectName) {
    logger.error('Project name is required. Set "name" in your config file or use --name flag');
    process.exit(1);
  }

  const template = config.template || config.framework;
  if (!template) {
    logger.error('Project template or framework is required. Set "template" or "framework" in your config file');
    process.exit(1);
  }

  // Build payload
  const payload: Record<string, any> = {
    name: projectName,
    template,
    path: options.path || process.cwd(),
  };

  if (config.framework) payload['framework'] = config.framework;
  if (config.modelType) payload['modelType'] = config.modelType;
  if (config.type) payload['type'] = config.type;
  if (config.servingConfig) payload['servingConfig'] = config.servingConfig;
  if (options.repo) payload['repositoryId'] = options.repo;
  if (options.path) payload['repositoryPath'] = options.path;

  // Dry-run mode
  if (options.dryRun) {
    logger.info(chalk.bold('Dry run - registration payload:'));
    logger.info(JSON.stringify(payload, null, 2));
    return;
  }

  // Register with API
  const spinner = ora('Registering project with Cirron...').start();

  try {
    const api = new CirronApi(currentConfig);
    const result = await api.createProject(payload as any);

    spinner.succeed(chalk.green(`Project "${projectName}" registered successfully`));

    // Show link to model in app
    const modelId = result?.id || result?.modelId;
    if (modelId) {
      const appUrl = deriveAppUrl(currentConfig.apiUrl, modelId);
      if (appUrl) {
        logger.info(`View in app: ${chalk.cyan(appUrl)}`);
      }
    }

    if (config.servingConfig) {
      logger.info('Serving configuration included in registration');
    }

    if (options.repo) {
      logger.info(`Associated with repository: ${chalk.cyan(options.repo)}`);
      if (options.path) {
        logger.info(`Path scope: ${chalk.cyan(options.path)}`);
      }
    }
  } catch (error: any) {
    spinner.fail(chalk.red('Failed to register project'));
    const message = error?.message || error;
    logger.error(`Error: ${message}`);
    process.exit(1);
  }
}
