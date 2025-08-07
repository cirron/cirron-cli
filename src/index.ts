#!/usr/bin/env node

import { Command } from 'commander';
import { authCommand, loginCommand, logoutCommand } from './commands/auth';
import { buildCommand } from './commands/build';
import { compileCommand } from './commands/compile';
import { deployCommand } from './commands/deploy';
import { initCommand } from './commands/init';
import { testCommand } from './commands/test';
import { configCommand } from './commands/config';
import { infoCommand } from './commands/info';
import { lintCommand } from './commands/lint';
import { logger } from './utils/logger';

const program = new Command();

// Global error handling
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception:', error.message);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  logger.error('Unhandled rejection:', error);
  process.exit(1);
});

program
  .name('cirron')
  .description('Cirron CLI - Build, deploy, and manage your projects with ease')
  .version('1.0.0')
  .option('-v, --verbose', 'Enable verbose logging')
  .option('--config <path>', 'Path to config file')
  .hook('preAction', (thisCommand) => {
    const options = thisCommand.opts();
    if (options['verbose']) {
      process.env['CIRRON_VERBOSE'] = 'true';
    }
  });

// Auth commands
const authCmd = program
  .command('auth')
  .description('Authentication commands');

authCmd
  .command('login')
  .description('Login to Cirron')
  .option('-t, --token <token>', 'API token')
  .option('-u, --url <url>', 'API URL (default: https://api.cirron.com)')
  .action(loginCommand);

authCmd
  .command('logout')
  .description('Logout from Cirron')
  .action(logoutCommand);

authCmd
  .command('status')
  .description('Show authentication status')
  .action(authCommand);

// Init command
program
  .command('init')
  .description('Initialize a new Cirron project')
  .argument('[name]', 'Project name')
  .option('-t, --template <template>', 'Project template (nextjs, react, vue, express)', 'nextjs')
  .option('-f, --force', 'Force initialization in non-empty directory')
  .option('--no-install', 'Skip package installation')
  .option('--git', 'Initialize git repository')
  .action(initCommand);

// Test command
program
  .command('test')
  .description('Run tests for your ML project')
  .option('--env', 'Test environment setup (Python, CUDA, etc.)')
  .option('--build', 'Test container build')
  .option('--requirements', 'Test Python requirements')
  .option('--unit', 'Run unit tests')
  .option('--lint', 'Run code quality checks')
  .option('--model', 'Test model loading and instantiation')
  .option('--data', 'Test data loading')
  .option('--inference', 'Test model inference')
  .option('-v, --val', 'Run validation tests on model accuracy')
  .option('-p, --path <path>', 'Path to validation data (file or folder)')
  .option('-e, --endpoint <url>', 'Test deployment endpoint for speed, accuracy, and latency')
  .option('--pipeline', 'Test entire ML pipeline end-to-end')
  .option('-w, --watch', 'Watch for changes and re-run tests')
  .option('--json', 'Output results in JSON format')
  .option('--strict', 'Enable strict mode - fail fast on any errors (useful for CI)')
  .action(testCommand);

// Compile command
program
  .command('compile')
  .description('Compile/build the model locally')
  .option('-a, --arch <architecture>', 'Select a specific architecture')
  .option('--index <file>', 'Path to index/manifest file')
  .option('--validate', 'Run data/model integrity checks')
  .option('--dry-run', 'Simulate compile without artifacts')
  .option('--json', 'Output results in JSON format')
  .option('--strict', 'Enable strict mode - fail fast on any errors (useful for CI)')
  .action(compileCommand);

// Build command
program
  .command('build')
  .description('Build your ML project (full build with container)')
  .option('-e, --env <environment>', 'Environment to build for', 'development')
  .option('-w, --watch', 'Watch for changes and rebuild (traditional projects only)')
  .option('-t, --tag <tag>', 'Container image tag')
  .option('--clean', 'Clean build (no cache)')
  .option('--push', 'Push image to registry after build')
  .option('--analyze', 'Analyze build output')
  .option('-a, --arch <architecture>', 'Select a specific architecture')
  .option('--index <file>', 'Path to index/manifest file')
  .option('--validate', 'Run data/model integrity checks')
  .option('--dry-run', 'Simulate build without artifacts')
  .option('--strict', 'Enable strict mode - fail fast on any errors (useful for CI)')
  .action(buildCommand);

