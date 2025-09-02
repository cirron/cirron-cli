// src/commands/list.ts
import chalk from 'chalk';
import ora from 'ora';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import Table from 'cli-table3';

interface ListOptions {
  json?: boolean;
  limit?: number;
  filter?: string;
  all?: boolean;
}

// Main list command delegator
export async function listCommand(resource: string, options: ListOptions): Promise<void> {
  const resources = ['deployments', 'builds', 'models', 'images', 'registry'];
  
  if (!resource) {
    logger.error('Please specify a resource to list');
    logger.info(`Available resources: ${resources.join(', ')}`);
    logger.info(`Example: ${chalk.cyan('cirron list deployments')}`);
    return;
  }

  if (!resources.includes(resource)) {
    logger.error(`Unknown resource: ${resource}`);
    logger.info(`Available resources: ${resources.join(', ')}`);
    return;
  }

  // Check authentication
  const config = new ConfigManager();
  const currentConfig = config.load();
  
  if (!currentConfig.token && !currentConfig.auth?.accessToken) {
    logger.error('Not authenticated');
    logger.info(`Run ${chalk.cyan('cirron auth login')} to authenticate`);
    return;
  }

  const api = new CirronApi(currentConfig);

  switch (resource) {
    case 'deployments':
      await listDeployments(api, options);
      break;
    case 'builds':
      await listBuilds(api, options);
      break;
    case 'models':
      await listModels(api, options);
      break;
    case 'images':
      await listImages(api, options);
      break;
    case 'registry':
      await listRegistry(api, options);
      break;
  }
}

