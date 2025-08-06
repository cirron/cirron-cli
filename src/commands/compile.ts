import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import type { ProjectConfig } from '../types';

interface CompileOptions {
  arch?: string;
  index?: string;
  validate?: boolean;
  dryRun?: boolean;
}

export async function compileCommand(options: CompileOptions): Promise<void> {
  const spinner = ora('Preparing compilation...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Determine architecture
    const architecture = options.arch || await determineDefaultArchitecture(projectConfig);
    
    spinner.text = `Compiling for architecture: ${architecture}`;
    logger.info(`Target architecture: ${chalk.cyan(architecture)}`);

    // Load index/manifest file if specified
    let indexConfig: any = null;
    if (options.index) {
      if (!fs.existsSync(options.index)) {
        spinner.fail(chalk.red(`Index file not found: ${options.index}`));
        process.exit(1);
      }
      indexConfig = await loadIndexFile(options.index);
      logger.info(`Using index file: ${chalk.cyan(options.index)}`);
    }

    // Pre-compilation validation
    if (options.validate) {
      spinner.text = 'Running validation checks...';
      await runValidationChecks(projectConfig, indexConfig, architecture);
      logger.success('✓ Validation checks passed');
    }

    if (options.dryRun) {
      spinner.text = 'Simulating compilation (dry run)...';
      await simulateCompilation(projectConfig, architecture, indexConfig);
      spinner.succeed(chalk.green('Dry run completed successfully'));
      
      logger.info('\n📋 Compilation Plan Summary:');
      logger.info(`  • Target: ${architecture}`);
      logger.info(`  • Framework: ${projectConfig.framework || 'custom'}`);
      logger.info(`  • Python: ${projectConfig.pythonVersion || '3.9'}`);
      if (indexConfig) {
        logger.info(`  • Features: ${indexConfig.features?.length || 0}`);
        logger.info(`  • Data types: ${Object.keys(indexConfig.dataTypes || {}).length}`);
      }
      logger.info(`  • GPU required: ${projectConfig.gpuRequired ? 'Yes' : 'No'}`);
      
      return;
    }

    // Actual compilation
    spinner.text = 'Compiling model...';
    const artifacts = await performCompilation(projectConfig, architecture, indexConfig);
    
    // Post-compilation tests
    spinner.text = 'Running integrity tests...';
    await runIntegrityTests(projectConfig, artifacts);
    
    spinner.succeed(chalk.green('Compilation completed successfully'));
    
    // Display results
    logger.info('\n🎉 Compilation Results:');
    logger.info(`  • Architecture: ${chalk.cyan(architecture)}`);
    logger.info(`  • Artifacts: ${chalk.cyan(artifacts.length)} files generated`);
    artifacts.forEach(artifact => {
      logger.info(`    - ${chalk.gray(artifact)}`);
    });
    
    logger.success('Model compilation completed successfully!');

  } catch (error) {
    spinner.fail(chalk.red('Compilation failed'));
    logger.error('Error:', error);
    process.exit(1);
  }
}

async function determineDefaultArchitecture(projectConfig: ProjectConfig): Promise<string> {
  // Determine default architecture based on framework and requirements
  if (projectConfig.framework === 'pytorch') {
    return projectConfig.gpuRequired ? 'cuda' : 'cpu';
  } else if (projectConfig.framework === 'tensorflow') {
    return projectConfig.gpuRequired ? 'gpu' : 'cpu';
  } else if (projectConfig.framework === 'sklearn') {
    return 'cpu';
  }
  
  // For custom or unspecified frameworks, default to CPU
  return 'cpu';
}

async function loadIndexFile(indexPath: string): Promise<any> {
  try {
    const ext = path.extname(indexPath).toLowerCase();
    
    if (ext === '.json') {
      return await fs.readJSON(indexPath);
    } else if (ext === '.yaml' || ext === '.yml') {
      const yaml = require('yaml');
      const content = await fs.readFile(indexPath, 'utf8');
      return yaml.parse(content);
    } else {
      throw new Error(`Unsupported index file format: ${ext}. Use JSON or YAML.`);
    }
  } catch (error) {
    throw new Error(`Failed to load index file: ${error}`);
  }
}

