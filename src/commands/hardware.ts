import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { logger } from '../utils/logger';
import { HardwareDetector } from '../utils/hardware';
import { findProjectConfigPath, loadProjectConfig, saveProjectConfig } from '../utils/project-config';
import type {
  HardwareOptions,
  HardwareConfig
} from '../types';

export async function hardwareCommand(options: HardwareOptions): Promise<void> {
  try {
    if (options.detect) {
      await detectCommand(options);
    } else if (options.configure) {
      await configCommand(options);
    } else if (options.list) {
      await listCommand(options);
    } else {
      // Interactive mode
      await interactiveCommand(options);
    }
  } catch (error) {
    logger.error('Hardware command failed:', error);
    process.exit(1);
  }
}

async function detectCommand(options: HardwareOptions): Promise<void> {
  const spinner = ora('Detecting current device hardware...').start();

  try {
    const hardwareConfig = await HardwareDetector.detectCurrentDevice();
    spinner.succeed('Hardware detection completed');

    if (options.json) {
      console.log(JSON.stringify(hardwareConfig, null, 2));
      return;
    }

    // Display results
    console.log();
    logger.info(chalk.bold('Current Device Hardware Configuration'));
    console.log();
    
    logger.info(`${chalk.cyan('Type:')} ${hardwareConfig.type.toUpperCase()}`);
    logger.info(`${chalk.cyan('Architecture:')} ${hardwareConfig.architecture}`);
    
    // CPU Information
    if (hardwareConfig.specifications.cpu) {
      console.log();
      logger.info(chalk.bold('CPU:'));
      logger.info(`  Model: ${hardwareConfig.specifications.cpu.model}`);
      logger.info(`  Cores: ${hardwareConfig.specifications.cpu.cores}`);
      logger.info(`  Architecture: ${hardwareConfig.specifications.cpu.architecture}`);
    }

    // Memory Information
    if (hardwareConfig.specifications.memory) {
      console.log();
      logger.info(chalk.bold('Memory:'));
      logger.info(`  Total: ${hardwareConfig.specifications.memory.total}`);
      logger.info(`  Available: ${hardwareConfig.specifications.memory.available}`);
    }

    // GPU Information
    if (hardwareConfig.specifications.gpu) {
      console.log();
      logger.info(chalk.bold('GPU:'));
      logger.info(`  Model: ${hardwareConfig.specifications.gpu.model}`);
      logger.info(`  Memory: ${hardwareConfig.specifications.gpu.memory}`);
      if (hardwareConfig.specifications.gpu.drivers) {
        logger.info(`  Drivers: ${hardwareConfig.specifications.gpu.drivers}`);
      }
    }

    // CUDA Information
    if (hardwareConfig.specifications.cuda) {
      console.log();
      logger.info(chalk.bold('CUDA:'));
      logger.info(`  Available: ${hardwareConfig.specifications.cuda.available ? chalk.green('Yes') : chalk.red('No')}`);
      if (hardwareConfig.specifications.cuda.available) {
        logger.info(`  Version: ${hardwareConfig.specifications.cuda.version}`);
        logger.info(`  Devices: ${hardwareConfig.specifications.cuda.devices.length}`);
        hardwareConfig.specifications.cuda.devices.forEach((device, index) => {
          logger.info(`    ${index}: ${device.name} (${device.memory})`);
        });
      }
    }

    // Framework Compatibility
    console.log();
    logger.info(chalk.bold('Framework Compatibility:'));
    logger.info(`  PyTorch: ${hardwareConfig.compatibility.pytorch ? chalk.green('✓') : chalk.red('✗')}`);
    logger.info(`  TensorFlow: ${hardwareConfig.compatibility.tensorflow ? chalk.green('✓') : chalk.red('✗')}`);
    logger.info(`  Scikit-learn: ${hardwareConfig.compatibility.sklearn ? chalk.green('✓') : chalk.red('✗')}`);

    // Requirements and warnings
    if (hardwareConfig.compatibility.requirements && hardwareConfig.compatibility.requirements.length > 0) {
      console.log();
      logger.info(chalk.bold('Required installations:'));
      hardwareConfig.compatibility.requirements.forEach(req => {
        logger.info(`  ${chalk.yellow('•')} ${req}`);
      });
    }

    if (hardwareConfig.compatibility.warnings && hardwareConfig.compatibility.warnings.length > 0) {
      console.log();
      logger.info(chalk.bold('Warnings:'));
      hardwareConfig.compatibility.warnings.forEach(warning => {
        logger.warn(`  ${warning}`);
      });
    }

    // Ask if user wants to save configuration and apply to project
    const questions: any[] = [];
    
    if (!options.save) {
      questions.push({
        type: 'confirm',
        name: 'shouldSave',
        message: 'Save this hardware configuration?',
        default: true
      });
    }
    
    if (findProjectConfigPath()) {
      questions.push({
        type: 'confirm',
        name: 'shouldApplyToProject',
        message: 'Apply this configuration to current project?',
        default: true
      });
    }

    let answers: any = {};
    if (questions.length > 0) {
      answers = await inquirer.prompt(questions);
    }

    if (options.save) {
      const configPath = await HardwareDetector.saveHardwareConfig(hardwareConfig, options.save);
      logger.info(`\n${chalk.green('✓')} Hardware profile saved to ${chalk.cyan(configPath)}`);
      logger.info('To apply this profile to a project, run:');
      logger.info(`  ${chalk.cyan(`cirron config hardware --configure --from ${configPath}`)}`);
    } else if (answers.shouldSave) {
      const configPath = await HardwareDetector.saveHardwareConfig(hardwareConfig);
      logger.info(`${chalk.green('✓')} Hardware profile saved to ${chalk.cyan(configPath)}`);
      logger.info('To apply this profile to a project, run:');
      logger.info(`  ${chalk.cyan(`cirron config hardware --configure --from ${configPath}`)}`);
    }

    if (answers.shouldApplyToProject) {
      await applyToProject(hardwareConfig);
    }

  } catch (error) {
    spinner.fail('Hardware detection failed');
    throw error;
  }
}

