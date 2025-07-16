import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { ConfigManager } from '../utils/config';
import { CirronApi } from '../utils/api';
import { logger } from '../utils/logger';

interface LoginOptions {
  token?: string;
  url?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  const spinner = ora('Authenticating...').start();
  
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    // Update API URL if provided
    if (options.url) {
      currentConfig.apiUrl = options.url;
    }

    let token = options.token;

    if (!token) {
      spinner.stop();
      
      // Interactive login
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'token',
          message: 'Enter your Cirron API token:',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Token is required';
            }
            return true;
          }
        }
      ]);
      
      token = answers.token;
      spinner.start('Verifying token...');
    }

    // Verify token with API
    const api = new CirronApi({
      apiUrl: currentConfig.apiUrl,
      token: token!,
      defaultEnv: currentConfig.defaultEnv,
      timeout: currentConfig.timeout,
      retries: currentConfig.retries
    });

    const authInfo = await api.verifyAuth();
    
    if (!authInfo.authenticated) {
      throw new Error('Invalid token');
    }

    // Save configuration
    currentConfig.token = token!;
    config.save(currentConfig);

    spinner.succeed(chalk.green('Successfully authenticated!'));
    
    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
      if (authInfo.user.name) {
        logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
      }
    }

    logger.info(`API URL: ${chalk.cyan(currentConfig.apiUrl)}`);

  } catch (error) {
    spinner.fail(chalk.red('Authentication failed'));
    
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
    }
    
    process.exit(1);
  }
}

export async function logoutCommand(): Promise<void> {
  const spinner = ora('Logging out...').start();
  
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!currentConfig.token) {
      spinner.info(chalk.yellow('Not currently logged in'));
      return;
    }

    // Clear token
    delete currentConfig.token;
    config.save(currentConfig);

    spinner.succeed(chalk.green('Successfully logged out'));

  } catch (error) {
    spinner.fail(chalk.red('Logout failed'));
    logger.error('Error during logout:', error);
    process.exit(1);
  }
}

export async function authCommand(): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!currentConfig.token) {
      logger.info(chalk.yellow('Not authenticated'));
      logger.info('Run ' + chalk.cyan('cirron auth login') + ' to authenticate');
      return;
    }

    const spinner = ora('Checking authentication status...').start();

    try {
      const api = new CirronApi(currentConfig);
      const authInfo = await api.verifyAuth();

      if (authInfo.authenticated && authInfo.user) {
        spinner.succeed(chalk.green('Authenticated'));
        logger.info(`User: ${chalk.cyan(authInfo.user.email)}`);
        if (authInfo.user.name) {
          logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
        }
        logger.info(`API URL: ${chalk.cyan(currentConfig.apiUrl)}`);
        
        if (authInfo.expiresAt) {
          const expiryDate = new Date(authInfo.expiresAt);
          const now = new Date();
          const daysUntilExpiry = Math.ceil((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
          
          if (daysUntilExpiry <= 7) {
            logger.warn(`Token expires in ${daysUntilExpiry} days`);
          } else {
            logger.info(`Token expires: ${chalk.cyan(expiryDate.toLocaleDateString())}`);
          }
        }
      } else {
        spinner.fail(chalk.red('Token is invalid or expired'));
        logger.info('Run ' + chalk.cyan('cirron auth login') + ' to re-authenticate');
      }

    } catch (error) {
      spinner.fail(chalk.red('Failed to verify authentication'));
      logger.error('Error verifying token:', error);
      logger.info('Run ' + chalk.cyan('cirron auth login') + ' to re-authenticate');
    }

  } catch (error) {
    logger.error('Error checking authentication status:', error);
    process.exit(1);
  }
}