async function runValidationChecks(
  projectConfig: ProjectConfig, 
  indexConfig: any, 
  architecture: string
): Promise<void> {
  const validationErrors: string[] = [];

  // Check required files
  const requiredFiles = [
    'src/model.py',
    'requirements.txt'
  ];

  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      validationErrors.push(`Required file missing: ${file}`);
    }
  }

  // Validate Python environment
  try {
    const pythonVersion = execSync('python3 --version', { encoding: 'utf8' }).trim();
    const versionMatch = pythonVersion.match(/Python (\d+\.\d+\.\d+)/);
    
    if (versionMatch && versionMatch[1]) {
      const versionParts = versionMatch[1].split('.');
      const major = parseInt(versionParts[0] || '0');
      const minor = parseInt(versionParts[1] || '0');
      const requiredParts = (projectConfig.pythonVersion || '3.9').split('.');
      const requiredMajor = parseInt(requiredParts[0] || '3');
      const requiredMinor = parseInt(requiredParts[1] || '9');
      
      if (major < requiredMajor || (major === requiredMajor && minor < requiredMinor)) {
        validationErrors.push(`Python ${projectConfig.pythonVersion || '3.9'}+ required, found ${major}.${minor}`);
      }
    }
  } catch (error) {
    validationErrors.push('Python3 not available');
  }

  // Architecture-specific validation
  if (architecture === 'cuda' || architecture === 'gpu') {
    if (!projectConfig.gpuRequired) {
      logger.warn('GPU architecture selected but project does not require GPU');
    }
    
    // Check CUDA availability for PyTorch
    if (projectConfig.framework === 'pytorch') {
      try {
        const testScript = 'import torch; assert torch.cuda.is_available()';
        execSync(`python3 -c "${testScript}"`, { stdio: 'pipe' });
      } catch (error) {
        validationErrors.push('CUDA not available for PyTorch');
      }
    }
    
    // Check GPU availability for TensorFlow
    if (projectConfig.framework === 'tensorflow') {
      try {
        const testScript = 'import tensorflow as tf; assert len(tf.config.list_physical_devices("GPU")) > 0';
        execSync(`python3 -c "${testScript}"`, { stdio: 'pipe' });
      } catch (error) {
        validationErrors.push('GPU not available for TensorFlow');
      }
    }
  }

  // Validate index configuration if provided
  if (indexConfig) {
    if (!indexConfig.features || !Array.isArray(indexConfig.features)) {
      validationErrors.push('Index file missing or invalid features array');
    }
    
    if (!indexConfig.dataTypes || typeof indexConfig.dataTypes !== 'object') {
      validationErrors.push('Index file missing or invalid dataTypes object');
    }
  }

  // Model validation
  try {
    const testScript = `
import sys
sys.path.append('src')
from model import create_model

# Test model creation
model = create_model()
print('Model validation passed')
`;
    execSync(`python3 -c "${testScript}"`, { stdio: 'pipe' });
  } catch (error) {
    validationErrors.push('Model creation failed during validation');
  }

  if (validationErrors.length > 0) {
    throw new Error(`Validation failed:\n${validationErrors.map(err => `  • ${err}`).join('\n')}`);
  }
}

async function simulateCompilation(
  _projectConfig: ProjectConfig,
  architecture: string,
  _indexConfig: any
): Promise<void> {
  // Simulate compilation steps without actually performing them
  
  logger.info('📋 Compilation simulation:');
  
  // Step 1: Environment setup
  await new Promise(resolve => setTimeout(resolve, 500));
  logger.info('  ✓ Environment setup simulation');
  
  // Step 2: Dependencies
  await new Promise(resolve => setTimeout(resolve, 300));
  logger.info('  ✓ Dependencies resolution simulation');
  
  // Step 3: Model compilation
  await new Promise(resolve => setTimeout(resolve, 800));
  logger.info('  ✓ Model compilation simulation');
  
  // Step 4: Architecture optimization
  await new Promise(resolve => setTimeout(resolve, 600));
  logger.info(`  ✓ ${architecture} optimization simulation`);
  
  // Step 5: Artifact generation
  await new Promise(resolve => setTimeout(resolve, 400));
  logger.info('  ✓ Artifact generation simulation');
}

async function performCompilation(
  projectConfig: ProjectConfig,
  architecture: string,
  indexConfig: any
): Promise<string[]> {
  const artifacts: string[] = [];
  
  // Ensure output directories exist
  const outputDirs = ['models', 'artifacts', 'build'];
  for (const dir of outputDirs) {
    await fs.ensureDir(dir);
  }

  // Create compilation script based on framework
  const compilationScript = generateCompilationScript(projectConfig, architecture, indexConfig);
  const scriptPath = 'temp_compile.py';
  
  try {
    await fs.writeFile(scriptPath, compilationScript);
    
    // Run compilation
    logger.info('Executing model compilation...');
    const result = execSync(`python3 ${scriptPath}`, { 
      encoding: 'utf8',
      timeout: 300000 // 5 minute timeout
    });
    
    logger.info('Compilation output:', result);
    
    // Collect generated artifacts
    const artifactDirs = ['models', 'artifacts'];
    for (const dir of artifactDirs) {
      if (fs.existsSync(dir)) {
        const files = await fs.readdir(dir);
        artifacts.push(...files.map(f => path.join(dir, f)));
      }
    }
    
  } finally {
    // Clean up temporary script
    if (fs.existsSync(scriptPath)) {
      await fs.remove(scriptPath);
    }
  }
  
  return artifacts;
}