async function configCommand(options: HardwareOptions): Promise<void> {
  console.log();
  logger.info(chalk.bold('Hardware Configuration Setup'));
  console.log();

  let hardwareConfig: HardwareConfig;

  // Handle --from flag to load configuration from file
  if (options.from) {
    try {
      const loadedConfig = await HardwareDetector.loadHardwareConfig(options.from);
      if (!loadedConfig) {
        logger.error(`Hardware configuration file not found: ${options.from}`);
        process.exit(1);
      }
      hardwareConfig = loadedConfig;
      logger.info(`${chalk.green('✓')} Hardware configuration loaded from ${chalk.cyan(options.from)}`);
    } catch (error) {
      logger.error(`Failed to load hardware configuration from ${options.from}:`, error);
      process.exit(1);
    }
  } else {
    const configAnswers = await inquirer.prompt([
      {
        type: 'list',
        name: 'configType',
        message: 'How would you like to configure hardware?',
        choices: [
          { name: 'Use current device (auto-detect)', value: 'current' },
          { name: 'Select from preset profiles', value: 'preset' },
          { name: 'Manual configuration', value: 'manual' }
        ]
      }
    ]);

    switch (configAnswers.configType) {
      case 'current':
        hardwareConfig = await configureCurrentDevice();
        break;
      case 'preset':
        hardwareConfig = await configureFromPreset();
        break;
      case 'manual':
        hardwareConfig = await configureManually();
        break;
      default:
        throw new Error('Invalid configuration type');
    }
  }

  // Validate configuration
  const validation = HardwareDetector.validateHardwareConfig(hardwareConfig);
  if (!validation.valid) {
    logger.error('Hardware configuration validation failed:');
    validation.errors.forEach(error => logger.error(`  • ${error}`));
    process.exit(1);
  }

  // Display configuration summary
  displayConfigSummary(hardwareConfig);

  // Ask what to do with the hardware configuration
  const isProjectDirectory = !!findProjectConfigPath();
  const questions: any[] = [];

  if (isProjectDirectory) {
    questions.push({
      type: 'confirm',
      name: 'shouldApplyToProject',
      message: 'Apply this hardware configuration to current project?',
      default: true
    });
  }

  // Only ask about saving to file if not loading from --from flag
  if (!options.from) {
    questions.push({
      type: 'confirm',
      name: 'shouldSaveToFile',
      message: isProjectDirectory ? 'Also save hardware configuration to separate file?' : 'Save hardware configuration to file?',
      default: false
    });
  }

  const saveAnswers = await inquirer.prompt(questions);

  if (saveAnswers.shouldApplyToProject) {
    await applyToProject(hardwareConfig);
  }

  if (saveAnswers.shouldSaveToFile) {
    const configPath = await HardwareDetector.saveHardwareConfig(hardwareConfig);
    logger.info(`${chalk.green('✓')} Hardware profile saved to ${chalk.cyan(configPath)}`);
    logger.info('To apply this profile to a project, run:');
    logger.info(`  ${chalk.cyan(`cirron config hardware --configure --from ${configPath}`)}`);
  }
}

