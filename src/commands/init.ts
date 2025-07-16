import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import type { 
  InitOptions, 
  ProjectConfig, 
  Template 
} from '../types';
import { 
  createTensorFlowFiles, 
  createTensorFlowTrainingFiles,
  createCommonMLFiles,
  createPyTorchFiles, 
  createPyTorchTrainingFiles,
  createSklearnFiles, 
  createSklearnPipelineFiles,
  createCustomFiles 
} from './files';

const TEMPLATES: Record<string, Template> = {
  pytorch: {
    name: 'PyTorch',
    description: 'PyTorch model with training and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  tensorflow: {
    name: 'TensorFlow',
    description: 'TensorFlow/Keras model with training and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  sklearn: {
    name: 'Scikit-Learn',
    description: 'Scikit-learn model with preprocessing and inference',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'pytorch-train': {
    name: 'PyTorch Training',
    description: 'PyTorch training pipeline with data loading',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'tensorflow-train': {
    name: 'TensorFlow Training',
    description: 'TensorFlow training pipeline with data loading',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  'sklearn-pipeline': {
    name: 'Scikit-Learn Pipeline',
    description: 'Full ML pipeline with preprocessing and training',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  },
  custom: {
    name: 'Custom Framework',
    description: 'Blank Python project for any ML framework',
    files: [],
    postInstall: ['pip install -r requirements.txt']
  }
};

const MODEL_TYPES = {
  classification: 'Classification',
  regression: 'Regression',
  computer_vision: 'Computer Vision',
  nlp: 'Natural Language Processing',
  time_series: 'Time Series',
  custom: 'Custom'
};

export async function initCommand(projectName?: string, options: InitOptions = { template: 'pytorch' }): Promise<void> {
  try {
    // Get project name if not provided
    if (!projectName) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Project name:',
          default: 'my-ml-project',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Project name is required';
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
              return 'Project name can only contain letters, numbers, hyphens, and underscores';
            }
            return true;
          }
        }
      ]);
      projectName = answers.name;
    }

    const projectPath = path.resolve(process.cwd(), projectName!);

    // Check if directory exists and is not empty
    if (fs.existsSync(projectPath)) {
      const files = fs.readdirSync(projectPath);
      if (files.length > 0 && !options.force) {
        const answers = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continue',
            message: `Directory ${projectName} is not empty. Continue anyway?`,
            default: false
          }
        ]);
        
        if (!answers.continue) {
          logger.info('Initialization cancelled');
          return;
        }
      }
    }

    // Template and model type selection
    let template = options.template;
    let modelType = 'classification';
    let includeSampleData = false;
    let includeNotebook = false;

    if (!TEMPLATES[template]) {
      const templateAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'template',
          message: 'Choose a framework:',
          choices: Object.entries(TEMPLATES).map(([key, template]) => ({
            name: `${template.name} - ${template.description}`,
            value: key
          }))
        },
        {
          type: 'list',
          name: 'modelType',
          message: 'Choose model type:',
          choices: Object.entries(MODEL_TYPES).map(([key, name]) => ({
            name,
            value: key
          }))
        },
        {
          type: 'confirm',
          name: 'includeSampleData',
          message: 'Include sample data?',
          default: true
        },
        {
          type: 'confirm',
          name: 'includeNotebook',
          message: 'Include Jupyter notebook?',
          default: true
        }
      ]);
      
      template = templateAnswers.template;
      modelType = templateAnswers.modelType;
      includeSampleData = templateAnswers.includeSampleData;
      includeNotebook = templateAnswers.includeNotebook;
    }

    const selectedTemplate = TEMPLATES[template];
    if (!selectedTemplate) {
      throw new Error(`Unknown template: ${template}`);
    }
    
    const spinner = ora(`Creating ${selectedTemplate.name} project...`).start();

    try {
      // Create project directory
      await fs.ensureDir(projectPath);

      // Create project files based on template
      await createProjectFiles(projectPath, projectName!, template, {
        modelType,
        includeSampleData,
        includeNotebook
      });

      // Initialize git if requested
      if (options.git) {
        spinner.text = 'Initializing git repository...';
        try {
          execSync('git init', { cwd: projectPath, stdio: 'pipe' });
          execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
          execSync('git commit -m "Initial commit"', { cwd: projectPath, stdio: 'pipe' });
          logger.info('Git repository initialized');
        } catch (error) {
          logger.warn('Failed to initialize git repository');
        }
      }

      // Install dependencies if requested
      if (options.install && selectedTemplate.postInstall && selectedTemplate.postInstall.length > 0) {
        spinner.text = 'Installing dependencies...';
        for (const command of selectedTemplate.postInstall) {
          try {
            execSync(command, { cwd: projectPath, stdio: 'pipe' });
          } catch (error) {
            logger.warn(`Failed to run: ${command}`);
          }
        }
      }

      // Register project with Cirron API (if authenticated)
      const config = new ConfigManager();
      const currentConfig = config.load();
      
      if (currentConfig.token) {
        spinner.text = 'Registering project with Cirron...';
        try {
          const api = new CirronApi(currentConfig);
          await api.createProject({
            name: projectName!,
            template,
            path: projectPath
          });
          logger.info('Project registered with Cirron');
        } catch (error) {
          logger.warn('Failed to register project with Cirron (continuing anyway)');
        }
      }

      spinner.succeed(chalk.green(`Project ${projectName} created successfully!`));

      // Show next steps
      console.log();
      logger.info(chalk.bold('Next steps:'));
      logger.info(`  ${chalk.cyan(`cd ${projectName}`)}`);
      
      if (!options.install && selectedTemplate.postInstall && selectedTemplate.postInstall.length > 0) {
        logger.info(`  ${chalk.cyan('pip install -r requirements.txt')}`);
      }
      
      logger.info(`  ${chalk.cyan('cirron test')}`);
      logger.info(`  ${chalk.cyan('cirron build')}`);
      logger.info(`  ${chalk.cyan('cirron deploy')}`);

      if (!currentConfig.token) {
        console.log();
        logger.info(chalk.yellow('💡 Tip: Run ') + chalk.cyan('cirron auth login') + chalk.yellow(' to connect to Cirron'));
      }

    } catch (error) {
      spinner.fail(chalk.red('Project creation failed'));
      throw error;
    }

  } catch (error) {
    logger.error('Failed to initialize project:', error);
    process.exit(1);
  }
}