function generateCompilationScript(
  projectConfig: ProjectConfig,
  architecture: string,
  indexConfig: any
): string {
  const framework = projectConfig.framework || 'custom';
  
  let script = `
import sys
import os
import json
sys.path.append('src')

print("Starting compilation for ${framework} framework...")
print("Target architecture: ${architecture}")
`;

  // Framework-specific compilation logic
  if (framework === 'pytorch') {
    script += `
from model import create_model
import torch

# Create model
model = create_model()
print("Model created successfully")

# Optimize for architecture
if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model moved to CUDA")
    else:
        print("Warning: CUDA not available, using CPU")

# Save compiled model
os.makedirs('models', exist_ok=True)
torch.save(model.state_dict(), 'models/model_${architecture}.pth')
print("Model saved to models/model_${architecture}.pth")

# Save model info
model_info = {
    "framework": "pytorch",
    "architecture": "${architecture}",
    "parameters": sum(p.numel() for p in model.parameters()),
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else if (framework === 'tensorflow') {
    script += `
from model import create_model
import tensorflow as tf

# Create model
model = create_model()
print("Model created successfully")

# Architecture-specific optimization
if "${architecture}" == "gpu":
    with tf.device('/GPU:0'):
        print("Using GPU for compilation")
else:
    with tf.device('/CPU:0'):
        print("Using CPU for compilation")

# Save compiled model
os.makedirs('models', exist_ok=True)
model.save('models/model_${architecture}')
print("Model saved to models/model_${architecture}")

# Save model info
model_info = {
    "framework": "tensorflow",
    "architecture": "${architecture}",
    "parameters": model.count_params(),
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else if (framework === 'sklearn') {
    script += `
from model import create_model
import joblib

# Create model
model = create_model()
print("Model created successfully")

# Save model
os.makedirs('models', exist_ok=True)
joblib.dump(model, 'models/model_${architecture}.joblib')
print("Model saved to models/model_${architecture}.joblib")

# Save model info
model_info = {
    "framework": "sklearn",
    "architecture": "${architecture}",
    "model_type": type(model).__name__,
    "compilation_time": "$(date)"
}
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  } else {
    script += `
from model import create_model

# Create model
model = create_model()
print("Model created successfully")

# Generic model info
model_info = {
    "framework": "custom",
    "architecture": "${architecture}",
    "compilation_time": "$(date)"
}
os.makedirs('artifacts', exist_ok=True)
with open('artifacts/model_info.json', 'w') as f:
    json.dump(model_info, f, indent=2)
`;
  }

  // Add index configuration handling if provided
  if (indexConfig) {
    script += `
# Save index configuration
index_config = ${JSON.stringify(indexConfig)}
with open('artifacts/index_config.json', 'w') as f:
    json.dump(index_config, f, indent=2)
print("Index configuration saved")
`;
  }

  script += `
print("Compilation completed successfully")
`;

  return script;
}

async function runIntegrityTests(projectConfig: ProjectConfig, artifacts: string[]): Promise<void> {
  // Test model loading and basic functionality
  const framework = projectConfig.framework || 'custom';
  
  const testScript = `
import sys
import os
sys.path.append('src')

print("Running integrity tests...")

# Test model files exist
required_files = ${JSON.stringify(artifacts)}
for file_path in required_files:
    if not os.path.exists(file_path):
        raise Exception(f"Artifact missing: {file_path}")
print("✓ All artifacts present")

# Test model loading based on framework
if "${framework}" == "pytorch":
    import torch
    from model import create_model
    
    model = create_model()
    
    # Try loading compiled model
    for artifact in required_files:
        if artifact.endswith('.pth'):
            model.load_state_dict(torch.load(artifact, map_location='cpu'))
            print("✓ PyTorch model loaded successfully")
            break
            
elif "${framework}" == "tensorflow":
    import tensorflow as tf
    
    # Try loading compiled model
    for artifact in required_files:
        if 'model_' in artifact and not artifact.endswith('.json'):
            model = tf.keras.models.load_model(artifact)
            print("✓ TensorFlow model loaded successfully")
            break
            
elif "${framework}" == "sklearn":
    import joblib
    
    # Try loading compiled model
    for artifact in required_files:
        if artifact.endswith('.joblib'):
            model = joblib.load(artifact)
            print("✓ Scikit-learn model loaded successfully")
            break

# Test basic data processing if sample data exists
if os.path.exists('data/sample'):
    print("✓ Sample data directory found")
    import pandas as pd
    sample_files = [f for f in os.listdir('data/sample') if f.endswith('.csv')]
    if sample_files:
        data = pd.read_csv(f'data/sample/{sample_files[0]}')
        if len(data) > 0:
            print("✓ Sample data can be loaded")
        else:
            print("⚠ Sample data is empty")

print("Integrity tests completed successfully")
`;

  const tempScriptPath = 'temp_integrity_test.py';
  
  try {
    await fs.writeFile(tempScriptPath, testScript);
    execSync(`python3 ${tempScriptPath}`, { stdio: 'pipe' });
    
  } finally {
    if (fs.existsSync(tempScriptPath)) {
      await fs.remove(tempScriptPath);
    }
  }
}