async function configureCurrentDevice(): Promise<HardwareConfig> {
  const spinner = ora('Detecting current device...').start();
  
  try {
    const config = await HardwareDetector.detectCurrentDevice();
    spinner.succeed('Current device detected');
    return config;
  } catch (error) {
    spinner.fail('Failed to detect current device');
    throw error;
  }
}

async function configureFromPreset(): Promise<HardwareConfig> {
  const profiles = HardwareDetector.getPresetProfiles();
  
  const { selectedProfile } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedProfile',
      message: 'Select a hardware profile:',
      choices: profiles.map(profile => ({
        name: `${profile.name} - ${profile.description}`,
        value: profile.config
      }))
    }
  ]);

  return selectedProfile;
}

async function configureManually(): Promise<HardwareConfig> {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'type',
      message: 'Select hardware type:',
      choices: [
        { name: 'CPU Only', value: 'cpu' },
        { name: 'GPU (General)', value: 'gpu' },
        { name: 'CUDA (NVIDIA)', value: 'cuda' },
        { name: 'Custom', value: 'custom' }
      ]
    },
    {
      type: 'input',
      name: 'architecture',
      message: 'Enter architecture:',
      default: 'x86_64',
      validate: (input: string) => input.trim().length > 0 || 'Architecture is required'
    }
  ]);

  // Get detailed specifications based on type
  let specifications: any = {};

  if (answers.type === 'cpu' || answers.type === 'gpu' || answers.type === 'cuda') {
    const cpuAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'cpuModel',
        message: 'CPU Model:',
        default: 'Generic CPU'
      },
      {
        type: 'number',
        name: 'cpuCores',
        message: 'Number of CPU cores:',
        default: 4,
        validate: (input: number) => input > 0 || 'Must be greater than 0'
      }
    ]);

    specifications.cpu = {
      cores: cpuAnswers.cpuCores,
      model: cpuAnswers.cpuModel,
      architecture: answers.architecture
    };
  }

  if (answers.type === 'gpu' || answers.type === 'cuda') {
    const gpuAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'gpuModel',
        message: 'GPU Model:',
        default: 'Generic GPU'
      },
      {
        type: 'input',
        name: 'gpuMemory',
        message: 'GPU Memory:',
        default: '8GB'
      }
    ]);

    specifications.gpu = {
      model: gpuAnswers.gpuModel,
      memory: gpuAnswers.gpuMemory,
      drivers: answers.type === 'cuda' ? 'NVIDIA' : 'Generic'
    };
  }

  if (answers.type === 'cuda') {
    const cudaAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'cudaVersion',
        message: 'CUDA Version:',
        default: '11.8'
      }
    ]);

    specifications.cuda = {
      version: cudaAnswers.cudaVersion,
      available: true,
      devices: []
    };
  }

  return {
    type: answers.type,
    architecture: answers.architecture,
    specifications,
    compatibility: {
      pytorch: true,
      tensorflow: true,
      sklearn: true
    },
    isCurrentDevice: false
  };
}