// List deployments
async function listDeployments(api: CirronApi, options: ListOptions): Promise<void> {
  const spinner = ora('Fetching deployments...').start();
  
  try {
    const deployments = await api.getDeploymentExecutions({
      limit: options.limit || 20
    });

    spinner.succeed('Deployments fetched');

    if (options.json) {
      console.log(JSON.stringify(deployments, null, 2));
      return;
    }

    if (!deployments || deployments.length === 0) {
      logger.info('No deployments found');
      return;
    }

    const table = new Table({
      head: ['ID', 'Model', 'Version', 'Status', 'Environment', 'Created At'],
      colWidths: [15, 20, 10, 12, 15, 25]
    });

    deployments.forEach((deployment: any) => {
      const statusColor = deployment.status === 'COMPLETED' ? chalk.green :
                         deployment.status === 'FAILED' ? chalk.red :
                         deployment.status === 'IN_PROGRESS' ? chalk.yellow :
                         chalk.gray;

      table.push([
        deployment.id.substring(0, 12) + '...',
        deployment.deployment?.modelInstance?.name || 'N/A',
        deployment.deployment?.modelInstance?.version || 'N/A',
        statusColor(deployment.status),
        deployment.environment || 'production',
        new Date(deployment.createdAt).toLocaleString()
      ]);
    });

    console.log(table.toString());
    
    if (!options.all && deployments.length === (options.limit || 20)) {
      logger.info(chalk.gray(`Showing first ${options.limit || 20} deployments. Use --all to see more.`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch deployments');
    logger.error('Error:', error);
  }
}

// List builds
async function listBuilds(api: CirronApi, options: ListOptions): Promise<void> {
  const spinner = ora('Fetching builds...').start();
  
  try {
    const builds = await api.getBuilds({
      limit: options.limit || 20
    });

    spinner.succeed('Builds fetched');

    if (options.json) {
      console.log(JSON.stringify(builds, null, 2));
      return;
    }

    if (!builds || builds.length === 0) {
      logger.info('No builds found');
      return;
    }

    const table = new Table({
      head: ['Build ID', 'Project', 'Status', 'Duration', 'Created At'],
      colWidths: [15, 25, 12, 12, 25]
    });

    builds.forEach((build: any) => {
      const statusColor = build.status === 'SUCCESS' ? chalk.green :
                         build.status === 'FAILED' ? chalk.red :
                         build.status === 'IN_PROGRESS' ? chalk.yellow :
                         chalk.gray;

      const duration = build.completedAt && build.createdAt ? 
        `${Math.round((new Date(build.completedAt).getTime() - new Date(build.createdAt).getTime()) / 1000)}s` :
        'N/A';

      table.push([
        build.id.substring(0, 12) + '...',
        build.projectName || 'N/A',
        statusColor(build.status),
        duration,
        new Date(build.createdAt).toLocaleString()
      ]);
    });

    console.log(table.toString());
    
    if (!options.all && builds.length === (options.limit || 20)) {
      logger.info(chalk.gray(`Showing first ${options.limit || 20} builds. Use --all to see more.`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch builds');
    logger.error('Error:', error);
  }
}

// List models
async function listModels(api: CirronApi, options: ListOptions): Promise<void> {
  const spinner = ora('Fetching models...').start();
  
  try {
    const models = await api.getModelInstances({
      limit: options.limit || 20
    });

    spinner.succeed('Models fetched');

    if (options.json) {
      console.log(JSON.stringify(models, null, 2));
      return;
    }

    if (!models || models.length === 0) {
      logger.info('No models found');
      return;
    }

    const table = new Table({
      head: ['Model ID', 'Name', 'Version', 'Type', 'Status', 'Endpoint'],
      colWidths: [15, 25, 10, 15, 12, 30]
    });

    models.forEach((model: any) => {
      const statusColor = model.status === 'ACTIVE' ? chalk.green :
                         model.status === 'FAILED' ? chalk.red :
                         model.status === 'DEPLOYING' ? chalk.yellow :
                         chalk.gray;

      table.push([
        model.id.substring(0, 12) + '...',
        model.modelInstance?.name || model.name || 'N/A',
        model.modelInstance?.version || model.version || 'N/A',
        model.modelInstance?.model?.type || model.type || 'N/A',
        statusColor(model.status || 'UNKNOWN'),
        model.endpoint || 'Not deployed'
      ]);
    });

    console.log(table.toString());
    
    if (!options.all && models.length === (options.limit || 20)) {
      logger.info(chalk.gray(`Showing first ${options.limit || 20} models. Use --all to see more.`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch models');
    logger.error('Error:', error);
  }
}

// List images
async function listImages(api: CirronApi, options: ListOptions): Promise<void> {
  const spinner = ora('Fetching images...').start();
  
  try {
    const images = await api.getModelImages({
      limit: options.limit || 20
    });

    spinner.succeed('Images fetched');

    if (options.json) {
      console.log(JSON.stringify(images, null, 2));
      return;
    }

    if (!images || images.length === 0) {
      logger.info('No images found');
      return;
    }

    const table = new Table({
      head: ['Image ID', 'Name', 'Tag', 'Size', 'Created At'],
      colWidths: [15, 30, 15, 12, 25]
    });

    images.forEach((image: any) => {
      const size = image.size ? `${(image.size / (1024 * 1024)).toFixed(2)} MB` : 'N/A';

      table.push([
        image.id.substring(0, 12) + '...',
        image.name || image.repository || 'N/A',
        image.tag || 'latest',
        size,
        new Date(image.createdAt).toLocaleString()
      ]);
    });

    console.log(table.toString());
    
    if (!options.all && images.length === (options.limit || 20)) {
      logger.info(chalk.gray(`Showing first ${options.limit || 20} images. Use --all to see more.`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch images');
    logger.error('Error:', error);
  }
}

// List registry artifacts
async function listRegistry(api: CirronApi, options: ListOptions): Promise<void> {
  const spinner = ora('Fetching registry artifacts...').start();
  
  try {
    const artifacts = await api.getRegistryArtifacts({
      limit: options.limit || 20,
      ...(options.filter && { type: options.filter })
    });

    spinner.succeed('Registry artifacts fetched');

    if (options.json) {
      console.log(JSON.stringify(artifacts, null, 2));
      return;
    }

    if (!artifacts || artifacts.length === 0) {
      logger.info('No registry artifacts found');
      return;
    }

    const table = new Table({
      head: ['Artifact ID', 'Name', 'Type', 'Version', 'Pipeline', 'Created At'],
      colWidths: [15, 25, 15, 10, 20, 25]
    });

    artifacts.forEach((artifact: any) => {
      table.push([
        artifact.id.substring(0, 12) + '...',
        artifact.name || 'N/A',
        artifact.type || 'N/A',
        artifact.version || 'N/A',
        artifact.pipeline?.name || 'N/A',
        new Date(artifact.createdAt).toLocaleString()
      ]);
    });

    console.log(table.toString());
    
    if (!options.all && artifacts.length === (options.limit || 20)) {
      logger.info(chalk.gray(`Showing first ${options.limit || 20} artifacts. Use --all to see more.`));
    }
  } catch (error) {
    spinner.fail('Failed to fetch registry artifacts');
    logger.error('Error:', error);
  }
}

// Export individual list functions for direct use
export {
  listDeployments,
  listBuilds,
  listModels,
  listImages,
  listRegistry
};