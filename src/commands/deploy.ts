import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import { buildCommand } from './build';
import { loadProjectConfig } from '../utils/project-config';
import type { DeployOptions, ProjectConfig, DeploymentInfo } from '../types';

export async function deployCommand(options: DeployOptions): Promise<void> {
  const spinner = ora('Preparing deployment...').start();

  try {
    // Load project configuration
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(chalk.red('No cirron config found (cirron.yaml or cirron.json)'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const { config: projectConfig } = projectConfigResult;
    
    // Check authentication
    const config = new ConfigManager();
    const currentConfig = config.load();
    
    if (!currentConfig.token) {
      spinner.fail(chalk.red('Not authenticated'));
      logger.error('Run ' + chalk.cyan('cirron auth login') + ' to authenticate');
      process.exit(1);
    }

    const api = new CirronApi(currentConfig);

    // Validate environment
    const envConfig = projectConfig.environments?.[options.env];
    if (!envConfig) {
      spinner.fail(chalk.red(`Environment '${options.env}' not found`));
      logger.error('Available environments:', Object.keys(projectConfig.environments ?? {}).join(', '));
      process.exit(1);
    }

    spinner.text = `Deploying to ${options.env} environment...`;

    // Handle rollback
    if (options.rollback) {
      await handleRollback(api, projectConfig, options, spinner);
      return;
    }

    // Confirmation for production deploys
    if (options.env === 'production' && !options.force) {
      spinner.stop();
      
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Deploy ${chalk.yellow(projectConfig.name)} to ${chalk.red('PRODUCTION')}?`,
          default: false
        }
      ]);
      
      if (!answers.confirm) {
        logger.info('Deployment cancelled');
        return;
      }
      
      spinner.start('Preparing production deployment...');
    }

    // Build if not skipped
    if (!options.noBuild) {
      spinner.text = 'Building project...';
      
      try {
        // Run build command
        await buildCommand({
          env: options.env,
          clean: true
        });
        
        spinner.start('Build completed, continuing deployment...');
      } catch (buildError) {
        spinner.fail(chalk.red('Build failed'));
        throw buildError;
      }
    }

    // Validate build output
    const buildConfig = projectConfig.build;
    if (buildConfig?.outputDir) {
      const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
      if (!fs.existsSync(outputPath)) {
        spinner.fail(chalk.red('Build output not found'));
        logger.error(`Expected build output in: ${buildConfig.outputDir}`);
        process.exit(1);
      }
    }

    // Run pre-deploy commands
    const deployConfig = projectConfig.deploy;
    if (deployConfig?.beforeDeploy) {
      spinner.text = 'Running pre-deploy commands...';
      
      for (const command of deployConfig.beforeDeploy) {
        logger.info(`Running: ${command}`);
        try {
          execSync(command, { 
            stdio: process.env['CIRRON_VERBOSE'] ? 'inherit' : 'pipe',
            cwd: process.cwd()
          });
        } catch (error) {
          spinner.fail(chalk.red(`Pre-deploy command failed: ${command}`));
          throw error;
        }
      }
    }

    // Create deployment
    spinner.text = 'Creating deployment...';
    
    const deploymentData = {
      projectName: projectConfig.name,
      environment: options.env,
      message: options.message || `Deploy to ${options.env}`,
      buildConfig: projectConfig.build,
      deployConfig: projectConfig.deploy,
      envConfig: envConfig
    };

    const deployment = await api.createDeployment(deploymentData);

    spinner.text = `Deployment created (ID: ${deployment.id})`;

    // Monitor deployment progress
    const finalDeployment = await monitorDeployment(api, deployment.id, spinner);

    // Run post-deploy commands on success
    if (finalDeployment.status === 'success' && deployConfig?.afterDeploy) {
      spinner.text = 'Running post-deploy commands...';
      
      for (const command of deployConfig.afterDeploy) {
        logger.info(`Running: ${command}`);
        try {
          execSync(command, { 
            stdio: process.env['CIRRON_VERBOSE'] ? 'inherit' : 'pipe',
            cwd: process.cwd()
          });
        } catch (error) {
          logger.warn(`Post-deploy command failed: ${command}`);
        }
      }
    }

    if (finalDeployment.status === 'success') {
      spinner.succeed(chalk.green('Deployment completed successfully! 🚀'));
      
      logger.info(`Environment: ${chalk.cyan(options.env)}`);
      logger.info(`Deployment ID: ${chalk.cyan(finalDeployment.id)}`);
      
      if (finalDeployment.url) {
        logger.info(`URL: ${chalk.cyan(finalDeployment.url)}`);
      }
      
      if (finalDeployment.completedAt) {
        const deployTime = calculateDeployTime(finalDeployment);
        logger.info(`Deploy time: ${chalk.cyan(deployTime)}`);
      }
      
    } else {
      spinner.fail(chalk.red('Deployment failed'));
      
      if (finalDeployment.logs && finalDeployment.logs.length > 0) {
        console.log();
        logger.info(chalk.bold('Recent logs:'));
        finalDeployment.logs.slice(-10).forEach(log => {
          logger.info(`  ${log}`);
        });
        console.log();
        logger.info('Run ' + chalk.cyan('cirron logs') + ' to view full deployment logs');
      }
      
      process.exit(1);
    }

  } catch (error) {
    spinner.fail(chalk.red('Deployment failed'));
    
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown deployment error occurred');
    }
    
    process.exit(1);
  }
}

async function handleRollback(
  api: CirronApi, 
  projectConfig: ProjectConfig, 
  options: DeployOptions,
  spinner: ReturnType<typeof ora>
): Promise<void> {
  try {
    spinner.text = 'Finding previous deployment...';
    
    const deployments = await api.getDeployments(projectConfig.name, {
      environment: options.env,
      status: 'success',
      limit: 5
    });

    if (deployments.length < 2) {
      spinner.fail(chalk.red('No previous successful deployment found'));
      logger.error('Cannot rollback without a previous deployment');
      return;
    }

    const previousDeployment = deployments[1]; // Second item (first is current)
    if (!previousDeployment) {
      spinner.fail(chalk.red('No previous successful deployment found'));
      logger.error('Cannot rollback without a previous deployment');
      return;
    }
    
    spinner.stop();
    
    if (!options.force) {
      console.log();
      logger.info('Previous deployment:');
      logger.info(`  ID: ${chalk.cyan(previousDeployment.id)}`);
      logger.info(`  Created: ${chalk.cyan(new Date(previousDeployment.createdAt).toLocaleString())}`);
      if (previousDeployment.message) {
        logger.info(`  Message: ${chalk.cyan(previousDeployment.message)}`);
      }
      
      const answers = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'confirm',
          message: `Rollback to deployment ${previousDeployment.id}?`,
          default: false
        }
      ]);
      
      if (!answers.confirm) {
        logger.info('Rollback cancelled');
        return;
      }
    }
    
    spinner.start('Rolling back deployment...');
    
    const rollbackDeployment = await api.rollbackDeployment(
      projectConfig.name,
      options.env,
      previousDeployment.id
    );

    const finalDeployment = await monitorDeployment(api, rollbackDeployment.id, spinner);

    if (finalDeployment.status === 'success') {
      spinner.succeed(chalk.green('Rollback completed successfully! ↩️'));
      logger.info(`Rolled back to: ${chalk.cyan(previousDeployment.id)}`);
      if (finalDeployment.url) {
        logger.info(`URL: ${chalk.cyan(finalDeployment.url)}`);
      }
    } else {
      spinner.fail(chalk.red('Rollback failed'));
      process.exit(1);
    }

  } catch (error) {
    spinner.fail(chalk.red('Rollback failed'));
    throw error;
  }
}

async function monitorDeployment(
  api: CirronApi, 
  deploymentId: string,
  spinner: ReturnType<typeof ora>
): Promise<DeploymentInfo> {
  const maxAttempts = 60; // 5 minutes with 5-second intervals
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    try {
      const deployment = await api.getDeployment(deploymentId);
      
      switch (deployment.status) {
        case 'pending':
          spinner.text = 'Deployment queued...';
          break;
        case 'building':
          spinner.text = 'Building deployment...';
          break;
        case 'deploying':
          spinner.text = 'Deploying to infrastructure...';
          break;
        case 'success':
        case 'failed':
          return deployment;
      }
      
      // Wait 5 seconds before next check
      await new Promise(resolve => setTimeout(resolve, 5000));
      attempts++;
      
    } catch (error) {
      logger.warn('Error checking deployment status:', error);
      attempts++;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
  
  throw new Error('Deployment monitoring timed out');
}

function calculateDeployTime(deployment: DeploymentInfo): string {
  if (!deployment.completedAt) {
    return 'Unknown';
  }
  
  const startTime = new Date(deployment.createdAt).getTime();
  const endTime = new Date(deployment.completedAt).getTime();
  const diffSeconds = Math.round((endTime - startTime) / 1000);
  
  if (diffSeconds < 60) {
    return `${diffSeconds}s`;
  } else if (diffSeconds < 3600) {
    const minutes = Math.floor(diffSeconds / 60);
    const seconds = diffSeconds % 60;
    return `${minutes}m ${seconds}s`;
  } else {
    const hours = Math.floor(diffSeconds / 3600);
    const minutes = Math.floor((diffSeconds % 3600) / 60);
    return `${hours}h ${minutes}m`;
  }
}