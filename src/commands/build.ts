import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import type { BuildOptions, ProjectConfig } from '../types';

export async function buildCommand(options: BuildOptions): Promise<void> {
  const spinner = ora('Preparing build...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    const buildConfig = projectConfig.build;

    if (!buildConfig) {
      spinner.fail(chalk.red('No build configuration found'));
      logger.error('Add build configuration to cirron.config.json');
      process.exit(1);
    }

    spinner.text = `Building for ${options.env} environment...`;

    // Clean output directory if requested
    if (options.clean && buildConfig.outputDir) {
      const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
      if (fs.existsSync(outputPath)) {
        await fs.remove(outputPath);
        logger.info(`Cleaned output directory: ${buildConfig.outputDir}`);
      }
    }

    // Set environment variables
    const env = {
      ...process.env,
      NODE_ENV: options.env === 'production' ? 'production' : 'development',
      CIRRON_ENV: options.env
    };

    // Load environment-specific variables
    const envConfig = projectConfig.environments[options.env];
    if (envConfig?.variables) {
      Object.assign(env, envConfig.variables);
    }

    // Run pre-build commands
    if (buildConfig.beforeBuild) {
      spinner.text = 'Running pre-build commands...';
      for (const command of buildConfig.beforeBuild) {
        logger.info(`Running: ${command}`);
        try {
          execSync(command, { 
            stdio: process.env['CIRRON_VERBOSE'] ? 'inherit' : 'pipe',
            env,
            cwd: process.cwd()
          });
        } catch (error) {
          spinner.fail(chalk.red(`Pre-build command failed: ${command}`));
          throw error;
        }
      }
    }

    // Run main build command
    spinner.text = 'Building project...';
    
    if (options.watch) {
      spinner.stop();
      logger.info(chalk.blue('Starting build in watch mode...'));
      logger.info('Press Ctrl+C to stop watching');
      
      await runBuildWatch(buildConfig.command, env);
    } else {
      await runBuild(buildConfig.command, env, spinner);
      
      // Run post-build commands
      if (buildConfig.afterBuild) {
        spinner.text = 'Running post-build commands...';
        for (const command of buildConfig.afterBuild) {
          logger.info(`Running: ${command}`);
          try {
            execSync(command, { 
              stdio: process.env['CIRRON_VERBOSE'] ? 'inherit' : 'pipe',
              env,
              cwd: process.cwd()
            });
          } catch (error) {
            spinner.fail(chalk.red(`Post-build command failed: ${command}`));
            throw error;
          }
        }
      }

      // Analyze bundle if requested
      if (options.analyze) {
        await analyzeBuild(projectConfig, options);
      }

      // Report build to Cirron API
      await reportBuildStatus(projectConfig, options, 'success');

      spinner.succeed(chalk.green('Build completed successfully!'));
      
      // Show build output info
      if (buildConfig.outputDir) {
        const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
        if (fs.existsSync(outputPath)) {
          const stats = await getBuildStats(outputPath);
          logger.info(`Output directory: ${chalk.cyan(buildConfig.outputDir)}`);
          logger.info(`Build size: ${chalk.cyan(formatBytes(stats.totalSize))}`);
          logger.info(`Files: ${chalk.cyan(stats.fileCount.toString())}`);
        }
      }

      logger.info(`Environment: ${chalk.cyan(options.env)}`);
      
      if (options.env !== 'production') {
        logger.info('Run ' + chalk.cyan('cirron deploy') + ' to deploy this build');
      }
    }

  } catch (error) {
    spinner.fail(chalk.red('Build failed'));
    
    // Report failure to API
    try {
      const projectConfigPath = path.join(process.cwd(), 'cirron.json');
      if (fs.existsSync(projectConfigPath)) {
        const projectConfig = await fs.readJSON(projectConfigPath);
        await reportBuildStatus(projectConfig, options, 'failed', error);
      }
    } catch (apiError) {
      // Ignore API reporting errors
    }

    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown build error occurred');
    }
    
    process.exit(1);
  }
}

async function runBuild(command: string, env: NodeJS.ProcessEnv, spinner: ora.Ora): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ');
    if (!cmd) {
      reject(new Error('Build command is undefined'));
      return;
    }
    const child = spawn(cmd, args, {
      stdio: process.env['CIRRON_VERBOSE'] ? 'inherit' : 'pipe',
      env,
      cwd: process.cwd(),
      shell: true
    });

    let output = '';
    let errorOutput = '';

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        if (process.env['CIRRON_VERBOSE']) {
          process.stdout.write(data);
        }
      });
    }

    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (data: Buffer) => {
        errorOutput += data.toString();
        if (process.env['CIRRON_VERBOSE']) {
          process.stderr.write(data);
        }
      });
    }

    if (typeof child.on === 'function') {
      child.on('close', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          const error = new Error(`Build command failed with exit code ${code}`);
          if (errorOutput) {
            logger.error('Build output:', errorOutput);
          }
          reject(error);
        }
      });

      child.on('error', (error: Error) => {
        spinner.fail(chalk.red('Failed to start build process'));
        reject(error);
      });
    }
  });
}

