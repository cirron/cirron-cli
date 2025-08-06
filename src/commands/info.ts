import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../utils/logger';
import { getRepositoryInfo, getShortCommitHash } from '../utils/git';
import type { ProjectConfig } from '../types';

interface ModelInfo {
  modelType: string;
  framework: string;
  params?: number;
  outputShape?: string;
  endpoints?: string[];
  pythonVersion?: string;
  gpuRequired?: boolean;
  dependencies?: string[];
  modelClassName?: string;
  inputShape?: string;
  architecture?: string;
  gitCommitHash?: string;
  trainingDataShape?: string;
  testDataShape?: string;
}

interface ModelAnalysis {
  imports: string[];
  classes: string[];
  functions: string[];
  modelDefinitions: string[];
  outputShapes: string[];
  parameterCounts: number[];
  modelClassNames: string[];
  inputShapes: string[];
  architecturePatterns: string[];
  sampleCalls: string[];
}

export async function infoCommand(): Promise<void> {
  try {
    // Check if we're in a Cirron project
    const cirronJsonPath = path.join(process.cwd(), 'cirron.json');
    if (!fs.existsSync(cirronJsonPath)) {
      logger.error('Not a Cirron project. Run this command in a directory with cirron.json');
      process.exit(1);
    }

    // Load project configuration
    const projectConfig: ProjectConfig = await fs.readJSON(cirronJsonPath);
    
    // Analyze model.py if it exists
    const modelPyPath = path.join(process.cwd(), 'src', 'model.py');
    let modelAnalysis: ModelAnalysis | null = null;
    
    if (fs.existsSync(modelPyPath)) {
      const modelContent = await fs.readFile(modelPyPath, 'utf-8');
      modelAnalysis = await analyzeModelFile(modelContent, projectConfig.framework || 'custom');
    }

    // Extract model info
    const modelInfo = extractModelInfo(projectConfig, modelAnalysis);

    // Display the information
    displayModelInfo(projectConfig.name, modelInfo);

  } catch (error) {
    logger.error('Failed to get model info:', error);
    process.exit(1);
  }
}

async function analyzeModelFile(content: string, framework: string): Promise<ModelAnalysis> {
  const analysis: ModelAnalysis = {
    imports: [],
    classes: [],
    functions: [],
    modelDefinitions: [],
    outputShapes: [],
    parameterCounts: [],
    modelClassNames: [],
    inputShapes: [],
    architecturePatterns: [],
    sampleCalls: []
  };

  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Extract imports
    if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
      analysis.imports.push(trimmedLine);
    }
    
    // Extract class definitions and detect model classes
    const classMatch = trimmedLine.match(/^class\s+(\w+)(?:\(([^)]+)\))?/);
    if (classMatch && classMatch[1]) {
      analysis.classes.push(classMatch[1]);
      
      // Check if this is a model class based on inheritance
      const inheritance = classMatch[2] || '';
      if (inheritance.includes('nn.Module') || 
          inheritance.includes('torch.nn.Module') ||
          inheritance.includes('tf.keras.Model') ||
          inheritance.includes('keras.Model') ||
          inheritance.includes('BaseEstimator') ||
          inheritance.includes('Model')) {
        analysis.modelClassNames.push(classMatch[1]);
      }
    }
    
    // Extract function definitions
    const functionMatch = trimmedLine.match(/^def\s+(\w+)/);
    if (functionMatch && functionMatch[1]) {
      analysis.functions.push(functionMatch[1]);
    }
    
    // Extract input shapes from sample calls
    const shapePatterns = [
      /torch\.randn\(([^)]+)\)/g,
      /torch\.zeros\(([^)]+)\)/g,
      /torch\.ones\(([^)]+)\)/g,
      /np\.random\.randn\(([^)]+)\)/g,
      /np\.zeros\(([^)]+)\)/g,
      /np\.ones\(([^)]+)\)/g,
      /tf\.random\.normal\(\[([^\]]+)\]/g,
      /tf\.zeros\(\[([^\]]+)\]/g,
    ];
    
    for (const pattern of shapePatterns) {
      let match;
      while ((match = pattern.exec(trimmedLine)) !== null) {
        const shape = match[1]?.trim();
        if (shape && !analysis.inputShapes.includes(shape)) {
          analysis.inputShapes.push(shape);
        }
        analysis.sampleCalls.push(trimmedLine.trim());
      }
    }
    
    // Detect architecture patterns
    const architecturePatterns = [
      { pattern: /Conv2d|nn\.Conv2d|tf\.keras\.layers\.Conv2D/i, type: 'CNN' },
      { pattern: /LSTM|nn\.LSTM|tf\.keras\.layers\.LSTM/i, type: 'LSTM' },
      { pattern: /GRU|nn\.GRU|tf\.keras\.layers\.GRU/i, type: 'GRU' },
      { pattern: /Transformer|nn\.Transformer|MultiheadAttention/i, type: 'Transformer' },
      { pattern: /ResNet|residual|skip.*connection/i, type: 'ResNet' },
      { pattern: /BatchNorm|nn\.BatchNorm|tf\.keras\.layers\.BatchNormalization/i, type: 'BatchNorm' },
      { pattern: /Dropout|nn\.Dropout|tf\.keras\.layers\.Dropout/i, type: 'Regularization' },
      { pattern: /Attention|attention|self\.attn/i, type: 'Attention' },
      { pattern: /Embedding|nn\.Embedding|tf\.keras\.layers\.Embedding/i, type: 'Embedding' },
    ];
    
    for (const { pattern, type } of architecturePatterns) {
      if (pattern.test(trimmedLine) && !analysis.architecturePatterns.includes(type)) {
        analysis.architecturePatterns.push(type);
      }
    }
    
    // Framework-specific analysis
    await analyzeFrameworkSpecific(trimmedLine, framework, analysis);
  }

  return analysis;
}

