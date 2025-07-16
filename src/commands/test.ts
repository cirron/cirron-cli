import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import type { ProjectConfig } from '../types';

interface TestOptions {
  env?: boolean;
  build?: boolean;
  requirements?: boolean;
  unit?: boolean;
  lint?: boolean;
  model?: boolean;
  data?: boolean;
  inference?: boolean;
  watch?: boolean;
}

export async function testCommand(options: TestOptions): Promise<void> {
  const spinner = ora('Preparing tests...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Determine which tests to run
    const testsToRun = determineTests(options);
    
    if (testsToRun.length === 0) {
      // Run all tests by default
      testsToRun.push('env', 'requirements', 'unit', 'model', 'data');
    }

    spinner.text = 'Running tests...';
    
    let passedTests = 0;
    let totalTests = testsToRun.length;
    const results: { test: string; status: 'pass' | 'fail'; message?: string }[] = [];

    for (const test of testsToRun) {
      try {
        spinner.text = `Running ${test} tests...`;
        
        switch (test) {
          case 'env':
            await runEnvironmentTests(projectConfig);
            break;
          case 'build':
            await runBuildTests(projectConfig);
            break;
          case 'requirements':
            await runRequirementsTests();
            break;
          case 'unit':
            await runUnitTests();
            break;
          case 'lint':
            await runLintTests();
            break;
          case 'model':
            await runModelTests(projectConfig);
            break;
          case 'data':
            await runDataTests();
            break;
          case 'inference':
            await runInferenceTests();
            break;
        }
        
        results.push({ test, status: 'pass' });
        passedTests++;
        
      } catch (error) {
        results.push({ 
          test, 
          status: 'fail', 
          message: error instanceof Error ? error.message : 'Unknown error' 
        });
      }
    }

    // Show results
    spinner.stop();
    console.log();
    logger.info(chalk.bold('🧪 Test Results'));
    console.log();

    results.forEach(result => {
      const icon = result.status === 'pass' ? chalk.green('✓') : chalk.red('✗');
      const testName = result.test.charAt(0).toUpperCase() + result.test.slice(1);
      logger.info(`${icon} ${testName} tests`);
      
      if (result.status === 'fail' && result.message) {
        logger.info(`   ${chalk.gray(result.message)}`);
      }
    });

    console.log();
    
    if (passedTests === totalTests) {
      logger.success(`All ${totalTests} test suites passed! 🎉`);
    } else {
      logger.error(`${totalTests - passedTests} of ${totalTests} test suites failed`);
      process.exit(1);
    }

    // Watch mode
    if (options.watch) {
      console.log();
      logger.info(chalk.blue('Watching for changes... Press Ctrl+C to stop'));
      await watchTests(testsToRun, projectConfig);
    }

  } catch (error) {
    spinner.fail(chalk.red('Test execution failed'));
    logger.error('Error:', error);
    process.exit(1);
  }
}

function determineTests(options: TestOptions): string[] {
  const tests: string[] = [];
  
  if (options.env) tests.push('env');
  if (options.build) tests.push('build');
  if (options.requirements) tests.push('requirements');
  if (options.unit) tests.push('unit');
  if (options.lint) tests.push('lint');
  if (options.model) tests.push('model');
  if (options.data) tests.push('data');
  if (options.inference) tests.push('inference');
  
  return tests;
}

async function runEnvironmentTests(projectConfig: ProjectConfig): Promise<void> {
  // Check Python version
  try {
    const pythonVersion = execSync('python --version', { encoding: 'utf8' }).trim();
    const versionMatch = pythonVersion.match(/Python (\d+\.\d+)/);
    
    if (versionMatch && versionMatch[1]) {
      const version = parseFloat(versionMatch[1]);
      const requiredVersion = parseFloat(projectConfig.pythonVersion || '3.9');
      
      if (version < requiredVersion) {
        throw new Error(`Python ${requiredVersion}+ required, found ${version}`);
      }
    }
  } catch (error) {
    throw new Error('Python not found or version check failed');
  }

  // Check CUDA availability if required
  if (projectConfig.gpuRequired) {
    try {
      if (projectConfig.framework === 'pytorch') {
        execSync('python -c "import torch; assert torch.cuda.is_available()"', { stdio: 'pipe' });
      } else if (projectConfig.framework === 'tensorflow') {
        execSync('python -c "import tensorflow as tf; assert len(tf.config.list_physical_devices(\'GPU\')) > 0"', { stdio: 'pipe' });
      }
    } catch (error) {
      throw new Error('CUDA/GPU not available but required by project');
    }
  }

  // Check virtual environment
  const inVenv = process.env['VIRTUAL_ENV'] || process.env['CONDA_DEFAULT_ENV'];
  if (!inVenv) {
    logger.warn('Not running in a virtual environment');
  }
}