async function runBuildWatch(command: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = command.split(' ');
    // Add watch flag if not present
    if (!args.includes('--watch') && !args.includes('-w')) {
      args.push('--watch');
    }
    if (!cmd) {
      reject(new Error('Build command is undefined'));
      return;
    }
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      env,
      cwd: process.cwd(),
      shell: true
    });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      logger.info('\nStopping build watch...');
      if (typeof child.kill === 'function') {
        child.kill('SIGTERM');
        setTimeout(() => {
          child.kill('SIGKILL');
        }, 5000);
      }
    });

    if (typeof child.on === 'function') {
      child.on('close', (code: number) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Watch process exited with code ${code}`));
        }
      });

      child.on('error', (error: Error) => {
        reject(error);
      });
    }
  });
}

// Prefixing with _ to avoid unused-vars error. Will remove this once we have a proper build analysis.
async function analyzeBuild(projectConfig: ProjectConfig, _options: BuildOptions): Promise<void> {
  const spinner = ora('Analyzing build...').start();
  
  try {
    const buildConfig = projectConfig.build;
    if (!buildConfig?.outputDir) {
      spinner.warn('No output directory configured for analysis');
      return;
    }

    const outputPath = path.resolve(process.cwd(), buildConfig.outputDir);
    if (!fs.existsSync(outputPath)) {
      spinner.warn('Build output directory not found');
      return;
    }

    const stats = await getBuildStats(outputPath);
    const analysis = await analyzeBuildOutput(outputPath);

    spinner.succeed('Build analysis complete');

    // Display analysis results
    console.log();
    logger.info(chalk.bold('📊 Build Analysis'));
    logger.info(`Total size: ${chalk.cyan(formatBytes(stats.totalSize))}`);
    logger.info(`File count: ${chalk.cyan(stats.fileCount.toString())}`);
    
    if (analysis.largestFiles.length > 0) {
      console.log();
      logger.info(chalk.bold('📁 Largest files:'));
      analysis.largestFiles.slice(0, 5).forEach(file => {
        logger.info(`  ${file.name}: ${chalk.cyan(formatBytes(file.size))}`);
      });
    }

    if (analysis.recommendations.length > 0) {
      console.log();
      logger.info(chalk.bold('💡 Recommendations:'));
      analysis.recommendations.forEach(rec => {
        logger.info(`  ${chalk.yellow('•')} ${rec}`);
      });
    }

  } catch (error) {
    spinner.fail('Build analysis failed');
    logger.error('Analysis error:', error);
  }
}

async function getBuildStats(outputPath: string): Promise<{ totalSize: number; fileCount: number }> {
  let totalSize = 0;
  let fileCount = 0;

  const walk = async (dir: string): Promise<void> => {
    const items = await fs.readdir(dir);
    
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = await fs.stat(itemPath);
      
      if (stat.isDirectory()) {
        await walk(itemPath);
      } else {
        totalSize += stat.size;
        fileCount++;
      }
    }
  };

  await walk(outputPath);
  return { totalSize, fileCount };
}

async function analyzeBuildOutput(outputPath: string): Promise<{
  largestFiles: Array<{ name: string; size: number }>;
  recommendations: string[];
}> {
  const files: Array<{ name: string; size: number; path: string }> = [];
  const recommendations: string[] = [];

  const walk = async (dir: string, relativePath = ''): Promise<void> => {
    const items = await fs.readdir(dir);
    
    for (const item of items) {
      const itemPath = path.join(dir, item);
      const stat = await fs.stat(itemPath);
      const relativeItemPath = path.join(relativePath, item);
      
      if (stat.isDirectory()) {
        await walk(itemPath, relativeItemPath);
      } else {
        files.push({
          name: relativeItemPath,
          size: stat.size,
          path: itemPath
        });
      }
    }
  };

  await walk(outputPath);

  // Sort by size
  const largestFiles = files
    .sort((a, b) => b.size - a.size)
    .map(f => ({ name: f.name, size: f.size }));

  // Generate recommendations
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  const largeMBFiles = files.filter(f => f.size > 1024 * 1024); // > 1MB
  
  if (totalSize > 10 * 1024 * 1024) { // > 10MB
    recommendations.push('Consider code splitting to reduce bundle size');
  }
  
  if (largeMBFiles.length > 0) {
    recommendations.push('Some files are quite large - consider compression or optimization');
  }

  const jsFiles = files.filter(f => f.name.endsWith('.js'));
  const hasSourceMaps = files.some(f => f.name.endsWith('.map'));
  
  if (jsFiles.length > 0 && !hasSourceMaps) {
    recommendations.push('Enable source maps for better debugging');
  }

  return { largestFiles, recommendations };
}

async function reportBuildStatus(
  projectConfig: ProjectConfig, 
  options: BuildOptions, 
  status: 'success' | 'failed',
  error?: any
): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();
    
    if (!currentConfig.token) {
      return; // Not authenticated, skip reporting
    }

    const api = new CirronApi(currentConfig);
    
    await api.reportBuild({
      projectName: projectConfig.name,
      environment: options.env,
      status,
      timestamp: new Date().toISOString(),
      error: error ? error.message : undefined
    });

  } catch (apiError) {
    // Don't fail the build if API reporting fails
    logger.debug('Failed to report build status to API:', apiError);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}