async function listCommand(options: HardwareOptions): Promise<void> {
  const profiles = HardwareDetector.getPresetProfiles();

  if (options.json) {
    console.log(JSON.stringify(profiles, null, 2));
    return;
  }

  console.log();
  logger.info(chalk.bold('Available Hardware Profiles'));
  console.log();

  profiles.forEach(profile => {
    logger.info(`${chalk.cyan(profile.name)}`);
    logger.info(`  Description: ${profile.description}`);
    logger.info(`  Type: ${profile.config.type.toUpperCase()}`);
    logger.info(`  Frameworks: ${profile.frameworks.join(', ')}`);
    if (profile.recommended) {
      logger.info(`  ${chalk.green('✓ Recommended')}`);
    }
    console.log();
  });
}

async function interactiveCommand(options: HardwareOptions): Promise<void> {
  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: 'What would you like to do?',
      choices: [
        { name: 'Detect current device hardware', value: 'detect' },
        { name: 'Configure hardware for project', value: 'config' },
        { name: 'List available hardware profiles', value: 'list' },
        { name: 'Load existing hardware configuration', value: 'load' }
      ]
    }
  ]);

  switch (answers.action) {
    case 'detect':
      await detectCommand({ ...options, detect: true });
      break;
    case 'config':
      await configCommand({ ...options, configure: true });
      break;
    case 'list':
      await listCommand({ ...options, list: true });
      break;
    case 'load':
      await loadExistingConfig();
      break;
  }
}

async function loadExistingConfig(): Promise<void> {
  try {
    const config = await HardwareDetector.loadHardwareConfig();
    if (!config) {
      logger.warn('No hardware configuration file found');
      logger.info('Run ' + chalk.cyan('cirron config hardware --configure') + ' to create one');
      return;
    }

    logger.info(chalk.green('✓') + ' Hardware configuration loaded');
    displayConfigSummary(config);
  } catch (error) {
    logger.error('Failed to load hardware configuration:', error);
  }
}

function displayConfigSummary(config: HardwareConfig): void {
  console.log();
  logger.info(chalk.bold('Hardware Configuration Summary'));
  console.log();
  
  logger.info(`${chalk.cyan('Type:')} ${config.type.toUpperCase()}`);
  logger.info(`${chalk.cyan('Architecture:')} ${config.architecture}`);
  
  if (config.specifications.cpu) {
    logger.info(`${chalk.cyan('CPU:')} ${config.specifications.cpu.model} (${config.specifications.cpu.cores} cores)`);
  }
  
  if (config.specifications.gpu) {
    logger.info(`${chalk.cyan('GPU:')} ${config.specifications.gpu.model} (${config.specifications.gpu.memory})`);
  }
  
  if (config.specifications.cuda?.available) {
    logger.info(`${chalk.cyan('CUDA:')} v${config.specifications.cuda.version} (${config.specifications.cuda.devices.length} devices)`);
  }

  logger.info(`${chalk.cyan('Framework Support:')} ${Object.entries(config.compatibility)
    .filter(([, value]) => typeof value === 'boolean')
    .map(([key, value]) => value ? chalk.green(key) : chalk.red(key))
    .join(', ')}`);
}

async function applyToProject(hardwareConfig: HardwareConfig): Promise<void> {
  try {
    const projectConfigResult = loadProjectConfig();
    if (!projectConfigResult) {
      logger.error('No cirron config found (cirron.yaml or cirron.json)');
      return;
    }
    const { configPath: projectConfigPath, config: projectConfig } = projectConfigResult;

    projectConfig.hardware = hardwareConfig;

    // Update GPU required flag based on hardware type
    if (hardwareConfig.type === 'cuda' || hardwareConfig.type === 'gpu') {
      projectConfig.gpuRequired = true;
    }

    saveProjectConfig(projectConfigPath, projectConfig);
    logger.info(`${chalk.green('✓')} Hardware configuration applied to project`);
    
  } catch (error) {
    logger.error('Failed to apply hardware configuration to project:', error);
  }
}