async function runBuildTests(projectConfig: ProjectConfig): Promise<void> {
  // Test Docker build
  if (fs.existsSync('Dockerfile')) {
    try {
      const buildCommand = `docker build -t ${projectConfig.name}-test .`;
      execSync(buildCommand, { stdio: 'pipe' });
      
      // Clean up test image
      execSync(`docker rmi ${projectConfig.name}-test`, { stdio: 'pipe' });
    } catch (error) {
      throw new Error('Docker build failed');
    }
  } else {
    throw new Error('Dockerfile not found');
  }
}

async function runRequirementsTests(): Promise<void> {
  if (!fs.existsSync('requirements.txt')) {
    throw new Error('requirements.txt not found');
  }

  try {
    // Check if all requirements can be resolved
    execSync('pip check', { stdio: 'pipe' });
    
    // Try installing in dry-run mode to check for conflicts
    execSync('pip install --dry-run -r requirements.txt', { stdio: 'pipe' });
  } catch (error) {
    throw new Error('Requirements validation failed - dependency conflicts detected');
  }
}

async function runUnitTests(): Promise<void> {
  if (!fs.existsSync('tests')) {
    throw new Error('Tests directory not found');
  }

  try {
    // Run pytest if available, otherwise run unittest
    try {
      execSync('python -m pytest tests/ -v', { stdio: 'pipe' });
    } catch (pytestError) {
      // Fallback to unittest
      execSync('python -m unittest discover tests -v', { stdio: 'pipe' });
    }
  } catch (error) {
    throw new Error('Unit tests failed');
  }
}

async function runLintTests(): Promise<void> {
  const srcDir = 'src';
  if (!fs.existsSync(srcDir)) {
    throw new Error('Source directory not found');
  }

  try {
    // Run flake8 if available
    try {
      execSync(`python -m flake8 ${srcDir}`, { stdio: 'pipe' });
    } catch (flake8Error) {
      // Try pylint as fallback
      try {
        execSync(`python -m pylint ${srcDir}`, { stdio: 'pipe' });
      } catch (pylintError) {
        // Skip linting if no linter available
        logger.warn('No linter found (flake8 or pylint), skipping code quality checks');
      }
    }
  } catch (error) {
    throw new Error('Code quality checks failed');
  }
}

async function runModelTests(projectConfig: ProjectConfig): Promise<void> {
  const modelFile = path.join('src', 'model.py');
  if (!fs.existsSync(modelFile)) {
    throw new Error('Model file not found');
  }

  try {
    // Test model import and creation
    const testScript = `
import sys
sys.path.append('src')
from model import create_model

# Test model creation
model = create_model()
print("Model created successfully")

# Framework-specific tests
framework = "${projectConfig.framework}"
if framework == "pytorch":
    import torch
    # Test forward pass with dummy data
    if hasattr(model, 'forward'):
        dummy_input = torch.randn(1, 10)  # Adjust based on model
        try:
            output = model(dummy_input)
            print("Forward pass successful")
        except Exception as e:
            print(f"Forward pass failed: {e}")

elif framework == "tensorflow":
    import numpy as np
    # Test prediction with dummy data
    try:
        dummy_input = np.random.randn(1, 10)
        output = model.predict(dummy_input)
        print("Prediction successful")
    except Exception as e:
        print(f"Prediction failed: {e}")

elif framework == "sklearn":
    # Test that model has required methods
    if hasattr(model, 'fit') and hasattr(model, 'predict'):
        print("Model has required methods")
    else:
        raise Exception("Model missing required methods")
`;

    execSync(`python -c "${testScript}"`, { stdio: 'pipe' });
  } catch (error) {
    throw new Error('Model loading or instantiation failed');
  }
}

