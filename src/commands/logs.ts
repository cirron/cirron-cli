// src/commands/logs.ts
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import { loadProjectConfig } from '../utils/project-config';
import type { ProjectConfig, LogEntry } from '../types';

interface LogsOptions {
  follow?: boolean;
  lines?: string;
  env?: string;
}

export async function logsCommand(options: LogsOptions): Promise<void> {
  const spinner = ora('Fetching logs...').start();

  try {
    // Load project configuration
    const projectConfigResult = loadProjectConfig();

    if (!projectConfigResult) {
      spinner.fail(chalk.red('No cirron config found (cirron.yaml or cirron.json)'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      return;
    }

    const { config: projectConfig } = projectConfigResult;
    
    // Check authentication
    const config = new ConfigManager();
    const currentConfig = config.load();
    
    if (!currentConfig.token) {
      spinner.fail(chalk.red('Not authenticated'));
      logger.error('Run ' + chalk.cyan('cirron auth login') + ' to authenticate');
      return;
    }

    const api = new CirronApi(currentConfig);
    const environment = options.env || 'production';
    const lines = parseInt(options.lines || '100', 10);

    if (options.follow) {
      spinner.stop();
      await followLogs(api, projectConfig.name, environment);
    } else {
      const logs = await api.getLogs(projectConfig.name, environment, { lines });
      spinner.stop();
      
      if (logs.length === 0) {
        logger.info(chalk.yellow('No logs found'));
        return;
      }

      displayLogs(logs);
    }

  } catch (error) {
    spinner.fail(chalk.red('Failed to fetch logs'));
    logger.error('Error:', error);
  }
}

async function followLogs(api: CirronApi, projectName: string, environment: string): Promise<void> {
  logger.info(chalk.blue(`Following logs for ${projectName} (${environment})`));
  logger.info(chalk.gray('Press Ctrl+C to stop'));
  console.log();

  let lastTimestamp = new Date().toISOString();

  const pollLogs = async (): Promise<void> => {
    try {
      const logs = await api.getLogs(projectName, environment, { 
        since: lastTimestamp,
        lines: 50 
      });

      if (logs.length > 0) {
        displayLogs(logs);
        const lastLog = logs[logs.length - 1];
        if (lastLog) {
          lastTimestamp = lastLog.timestamp;
        }
      }
    } catch (error) {
      logger.debug('Error polling logs:', error);
    }
  };

  // Initial fetch
  await pollLogs();

  // Poll every 2 seconds
  const interval = setInterval(pollLogs, 2000);

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    clearInterval(interval);
    logger.info('\nStopped following logs');
    process.exit(0);
  });
}

function displayLogs(logs: LogEntry[]): void {
  logs.forEach(log => {
    const timestamp = new Date(log.timestamp).toLocaleTimeString();
    const levelColor = getLevelColor(log.level);
    const level = levelColor(log.level.toUpperCase().padEnd(5));
    
    console.log(`${chalk.gray(timestamp)} ${level} ${log.message}`);
  });
}

export function getLevelColor(level: string): (text: string) => string {
  switch (level.toLowerCase()) {
    case 'error': return chalk.red;
    case 'warn': return chalk.yellow;
    case 'info': return chalk.blue;
    case 'debug': return chalk.gray;
    default: return chalk.white;
  }
}