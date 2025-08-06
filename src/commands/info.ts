import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { logger } from '../utils/logger';
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
}

interface ModelAnalysis {
  imports: string[];
  classes: string[];
  functions: string[];
  modelDefinitions: string[];
  outputShapes: string[];
  parameterCounts: number[];
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
    parameterCounts: []
  };

  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmedLine = line.trim();
    
    // Extract imports
    if (trimmedLine.startsWith('import ') || trimmedLine.startsWith('from ')) {
      analysis.imports.push(trimmedLine);
    }
    
    // Extract class definitions
    const classMatch = trimmedLine.match(/^class\s+(\w+)/);
    if (classMatch && classMatch[1]) {
      analysis.classes.push(classMatch[1]);
    }
    
    // Extract function definitions
    const functionMatch = trimmedLine.match(/^def\s+(\w+)/);
    if (functionMatch && functionMatch[1]) {
      analysis.functions.push(functionMatch[1]);
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

  // Add analysis results if available
  if (modelAnalysis) {
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
  
  if (info.params !== undefined && info.params > 0) {
    const paramsFormatted = info.params.toLocaleString();
    console.log(`  ${chalk.yellow('Parameters:')} ${paramsFormatted}`);
  } else {
    console.log(`  ${chalk.yellow('Parameters:')} ${chalk.gray('Unable to determine (run with model loaded for accurate count)')}`);
  }
  
  if (info.outputShape) {
    console.log(`  ${chalk.yellow('Output Shape:')} ${info.outputShape}`);
  } else {
    console.log(`  ${chalk.yellow('Output Shape:')} ${chalk.gray('Not detected')}`);
  }
  
  console.log();
  
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
}