async function createProjectFiles(
  projectPath: string, 
  projectName: string, 
  template: string,
  options: {
    modelType: string;
    includeSampleData: boolean;
    includeNotebook: boolean;
  }
): Promise<void> {
  // Create cirron.json
  const projectConfig: ProjectConfig = {
    name: projectName,
    version: '1.0.0',
    template,
    framework: template.includes('pytorch') ? 'pytorch' : 
               template.includes('tensorflow') ? 'tensorflow' :
               template.includes('sklearn') ? 'sklearn' : 'custom',
    modelType: options.modelType,
    pythonVersion: '3.9', // TODO: get python version from user
    gpuRequired: false,
    environments: {
      development: {
        name: 'development',
        url: 'http://localhost:8000'
      },
      staging: {
        name: 'staging'
      },
      production: {
        name: 'production'
      }
    },
    build: {
      outputDir: 'dist',
      command: 'docker build -t ${PROJECT_NAME} .',
      include: ['src/**', 'requirements.txt', 'Dockerfile'],
      exclude: ['*.pyc', '__pycache__', '.pytest_cache', 'data/raw/**']
    },
    deploy: {
      provider: 'custom',
      settings: {
        containerRegistry: 'harbor',
        imageTag: '${VERSION}'
      }
    },
    artifacts: {
      modelPath: 'models/',
      checkpointPath: 'checkpoints/',
      logsPath: 'logs/'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'cirron.json'), projectConfig, { spaces: 2 });

  // Create template-specific files
  switch (template) {
    case 'pytorch':
      await createPyTorchFiles(projectPath, projectName, options);
      break;
    case 'pytorch-train':
      await createPyTorchTrainingFiles(projectPath, projectName, options);
      break;
    case 'tensorflow':
      await createTensorFlowFiles(projectPath, projectName, options);
      break;
    case 'tensorflow-train':
      await createTensorFlowTrainingFiles(projectPath, projectName, options);
      break;
    case 'sklearn':
      await createSklearnFiles(projectPath, projectName, options);
      break;
    case 'sklearn-pipeline':
      await createSklearnPipelineFiles(projectPath, projectName, options);
      break;
    case 'custom':
      await createCustomFiles(projectPath, projectName, options);
      break;
  }

  // Create common ML files
  await createCommonMLFiles(projectPath, projectName, options);
}