// Deploy command
program
  .command('deploy')
  .description('Deploy your Cirron project')
  .option('-e, --env <environment>', 'Environment to deploy to', 'production')
  .option('-f, --force', 'Force deployment without confirmation')
  .option('--no-build', 'Skip build step')
  .option('--rollback', 'Rollback to previous deployment')
  .option('-m, --message <message>', 'Deployment message')
  .action(deployCommand);

// Config command
program
  .command('config')
  .description('Manage configuration')
  .option('-l, --list', 'List all configuration')
  .option('-g, --get <key>', 'Get configuration value')
  .option('-s, --set <key=value>', 'Set configuration value')
  .option('-d, --delete <key>', 'Delete configuration key')
  .option('--reset', 'Reset configuration to defaults')
  .action(configCommand);

// Info command
program
  .command('info')
  .description('Show model information and metadata')
  .option('--update <type>', 'Update specific information (metadata)')
  .option('--dry-run', 'Preview changes without applying them')
  .action(infoCommand);

// Lint command
program
  .command('lint')
  .description('Run linting checks for config and project health')
  .option('--config', 'Lint project configuration only')
  .option('--structure', 'Check project structure only')
  .option('--dependencies', 'Validate dependencies only')
  .option('--code', 'Run code quality checks only')
  .option('--all', 'Run all lint checks (default)')
  .option('--fix', 'Automatically fix issues where possible')
  .option('--verbose', 'Show detailed output with suggestions')
  .option('--json', 'Output results in JSON format')
  .option('--strict', 'Enable strict mode - fail fast on any errors (useful for CI)')
  .action(lintCommand);

// Status command
program
  .command('status')
  .description('Show project status')
  .option('-r, --remote', 'Include remote status')
  .action(async (options) => {
    try {
      const { statusCommand } = await import('./commands/status');
      await statusCommand(options);
    } catch (error) {
      logger.error('Failed to load status command:', error);
      process.exit(1);
    }
  });

// Logs command
program
  .command('logs')
  .description('View deployment logs')
  .option('-f, --follow', 'Follow log output')
  .option('-n, --lines <number>', 'Number of lines to show', '100')
  .option('--env <environment>', 'Environment to get logs from', 'production')
  .action(async (options) => {
    try {
      const { logsCommand } = await import('./commands/logs');
      await logsCommand(options);
    } catch (error) {
      logger.error('Failed to load logs command:', error);
      process.exit(1);
    }
  });

// Env command
const envCmd = program
  .command('env')
  .description('Manage environment variables');

envCmd
  .command('list')
  .description('List environment variables')
  .option('--env <environment>', 'Environment', 'production')
  .action(async (options) => {
    try {
      const { envListCommand } = await import('./commands/env');
      await envListCommand(options);
    } catch (error) {
      logger.error('Failed to load env list command:', error);
      process.exit(1);
    }
  });

envCmd
  .command('set')
  .description('Set environment variable')
  .argument('<key>', 'Variable name')
  .argument('<value>', 'Variable value')
  .option('--env <environment>', 'Environment', 'production')
  .action(async (key, value, options) => {
    try {
      const { envSetCommand } = await import('./commands/env');
      await envSetCommand(key, value, options);
    } catch (error) {
      logger.error('Failed to load env set command:', error);
      process.exit(1);
    }
  });

envCmd
  .command('delete')
  .description('Delete environment variable')
  .argument('<key>', 'Variable name')
  .option('--env <environment>', 'Environment', 'production')
  .action(async (key, options) => {
    try {
      const { envDeleteCommand } = await import('./commands/env');
      await envDeleteCommand(key, options);
    } catch (error) {
      logger.error('Failed to load env delete command:', error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

// Show help if no command provided
if (!process.argv.slice(2).length) {
  program.outputHelp();
}