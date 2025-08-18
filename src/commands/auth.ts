import chalk from 'chalk';
import ora from 'ora';
import open from 'open';
import { ConfigManager } from '../utils/config';
import { CirronApi } from '../utils/api';
import { logger } from '../utils/logger';
import type { DeviceTokenResponse } from '../types';

interface LoginOptions {
  token?: string;
  url?: string;
}

export async function loginCommand(options: LoginOptions): Promise<void> {
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    // Update API URL if provided
    if (options.url) {
      currentConfig.apiUrl = options.url;
    }

    // Support legacy --token option for CI/CD workflows
    if (options.token) {
      return legacyTokenLogin(options, currentConfig, config);
    }

    // Default to device flow
    return deviceFlowLogin(currentConfig, config);

  } catch (error) {
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
    }
    
    process.exit(1);
  }
}

async function legacyTokenLogin(options: LoginOptions, currentConfig: any, config: ConfigManager): Promise<void> {
  const spinner = ora('Verifying token...').start();
  
  try {
    // Verify token with API
    const api = new CirronApi({
      apiUrl: currentConfig.apiUrl,
      token: options.token!,
      defaultEnv: currentConfig.defaultEnv,
      timeout: currentConfig.timeout,
      retries: currentConfig.retries
    });

    const authInfo = await api.verifyAuth();
    
    if (!authInfo.authenticated) {
      throw new Error('Invalid token');
    }

    // Save configuration with legacy token
    currentConfig.token = options.token!;
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
    throw error;
  }
}

async function deviceFlowLogin(currentConfig: any, config: ConfigManager): Promise<void> {
  const spinner = ora('Starting device authorization...').start();
  
  try {
    const api = new CirronApi(currentConfig);
    
    // 1. Request device code
    const deviceAuth = await api.requestDeviceCode();
    
    spinner.stop();
    
    // 2. Display user code and instructions
    console.log();
    console.log(chalk.bold('First copy your one-time code: ') + chalk.cyan(deviceAuth.user_code));
    console.log();
    console.log(`Press ${chalk.bold('Enter')} to open ${deviceAuth.verification_uri} in your browser...`);
    
    // Wait for user to press Enter
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
    });
    
    // 3. Open browser
    await open(deviceAuth.verification_uri);
    
    // 4. Poll for authorization
    spinner.start('Waiting for authorization...');
    const result = await pollForAuthorization(api, deviceAuth.device_code, deviceAuth.interval);
    
    // 5. Store tokens and verify
    await saveTokens(result, currentConfig, config);
    
    spinner.succeed(chalk.green('Authentication complete!'));
    
    // Show user info
    const authInfo = await api.verifyAuth();
    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
      if (authInfo.user.name) {
        logger.info(`Name: ${chalk.cyan(authInfo.user.name)}`);
      }
    }
    
  } catch (error) {
    spinner.fail(chalk.red('Authentication failed'));
    throw error;
  }
}

async function pollForAuthorization(
  api: CirronApi, 
  deviceCode: string, 
  interval: number
): Promise<DeviceTokenResponse> {
  const maxAttempts = 120; // 10 minutes max
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    
    try {
      const status = await api.pollDeviceAuthorization(deviceCode);
      
      if (status.status === 'authorized') {
        return {
          access_token: status.access_token!,
          refresh_token: status.refresh_token!,
          expires_in: status.expires_in!,
          token_type: 'bearer'
        };
      }
      
      if (status.status === 'expired' || status.status === 'denied') {
        throw new Error(`Authorization ${status.status}`);
      }
      
      // Continue polling for 'pending' status
      attempts++;
      
    } catch (error) {
      if (attempts > 5) throw error;
      attempts++;
    }
  }
  
  throw new Error('Authorization timeout');
}

async function saveTokens(tokens: DeviceTokenResponse, currentConfig: any, config: ConfigManager): Promise<void> {
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  
  currentConfig.auth = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt
  };
  
  config.save(currentConfig);
}

export async function logoutCommand(): Promise<void> {
  const spinner = ora('Logging out...').start();
  
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();

    if (!currentConfig.token && !currentConfig.auth?.accessToken) {
      spinner.info(chalk.yellow('Not currently logged in'));
      return;
    }

    // Clear both JWT and legacy tokens
    delete currentConfig.token;
    delete currentConfig.auth;
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

    if (!currentConfig.token && !currentConfig.auth?.accessToken) {
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

export async function refreshCommand(): Promise<void> {
  const spinner = ora('Refreshing authentication...').start();
  
  try {
    const config = new ConfigManager();
    const currentConfig = config.load();
    
    if (!currentConfig.auth?.refreshToken) {
      spinner.fail(chalk.red('No refresh token available'));
      logger.error('Please log in again with: ' + chalk.cyan('cirron auth login'));
      process.exit(1);
    }
    
    const api = new CirronApi(currentConfig);
    const newTokens = await api.refreshToken(currentConfig.auth.refreshToken);
    
    await saveTokens(newTokens, currentConfig, config);
    
    spinner.succeed(chalk.green('Authentication refreshed!'));
    
    // Show updated auth info
    const authInfo = await api.verifyAuth();
    if (authInfo.user) {
      logger.info(`Logged in as: ${chalk.cyan(authInfo.user.email)}`);
    }

  } catch (error) {
    spinner.fail(chalk.red('Failed to refresh token'));
    
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
    }
    
    logger.info('Please log in again with: ' + chalk.cyan('cirron auth login'));
    process.exit(1);
  }
}