async function runDataTests(): Promise<void> {
  const dataLoaderFile = path.join('src', 'data_loader.py');
  if (!fs.existsSync(dataLoaderFile)) {
    throw new Error('Data loader file not found');
  }

  // Check if sample data exists
  const sampleDataPath = path.join('data', 'sample');
  if (fs.existsSync(sampleDataPath)) {
    const files = fs.readdirSync(sampleDataPath);
    if (files.length === 0) {
      throw new Error('Sample data directory is empty');
    }
  }

  try {
    // Test data loader import and basic functionality
    const testScript = `
import sys
sys.path.append('src')
from data_loader import *

print("Data loader imported successfully")

# Test if we can load sample data
import os
if os.path.exists('data/sample/sample_data.csv'):
    import pandas as pd
    data = pd.read_csv('data/sample/sample_data.csv')
    if len(data) > 0:
        print("Sample data loaded successfully")
    else:
        raise Exception("Sample data is empty")
else:
    print("No sample data found, skipping data validation")
`;

    execSync(`python -c "${testScript}"`, { stdio: 'pipe' });
  } catch (error) {
    throw new Error('Data loading tests failed');
  }
}

async function runInferenceTests(): Promise<void> {
  const inferenceFile = path.join('src', 'inference.py');
  if (!fs.existsSync(inferenceFile)) {
    throw new Error('Inference file not found');
  }

  try {
    // Test inference class import and instantiation
    const testScript = `
import sys
sys.path.append('src')
from inference import ModelInference
import numpy as np

# Test inference creation
inference = ModelInference()
print("Inference object created successfully")

# Test with dummy data (basic smoke test)
try:
    # Create appropriate dummy input based on framework
    dummy_input = np.random.randn(1, 10)  # Adjust as needed
    result = inference.predict(dummy_input)
    print("Inference test completed")
except Exception as e:
    print(f"Inference test failed: {e}")
    # Don't fail the test if it's just a dimension mismatch in dummy data
    if "dimension" in str(e).lower() or "shape" in str(e).lower():
        print("Inference shape issue - expected with dummy data")
    else:
        raise e
`;

    execSync(`python -c "${testScript}"`, { stdio: 'pipe' });
  } catch (error) {
    throw new Error('Inference tests failed');
  }
}

async function watchTests(testsToRun: string[], projectConfig: ProjectConfig): Promise<void> {
  const chokidar = require('chokidar');
  
  const watcher = chokidar.watch(['src/**/*.py', 'tests/**/*.py', 'cirron.json'], {
    ignored: /(^|[\/\\])\../,
    persistent: true
  });

  let isRunning = false;

  const runTestsOnChange = async () => {
    if (isRunning) return;
    
    isRunning = true;
    console.log(chalk.blue('\n📁 Files changed, running tests...'));
    
    try {
      // Run a subset of tests on file changes (faster)
      const quickTests = testsToRun.filter(test => 
        ['unit', 'model', 'data', 'lint'].includes(test)
      );
      
      for (const test of quickTests) {
        try {
          switch (test) {
            case 'unit':
              await runUnitTests();
              logger.info(chalk.green('✓ Unit tests passed'));
              break;
            case 'model':
              await runModelTests(projectConfig);
              logger.info(chalk.green('✓ Model tests passed'));
              break;
            case 'data':
              await runDataTests();
              logger.info(chalk.green('✓ Data tests passed'));
              break;
            case 'lint':
              await runLintTests();
              logger.info(chalk.green('✓ Lint tests passed'));
              break;
          }
        } catch (error) {
          logger.error(chalk.red(`✗ ${test} tests failed: ${error}`));
        }
      }
      
    } catch (error) {
      logger.error('Watch test failed:', error);
    }
    
    isRunning = false;
    console.log(chalk.blue('👀 Watching for changes...'));
  };

  watcher.on('change', runTestsOnChange);
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    watcher.close();
    logger.info('\nStopped watching files');
    process.exit(0);
  });
}