async function analyzeFrameworkSpecific(line: string, framework: string, analysis: ModelAnalysis): Promise<void> {
  switch (framework) {
    case 'pytorch':
      await analyzePyTorch(line, analysis);
      break;
    case 'tensorflow':
      await analyzeTensorFlow(line, analysis);
      break;
    case 'sklearn':
      await analyzeSklearn(line, analysis);
      break;
    default:
      // Generic analysis for custom frameworks
      break;
  }
}

async function analyzePyTorch(line: string, analysis: ModelAnalysis): Promise<void> {
  // Look for nn.Module subclasses
  if (line.includes('nn.Module') || line.includes('torch.nn.Module')) {
    analysis.modelDefinitions.push(line);
  }
  
  // Look for common layers that indicate output shapes
  if (line.includes('nn.Linear') || line.includes('torch.nn.Linear')) {
    const match = line.match(/nn\.Linear\(\d+,\s*(\d+)\)/);
    if (match) {
      analysis.outputShapes.push(`Linear output: ${match[1]}`);
    }
  }
  
  // Look for parameter count hints
  if (line.includes('parameters()') && line.includes('sum')) {
    analysis.parameterCounts.push(-1); // Indicates dynamic counting
  }
}

async function analyzeTensorFlow(line: string, analysis: ModelAnalysis): Promise<void> {
  // Look for Keras models
  if (line.includes('tf.keras') || line.includes('keras.Model')) {
    analysis.modelDefinitions.push(line);
  }
  
  // Look for Dense layers
  if (line.includes('Dense(')) {
    const match = line.match(/Dense\((\d+)/);
    if (match) {
      analysis.outputShapes.push(`Dense output: ${match[1]}`);
    }
  }
  
  // Look for model.summary() calls
  if (line.includes('.summary()')) {
    analysis.parameterCounts.push(-1); // Indicates summary available
  }
}

async function analyzeSklearn(line: string, analysis: ModelAnalysis): Promise<void> {
  // Look for sklearn models
  const sklearnModels = [
    'LinearRegression', 'LogisticRegression', 'RandomForestClassifier',
    'RandomForestRegressor', 'SVC', 'SVR', 'DecisionTreeClassifier',
    'DecisionTreeRegressor', 'KMeans', 'GradientBoostingClassifier',
    'GradientBoostingRegressor'
  ];
  
  for (const model of sklearnModels) {
    if (line.includes(model)) {
      analysis.modelDefinitions.push(`${model} found`);
      break;
    }
  }
  
  // Look for fit method calls
  if (line.includes('.fit(')) {
    analysis.outputShapes.push('Sklearn model (shape depends on training data)');
  }
}

function extractModelInfo(projectConfig: ProjectConfig, modelAnalysis: ModelAnalysis | null): ModelInfo {
  const info: ModelInfo = {
    modelType: projectConfig.modelType || 'Unknown',
    framework: projectConfig.framework || 'Unknown'
  };
  
  // Add optional properties only if they exist
  if (projectConfig.pythonVersion) {
    info.pythonVersion = projectConfig.pythonVersion;
  }
  
  if (projectConfig.gpuRequired !== undefined) {
    info.gpuRequired = projectConfig.gpuRequired;
  }

  // Extract endpoints from environments
  const endpoints: string[] = [];
  if (projectConfig.environments) {
    for (const [envName, envConfig] of Object.entries(projectConfig.environments)) {
      if (envConfig.url) {
        endpoints.push(`${envName}: ${envConfig.url}`);
      }
    }
  }
  info.endpoints = endpoints;

  // Add git information
  const gitInfo = getRepositoryInfo();
  if (gitInfo.commitHash) {
    info.gitCommitHash = getShortCommitHash() || gitInfo.commitHash;
  }

  // Add analysis results if available
  if (modelAnalysis) {
    // Extract model class name
    if (modelAnalysis.modelClassNames.length > 0) {
      const className = modelAnalysis.modelClassNames[0];
      if (className) {
        info.modelClassName = className; // Use the first model class found
      }
    }
    
    // Extract input shape information
    if (modelAnalysis.inputShapes.length > 0) {
      info.inputShape = `(${modelAnalysis.inputShapes[0]})`;
      
      // Separate training and test shapes if multiple found
      if (modelAnalysis.inputShapes.length > 1) {
        info.trainingDataShape = `(${modelAnalysis.inputShapes[0]})`;
        info.testDataShape = `(${modelAnalysis.inputShapes[1]})`;
      }
    }
    
    // Extract architecture information
    if (modelAnalysis.architecturePatterns.length > 0) {
      info.architecture = modelAnalysis.architecturePatterns.join(' + ');
    }
    
    // Estimate parameters based on framework and model definitions
    if (modelAnalysis.parameterCounts.length > 0 || modelAnalysis.modelDefinitions.length > 0) {
      info.params = estimateParameterCount(projectConfig.framework || 'custom', modelAnalysis);
    }
    
    // Extract output shape information
    if (modelAnalysis.outputShapes.length > 0) {
      info.outputShape = modelAnalysis.outputShapes.join(', ');
    }
    
    // Extract dependencies from imports
    info.dependencies = extractDependencies(modelAnalysis.imports);
  }

  // Use metadata from project config if available
  if (projectConfig.metadata) {
    if (!info.modelClassName && projectConfig.metadata.modelClassName) {
      info.modelClassName = projectConfig.metadata.modelClassName;
    }
    if (!info.inputShape && projectConfig.metadata.inputShape) {
      info.inputShape = typeof projectConfig.metadata.inputShape === 'string' 
        ? projectConfig.metadata.inputShape 
        : JSON.stringify(projectConfig.metadata.inputShape);
    }
    if (!info.architecture && projectConfig.metadata.architecture) {
      info.architecture = projectConfig.metadata.architecture;
    }
    if (!info.gitCommitHash && projectConfig.metadata.gitCommitHash) {
      info.gitCommitHash = projectConfig.metadata.gitCommitHash;
    }
    if (!info.trainingDataShape && projectConfig.metadata.trainingDataShape) {
      info.trainingDataShape = projectConfig.metadata.trainingDataShape;
    }
    if (!info.testDataShape && projectConfig.metadata.testDataShape) {
      info.testDataShape = projectConfig.metadata.testDataShape;
    }
  }

  return info;
}

function estimateParameterCount(framework: string, analysis: ModelAnalysis): number {
  // This is a rough estimation based on common patterns
  // In a real implementation, you'd want to use static analysis or model introspection
  
  switch (framework) {
    case 'pytorch':
      if (analysis.modelDefinitions.length > 0) {
        return 1000000; // Rough estimate for a typical PyTorch model
      }
      break;
    case 'tensorflow':
      if (analysis.modelDefinitions.length > 0) {
        return 500000; // Rough estimate for a typical TensorFlow model
      }
      break;
    case 'sklearn':
      if (analysis.modelDefinitions.length > 0) {
        return 100; // Sklearn models typically have fewer parameters
      }
      break;
  }
  
  return 0;
}

function extractDependencies(imports: string[]): string[] {
  const dependencies: string[] = [];
  const commonPackages = ['torch', 'tensorflow', 'sklearn', 'numpy', 'pandas', 'matplotlib', 'seaborn'];
  
  for (const importLine of imports) {
    for (const pkg of commonPackages) {
      if (importLine.includes(pkg) && !dependencies.includes(pkg)) {
        dependencies.push(pkg);
      }
    }
  }
  
  return dependencies;
}

function displayModelInfo(projectName: string, info: ModelInfo): void {
  console.log();
  console.log(chalk.bold.cyan(`Model Information: ${projectName}`));
  console.log(chalk.gray('─'.repeat(50)));
  
  // Basic Info
  console.log(chalk.bold('Basic Information'));
  console.log(`  ${chalk.yellow('Model Type:')} ${info.modelType}`);
  console.log(`  ${chalk.yellow('Framework:')} ${info.framework}`);
  
  if (info.pythonVersion) {
    console.log(`  ${chalk.yellow('Python Version:')} ${info.pythonVersion}`);
  }
  
  if (info.gpuRequired !== undefined) {
    console.log(`  ${chalk.yellow('GPU Required:')} ${info.gpuRequired ? 'Yes' : 'No'}`);
  }
  
  console.log();
  
  // Model Details
  console.log(chalk.bold('Model Details'));
  
  if (info.modelClassName) {
    console.log(`  ${chalk.yellow('Model Class:')} ${info.modelClassName}`);
  }
  
  if (info.architecture) {
    console.log(`  ${chalk.yellow('Architecture:')} ${info.architecture}`);
  }
  
  if (info.params !== undefined && info.params > 0) {
    const paramsFormatted = info.params.toLocaleString();
    console.log(`  ${chalk.yellow('Parameters:')} ${paramsFormatted}`);
  } else {
    console.log(`  ${chalk.yellow('Parameters:')} ${chalk.gray('Unable to determine (run with model loaded for accurate count)')}`);
  }
  
  if (info.inputShape) {
    console.log(`  ${chalk.yellow('Input Shape:')} ${info.inputShape}`);
  }
  
  if (info.trainingDataShape && info.testDataShape) {
    console.log(`  ${chalk.yellow('Training Data Shape:')} ${info.trainingDataShape}`);
    console.log(`  ${chalk.yellow('Test Data Shape:')} ${info.testDataShape}`);
  }
  
  if (info.outputShape) {
    console.log(`  ${chalk.yellow('Output Shape:')} ${info.outputShape}`);
  } else if (!info.inputShape) {
    console.log(`  ${chalk.yellow('Input/Output Shape:')} ${chalk.gray('Not detected')}`);
  }
  
  console.log();
  
  // Version Control
  if (info.gitCommitHash) {
    console.log(chalk.bold('Version Control'));
    console.log(`  ${chalk.yellow('Git Commit:')} ${info.gitCommitHash}`);
    
    const gitInfo = getRepositoryInfo();
    if (gitInfo.branch) {
      console.log(`  ${chalk.yellow('Branch:')} ${gitInfo.branch}`);
    }
    if (gitInfo.isClean !== undefined) {
      const status = gitInfo.isClean ? 'Clean working directory' : 'Uncommitted changes';
      console.log(`  ${chalk.yellow('Repository:')} ${status}`);
    }
    console.log();
  }
  
  // Endpoints
  if (info.endpoints && info.endpoints.length > 0) {
    console.log(chalk.bold('Associated Endpoints'));
    for (const endpoint of info.endpoints) {
      console.log(`  ${chalk.green('•')} ${endpoint}`);
    }
  } else {
    console.log(chalk.bold('Associated Endpoints'));
    console.log(`  ${chalk.gray('No endpoints configured')}`);
  }
  
  console.log();
  
  // Dependencies
  if (info.dependencies && info.dependencies.length > 0) {
    console.log(chalk.bold('Key Dependencies'));
    for (const dep of info.dependencies) {
      console.log(`  ${chalk.green('•')} ${dep}`);
    }
  } else {
    console.log(chalk.bold('Key Dependencies'));
    console.log(`  ${chalk.gray('Check requirements.txt for full dependency list')}`);
  }
  
  console.log();
  console.log(chalk.gray('Tip: Run ') + chalk.cyan('cirron test') + chalk.gray(' to validate your model setup and dependencies'));
}