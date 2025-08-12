import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger';
import { PlanGenerator } from '../utils/plan';
import { PlanFormatter } from '../utils/plan-formatter';
import { PlanStorage } from '../utils/plan-storage';
import { PlanDiffAnalyzer } from '../utils/plan-diff';
import { executePythonScript, handleExecutionResult } from '../utils/execution';
import { handleCLIError, CLIError, CLIErrorCode } from '../utils/errors';
import type { ProjectConfig, PlanOptions, PlanCompareOptions, PlanSaveOptions } from '../types';
import inquirer from 'inquirer';

// Plan compile subcommand
export async function planCompileCommand(options: PlanOptions): Promise<void> {
  const spinner = ora('Generating compilation plan...').start();
  const strictMode = false; // Plans don't use strict mode

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(CLIErrorCode.PROJECT_NOT_FOUND);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Determine architecture
    const architecture = options.arch || await determineDefaultArchitecture(projectConfig);
    
    spinner.text = `Planning compilation for architecture: ${architecture}`;
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

    // Pre-compilation validation if requested
    if (options.validate) {
      spinner.text = 'Running validation checks...';
      await runValidationChecks(projectConfig, indexConfig, architecture, strictMode);
      logger.success('✓ Validation checks passed');
    }

    // Generate comprehensive compilation plan
    const planGenerator = new PlanGenerator(projectConfig, process.cwd());
    const plan = await planGenerator.generatePlan('compile', architecture, indexConfig);
    
    // Simulate compilation steps
    await simulateCompilation(projectConfig, architecture, indexConfig);
    
    spinner.succeed(chalk.green('Compilation plan generated successfully'));
    
    // Save plan if requested
    if (options.save) {
      const filename = typeof options.save === 'string' ? options.save : undefined;
      const saveOptions: { filename?: string; description?: string; tags?: string[] } = {};
      if (filename) {
        saveOptions.filename = filename;
      }
      await PlanStorage.savePlan(plan, saveOptions);
    }
    
    // Format and display the plan
    if (options.json) {
      console.log(PlanFormatter.formatJSON(plan, true));
    } else {
      const formatOptions = {
        useColors: process.stdout.isTTY,
        showDetails: options.verbose || false,
        compact: false
      };
      console.log('\n' + PlanFormatter.formatConsole(plan, formatOptions));
    }

  } catch (error) {
    spinner.fail(chalk.red('Plan generation failed'));
    
    if (error instanceof CLIError) {
      handleCLIError(error, strictMode, options.verbose);
    } else {
      const errorDetails: any = {
        code: CLIErrorCode.COMPILE_FAILED,
        message: error instanceof Error ? error.message : String(error),
        suggestions: [
          'Check project configuration and dependencies',
          'Verify that model files exist',
          'Try running with --validate flag'
        ],
        recoverable: true
      };
      
      if (error instanceof Error) {
        errorDetails.cause = error;
      }
      
      const planError = new CLIError(errorDetails);
      handleCLIError(planError, strictMode, options.verbose);
    }
  }
}

// Plan build subcommand
export async function planBuildCommand(options: PlanOptions): Promise<void> {
  const spinner = ora('Generating build plan...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Check if this is an ML project
    const isMLProject = projectConfig.framework && ['pytorch', 'tensorflow', 'sklearn'].includes(projectConfig.framework);
    
    if (!isMLProject) {
      spinner.fail(chalk.red('Build planning is currently only supported for ML projects'));
      logger.error('Specify a framework in cirron.json (pytorch, tensorflow, sklearn)');
      process.exit(1);
    }
    
    // Determine architecture
    const architecture = options.arch || await determineDefaultArchitecture(projectConfig);
    
    spinner.text = `Planning build for architecture: ${architecture}`;
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

    // Pre-build validation if requested
    if (options.validate) {
      spinner.text = 'Running validation checks...';
      await runValidationChecks(projectConfig, indexConfig, architecture, false);
      logger.success('✓ Validation checks passed');
    }

    // Generate comprehensive build plan
    const planGenerator = new PlanGenerator(projectConfig, process.cwd());
    const plan = await planGenerator.generatePlan('build', architecture, indexConfig);
    
    // Simulate build steps
    await simulateMLBuild(projectConfig, architecture, indexConfig);
    
    spinner.succeed(chalk.green('Build plan generated successfully'));
    
    // Save plan if requested
    if (options.save) {
      const filename = typeof options.save === 'string' ? options.save : undefined;
      const saveOptions: { filename?: string; description?: string; tags?: string[] } = {};
      if (filename) {
        saveOptions.filename = filename;
      }
      await PlanStorage.savePlan(plan, saveOptions);
    }
    
    // Format and display the plan
    if (options.json) {
      console.log(PlanFormatter.formatJSON(plan, true));
    } else {
      const formatOptions = {
        useColors: process.stdout.isTTY,
        showDetails: options.verbose || false,
        compact: false
      };
      console.log('\n' + PlanFormatter.formatConsole(plan, formatOptions));
    }

  } catch (error) {
    spinner.fail(chalk.red('Build plan generation failed'));
    
    if (error instanceof Error) {
      logger.error(error.message);
    } else {
      logger.error('Unknown error occurred');
    }
    
    process.exit(1);
  }
}

// Plan lint subcommand
export async function planLintCommand(options: PlanOptions): Promise<void> {
  const spinner = ora('Analyzing linting scope...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Analyze files that would be linted
    const lintPlan = await generateLintPlan(projectConfig);
    
    spinner.succeed(chalk.green('Lint plan generated successfully'));
    
    // Save plan if requested
    if (options.save) {
      const filename = typeof options.save === 'string' ? options.save : `lint-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await fs.writeJson(filename, lintPlan, { spaces: 2 });
      logger.info(`Lint plan saved to: ${filename}`);
    }
    
    // Format and display the plan
    if (options.json) {
      console.log(JSON.stringify(lintPlan, null, 2));
    } else {
      formatLintPlan(lintPlan, options);
    }

  } catch (error) {
    spinner.fail(chalk.red('Lint plan generation failed'));
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Plan test subcommand
export async function planTestCommand(options: PlanOptions): Promise<void> {
  const spinner = ora('Analyzing test suite...').start();

  try {
    // Load project configuration
    const projectConfigPath = path.join(process.cwd(), 'cirron.json');
    
    if (!fs.existsSync(projectConfigPath)) {
      spinner.fail(chalk.red('No cirron.json found'));
      logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
      process.exit(1);
    }

    const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
    
    // Analyze test suite setup
    const testPlan = await generateTestPlan(projectConfig);
    
    spinner.succeed(chalk.green('Test plan generated successfully'));
    
    // Save plan if requested
    if (options.save) {
      const filename = typeof options.save === 'string' ? options.save : `test-plan-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await fs.writeJson(filename, testPlan, { spaces: 2 });
      logger.info(`Test plan saved to: ${filename}`);
    }
    
    // Format and display the plan
    if (options.json) {
      console.log(JSON.stringify(testPlan, null, 2));
    } else {
      formatTestPlan(testPlan, options);
    }

  } catch (error) {
    spinner.fail(chalk.red('Test plan generation failed'));
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Plan diff subcommand
export async function planDiffCommand(planFileA: string, planFileB: string, options: PlanOptions): Promise<void> {
  const spinner = ora('Comparing plans...').start();

  try {
    // Load both plans
    const savedPlanA = await PlanStorage.loadPlan(planFileA);
    const savedPlanB = await PlanStorage.loadPlan(planFileB);
    
    // Validate plans
    const validationA = PlanStorage.validatePlan(savedPlanA);
    const validationB = PlanStorage.validatePlan(savedPlanB);
    
    if (!validationA.valid || !validationB.valid) {
      spinner.fail(chalk.red('Invalid plan files'));
      if (!validationA.valid) {
        logger.error(`Plan A errors: ${validationA.errors.join(', ')}`);
      }
      if (!validationB.valid) {
        logger.error(`Plan B errors: ${validationB.errors.join(', ')}`);
      }
      process.exit(1);
    }
    
    // Compare plans
    const comparison = PlanDiffAnalyzer.comparePlans(savedPlanA.plan, savedPlanB.plan);
    
    spinner.succeed(chalk.green('Plan comparison completed'));
    
    // Save comparison if requested
    if (options.save) {
      const filename = typeof options.save === 'string' ? options.save : `plan-diff-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      await fs.writeJson(filename, comparison, { spaces: 2 });
      logger.info(`Comparison saved to: ${filename}`);
    }
    
    // Format and display the comparison
    if (options.json) {
      console.log(JSON.stringify(comparison, null, 2));
    } else {
      console.log('\n' + PlanDiffAnalyzer.formatComparison(comparison, process.stdout.isTTY));
    }

  } catch (error) {
    spinner.fail(chalk.red('Plan comparison failed'));
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Helper functions (moved from compile.ts and build.ts)
async function determineDefaultArchitecture(projectConfig: ProjectConfig): Promise<string> {
  if (projectConfig.framework === 'pytorch') {
    return projectConfig.gpuRequired ? 'cuda' : 'cpu';
  } else if (projectConfig.framework === 'tensorflow') {
    return projectConfig.gpuRequired ? 'gpu' : 'cpu';
  } else if (projectConfig.framework === 'sklearn') {
    return 'cpu';
  }
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
  _indexConfig: any, 
  architecture: string,
  strictMode: boolean
): Promise<void> {
  const validationErrors: string[] = [];

  // Check required files
  const requiredFiles = ['src/model.py', 'requirements.txt'];
  for (const file of requiredFiles) {
    if (!fs.existsSync(file)) {
      validationErrors.push(`Required file missing: ${file}`);
    }
  }

  // Architecture-specific validation
  if (architecture === 'cuda' || architecture === 'gpu') {
    if (projectConfig.framework === 'pytorch') {
      try {
        const testScript = 'import torch; assert torch.cuda.is_available()';
        const result = await executePythonScript(testScript, { strictMode });
        handleExecutionResult(result, strictMode);
        if (!result.success) {
          validationErrors.push('CUDA not available for PyTorch');
        }
      } catch (error) {
        validationErrors.push('CUDA not available for PyTorch');
      }
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(`Validation failed:\n${validationErrors.map(err => `  • ${err}`).join('\n')}`);
  }
}

async function simulateCompilation(_projectConfig: ProjectConfig, architecture: string, _indexConfig: any): Promise<void> {
  logger.info('Compilation simulation:');
  
  await new Promise(resolve => setTimeout(resolve, 200));
  logger.info('  ✓ Environment setup simulation');
  
  await new Promise(resolve => setTimeout(resolve, 150));
  logger.info('  ✓ Dependencies resolution simulation');
  
  await new Promise(resolve => setTimeout(resolve, 300));
  logger.info('  ✓ Model compilation simulation');
  
  await new Promise(resolve => setTimeout(resolve, 250));
  logger.info(`  ✓ ${architecture} optimization simulation`);
  
  await new Promise(resolve => setTimeout(resolve, 200));
  logger.info('  ✓ Artifact generation simulation');
}

async function simulateMLBuild(_projectConfig: ProjectConfig, architecture: string, _indexConfig: any): Promise<void> {
  logger.info('Build simulation:');
  
  await new Promise(resolve => setTimeout(resolve, 200));
  logger.info('  ✓ Environment setup simulation');
  
  await new Promise(resolve => setTimeout(resolve, 150));
  logger.info('  ✓ Dependencies resolution simulation');
  
  await new Promise(resolve => setTimeout(resolve, 300));
  logger.info('  ✓ Model build simulation');
  
  await new Promise(resolve => setTimeout(resolve, 250));
  logger.info(`  ✓ ${architecture} optimization simulation`);
  
  await new Promise(resolve => setTimeout(resolve, 200));
  logger.info('  ✓ Artifact generation simulation');
}

// Lint plan generation
async function generateLintPlan(projectConfig: ProjectConfig) {
  const lintPlan = {
    timestamp: new Date().toISOString(),
    projectName: projectConfig.name,
    framework: projectConfig.framework || 'custom',
    files: {
      config: [] as string[],
      structure: [] as string[],
      dependencies: [] as string[],
      code: [] as string[]
    },
    rules: {
      config: ['cirron.json schema validation', 'environment configuration'],
      structure: ['required files check', 'directory structure'],
      dependencies: ['requirements.txt validation', 'dependency conflicts'],
      code: ['Python syntax check', 'import validation']
    },
    expectedIssues: [] as string[]
  };

  // Check config files
  if (fs.existsSync('cirron.json')) {
    lintPlan.files.config.push('cirron.json');
  }

  // Check structure files
  const structureFiles = ['src/model.py', 'requirements.txt', 'README.md', 'Dockerfile'];
  for (const file of structureFiles) {
    if (fs.existsSync(file)) {
      lintPlan.files.structure.push(file);
    }
  }

  // Check dependency files
  if (fs.existsSync('requirements.txt')) {
    lintPlan.files.dependencies.push('requirements.txt');
  }

  // Check code files
  const codeFiles = await findPythonFiles('src');
  lintPlan.files.code = codeFiles;

  return lintPlan;
}

// Test plan generation
async function generateTestPlan(projectConfig: ProjectConfig) {
  const testPlan = {
    timestamp: new Date().toISOString(),
    projectName: projectConfig.name,
    framework: projectConfig.framework || 'custom',
    testTypes: {
      environment: { enabled: true, files: ['requirements.txt'] as string[], description: 'Python environment validation' },
      unit: { enabled: false, files: [] as string[], description: 'Unit tests with pytest' },
      model: { enabled: true, files: ['src/model.py'] as string[], description: 'Model loading and instantiation' },
      data: { enabled: false, files: [] as string[], description: 'Data loading functionality' },
      inference: { enabled: true, files: ['src/model.py'] as string[], description: 'Model inference pipeline' }
    },
    dataPaths: projectConfig.test?.dataPaths || {},
    environment: {
      pythonVersion: projectConfig.pythonVersion || '3.9',
      framework: projectConfig.framework,
      gpuRequired: projectConfig.gpuRequired || false
    },
    estimatedTime: '2-5 minutes'
  };

  // Check for test files
  if (fs.existsSync('tests')) {
    testPlan.testTypes.unit.enabled = true;
    testPlan.testTypes.unit.files = await findPythonFiles('tests');
  } else if (fs.existsSync('test')) {
    testPlan.testTypes.unit.enabled = true;
    testPlan.testTypes.unit.files = await findPythonFiles('test');
  }

  // Check for data files
  const dataDirs = ['data', 'datasets'];
  for (const dir of dataDirs) {
    if (fs.existsSync(dir)) {
      testPlan.testTypes.data.enabled = true;
      testPlan.testTypes.data.files.push(dir);
    }
  }

  return testPlan;
}

async function findPythonFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  
  if (!fs.existsSync(dir)) {
    return files;
  }
  
  const walk = async (currentDir: string): Promise<void> => {
    const items = await fs.readdir(currentDir);
    
    for (const item of items) {
      const itemPath = path.join(currentDir, item);
      const stat = await fs.stat(itemPath);
      
      if (stat.isDirectory()) {
        await walk(itemPath);
      } else if (item.endsWith('.py')) {
        files.push(itemPath);
      }
    }
  };
  
  await walk(dir);
  return files;
}

function formatLintPlan(lintPlan: any, options: PlanOptions): void {
  const useColors = process.stdout.isTTY;
  const colorize = (text: string, colorFn: (text: string) => string) => useColors ? colorFn(text) : text;
  
  console.log('\n' + colorize('Lint Plan:', chalk.bold.blue));
  console.log(colorize(`  • Project: ${lintPlan.projectName}`, chalk.gray));
  console.log(colorize(`  • Framework: ${lintPlan.framework}`, chalk.cyan));
  console.log(colorize(`  • Generated: ${new Date(lintPlan.timestamp).toLocaleString()}`, chalk.gray));
  console.log('');
  
  // Files to be checked
  console.log(colorize(' Files to Check:', chalk.bold.yellow));
  for (const [category, files] of Object.entries(lintPlan.files)) {
    if (Array.isArray(files) && files.length > 0) {
      console.log(colorize(`  • ${category}: ${files.length} files`, chalk.green));
      if (options.verbose) {
        for (const file of files) {
          console.log(colorize(`    - ${file}`, chalk.gray));
        }
      }
    }
  }
  console.log('');
  
  // Rules that will be applied
  console.log(colorize('📏 Lint Rules:', chalk.bold.magenta));
  for (const [category, rules] of Object.entries(lintPlan.rules)) {
    console.log(colorize(`  • ${category}:`, chalk.cyan));
    if (Array.isArray(rules)) {
      for (const rule of rules) {
        console.log(colorize(`    - ${rule}`, chalk.gray));
      }
    }
  }
}

function formatTestPlan(testPlan: any, options: PlanOptions): void {
  const useColors = process.stdout.isTTY;
  const colorize = (text: string, colorFn: (text: string) => string) => useColors ? colorFn(text) : text;
  
  console.log('\n' + colorize('🧪 Test Plan:', chalk.bold.blue));
  console.log(colorize(`  • Project: ${testPlan.projectName}`, chalk.gray));
  console.log(colorize(`  • Framework: ${testPlan.framework}`, chalk.cyan));
  console.log(colorize(`  • Estimated time: ${testPlan.estimatedTime}`, chalk.yellow));
  console.log('');
  
  // Test types
  console.log(colorize('🔍 Test Types:', chalk.bold.green));
  for (const [type, config] of Object.entries(testPlan.testTypes)) {
    const status = (config as any).enabled ? '✓' : '⚬';
    const statusColor = (config as any).enabled ? chalk.green : chalk.gray;
    console.log(colorize(`  ${status} ${type}: ${(config as any).description}`, statusColor));
    
    if (options.verbose && (config as any).files && (config as any).files.length > 0) {
      for (const file of (config as any).files) {
        console.log(colorize(`    - ${file}`, chalk.gray));
      }
    }
  }
  console.log('');
  
  // Environment
  console.log(colorize('🐍 Test Environment:', chalk.bold.cyan));
  console.log(colorize(`  • Python: ${testPlan.environment.pythonVersion}`, chalk.gray));
  console.log(colorize(`  • Framework: ${testPlan.environment.framework}`, chalk.gray));
  console.log(colorize(`  • GPU Required: ${testPlan.environment.gpuRequired ? 'Yes' : 'No'}`, chalk.gray));
  
  // Data paths
  if (Object.keys(testPlan.dataPaths).length > 0) {
    console.log('');
    console.log(colorize('Data Paths:', chalk.bold.magenta));
    for (const [type, path] of Object.entries(testPlan.dataPaths)) {
      console.log(colorize(`  • ${type}: ${path}`, chalk.gray));
    }
  }
}

// Plan compare command (interactive)
export async function planCompareCommand(planA?: string, planB?: string, options: PlanCompareOptions = {}): Promise<void> {
  const spinner = ora('Loading saved plans...').start();

  try {
    // If specific plans weren't provided, show interactive selection
    if (!planA || !planB) {
      const savedPlans = await PlanStorage.listPlans();
      
      if (savedPlans.length < 2) {
        spinner.fail(chalk.red('Need at least 2 saved plans to compare'));
        logger.error('Run some plan commands with --save to create comparison data');
        process.exit(1);
      }

      spinner.succeed(chalk.green(`Found ${savedPlans.length} saved plans`));

      // Interactive plan selection
      console.log('\n' + chalk.bold.blue('Select Plans to Compare:'));
      
      const planChoices = savedPlans.map((plan, index) => ({
        name: `${plan.plan.command} • ${plan.plan.framework} • ${new Date(plan.metadata.savedAt).toLocaleString()} ${plan.metadata.description ? `• ${plan.metadata.description}` : ''}`,
        value: index,
        short: `Plan ${index + 1}`
      }));

      const { planAIndex, planBIndex } = await inquirer.prompt([
        {
          type: 'list',
          name: 'planAIndex',
          message: 'Select first plan (Plan A):',
          choices: planChoices
        },
        {
          type: 'list',
          name: 'planBIndex',
          message: 'Select second plan (Plan B):',
          choices: planChoices.filter((_, index) => index !== undefined),
          validate: (input, answers) => {
            if (input === answers?.planAIndex) {
              return 'Please select a different plan for comparison';
            }
            return true;
          }
        }
      ]);

      const selectedPlanA = savedPlans[planAIndex];
      const selectedPlanB = savedPlans[planBIndex];

      if (!selectedPlanA || !selectedPlanB) {
        throw new Error('Invalid plan selection');
      }

      // Compare the selected plans
      const comparison = PlanDiffAnalyzer.comparePlans(selectedPlanA.plan, selectedPlanB.plan);

      // Display comparison
      if (options.json) {
        console.log(JSON.stringify(comparison, null, 2));
      } else {
        console.log('\n' + PlanDiffAnalyzer.formatComparison(comparison, process.stdout.isTTY));
        
        // Show enhanced diff format for dependencies
        formatEnhancedDiff(comparison, options.verbose || false);
      }

      // Save comparison if requested
      if (options.save) {
        const filename = typeof options.save === 'string' ? options.save : `plan-comparison-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        await fs.writeJson(filename, comparison, { spaces: 2 });
        logger.info(`Comparison saved to: ${filename}`);
      }

    } else {
      // Direct comparison mode (existing functionality)
      await planDiffCommand(planA, planB, options);
    }

  } catch (error) {
    spinner.fail(chalk.red('Plan comparison failed'));
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Plan save command
export async function planSaveCommand(type?: string, options: PlanSaveOptions = {}): Promise<void> {
  // Handle list option
  if (options.list) {
    const spinner = ora('Loading saved plans...').start();
    try {
      const savedPlans = await PlanStorage.listPlans();
      spinner.succeed(chalk.green(`Found ${savedPlans.length} saved plans`));
      
      if (savedPlans.length === 0) {
        console.log(chalk.yellow('\nNo saved plans found. Create some plans with save options first.'));
        return;
      }

      console.log('\n' + chalk.bold.blue('Saved Plans:'));
      for (const [index, savedPlan] of savedPlans.entries()) {
        const date = new Date(savedPlan.metadata.savedAt).toLocaleString();
        const tags = savedPlan.metadata.tags?.join(', ') || '';
        console.log(`${chalk.cyan(`${index + 1}.`)} ${chalk.bold(savedPlan.plan.command)} • ${savedPlan.plan.framework} • ${date}`);
        if (savedPlan.metadata.description) {
          console.log(`   ${chalk.gray(savedPlan.metadata.description)}`);
        }
        if (tags) {
          console.log(`   ${chalk.gray('Tags:')} ${chalk.yellow(tags)}`);
        }
        console.log(`   ${chalk.gray('File:')} ${path.basename(savedPlan.filePath)}`);
        console.log('');
      }
      return;
    } catch (error) {
      spinner.fail(chalk.red('Failed to list plans'));
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  // Handle cleanup option
  if (options.cleanup !== undefined) {
    const maxAge = options.cleanup || 30;
    const spinner = ora(`Cleaning up plans older than ${maxAge} days...`).start();
    try {
      const deletedCount = await PlanStorage.cleanupOldPlans(maxAge);
      spinner.succeed(chalk.green(`Cleaned up ${deletedCount} old plans`));
      return;
    } catch (error) {
      spinner.fail(chalk.red('Cleanup failed'));
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  }

  // Load project configuration
  const projectConfigPath = path.join(process.cwd(), 'cirron.json');
  
  if (!fs.existsSync(projectConfigPath)) {
    logger.error(chalk.red('No cirron.json found'));
    logger.error('Run ' + chalk.cyan('cirron init') + ' to initialize a project');
    process.exit(1);
  }

  const projectConfig: ProjectConfig = await fs.readJSON(projectConfigPath);
  
  // Parse tags
  const tags = options.tags ? options.tags.split(',').map(tag => tag.trim()) : undefined;
  
  // Save options
  const saveOptions = {
    filename: options.name,
    description: options.description,
    tags
  };

  // Handle --all flag
  if (options.all) {
    const spinner = ora('Generating and saving all plans...').start();
    const planTypes = ['compile', 'build', 'lint', 'test'];
    const savedPaths: string[] = [];

    try {
      for (const planType of planTypes) {
        spinner.text = `Generating ${planType} plan...`;
        const planGenerator = new PlanGenerator(projectConfig, process.cwd());
        
        let plan;
        if (planType === 'compile' || planType === 'build') {
          const architecture = await determineDefaultArchitecture(projectConfig);
          plan = await planGenerator.generatePlan(planType as 'compile' | 'build', architecture);
        } else if (planType === 'lint') {
          plan = await generateLintPlan(projectConfig);
        } else if (planType === 'test') {
          plan = await generateTestPlan(projectConfig);
        }
        
        if (plan) {
          const typeSpecificOptions = {
            ...saveOptions,
            filename: saveOptions.filename ? `${saveOptions.filename}-${planType}` : undefined
          };
          
          // Only save compile and build plans through PlanStorage (they match PlanFile interface)
          if (planType === 'compile' || planType === 'build') {
            const cleanedOptions: { filename?: string; description?: string; tags?: string[] } = {};
            if (typeSpecificOptions.filename) cleanedOptions.filename = typeSpecificOptions.filename;
            if (typeSpecificOptions.description) cleanedOptions.description = typeSpecificOptions.description;
            if (typeSpecificOptions.tags) cleanedOptions.tags = typeSpecificOptions.tags;
            
            const savedPath = await PlanStorage.savePlan(plan as any, cleanedOptions);
            savedPaths.push(savedPath);
          } else {
            // For lint and test plans, save them directly as JSON files
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filename = typeSpecificOptions.filename || `${planType}-plan-${timestamp}.json`;
            const filePath = path.join(os.homedir(), '.cirron', 'plans', filename);
            await fs.writeJson(filePath, plan, { spaces: 2 });
            savedPaths.push(filePath);
          }
        }
      }

      spinner.succeed(chalk.green(`Saved ${savedPaths.length} plans successfully`));
      
      if (options.verbose) {
        console.log('\n' + chalk.bold.blue(' Saved Plans:'));
        for (const savedPath of savedPaths) {
          console.log(`  • ${path.basename(savedPath)}`);
        }
      }

    } catch (error) {
      spinner.fail(chalk.red('Failed to save plans'));
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    
    return;
  }

  // Handle single plan type
  if (!type) {
    logger.error(chalk.red('Please specify a plan type (compile, build, lint, test) or use --all'));
    process.exit(1);
  }

  if (!['compile', 'build', 'lint', 'test'].includes(type)) {
    logger.error(chalk.red(`Invalid plan type: ${type}. Use: compile, build, lint, test`));
    process.exit(1);
  }

  const spinner = ora(`Generating and saving ${type} plan...`).start();

  try {
    let plan;
    
    if (type === 'compile' || type === 'build') {
      const architecture = await determineDefaultArchitecture(projectConfig);
      const planGenerator = new PlanGenerator(projectConfig, process.cwd());
      plan = await planGenerator.generatePlan(type as 'compile' | 'build', architecture);
    } else if (type === 'lint') {
      plan = await generateLintPlan(projectConfig);
    } else if (type === 'test') {
      plan = await generateTestPlan(projectConfig);
    }

    if (!plan) {
      throw new Error(`Failed to generate ${type} plan`);
    }

    let savedPath: string;
    if (type === 'compile' || type === 'build') {
      const cleanedOptions: { filename?: string; description?: string; tags?: string[] } = {};
      if (saveOptions.filename) cleanedOptions.filename = saveOptions.filename;
      if (saveOptions.description) cleanedOptions.description = saveOptions.description;
      if (saveOptions.tags) cleanedOptions.tags = saveOptions.tags;
      
      savedPath = await PlanStorage.savePlan(plan as any, cleanedOptions);
    } else {
      // For lint and test plans, save them directly as JSON files
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = saveOptions.filename || `${type}-plan-${timestamp}.json`;
      const filePath = path.join(os.homedir(), '.cirron', 'plans', filename);
      await fs.ensureDir(path.dirname(filePath));
      await fs.writeJson(filePath, plan, { spaces: 2 });
      savedPath = filePath;
    }
    
    spinner.succeed(chalk.green(`${type} plan saved successfully`));
    
    if (options.verbose) {
      console.log(`\n Saved to: ${savedPath}`);
    }

  } catch (error) {
    spinner.fail(chalk.red(`Failed to save ${type} plan`));
    logger.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Enhanced diff formatting for dependencies  
function formatEnhancedDiff(comparison: any, _verbose: boolean): void {
  const useColors = process.stdout.isTTY;
  const colorize = (text: string, colorFn: (text: string) => string) => useColors ? colorFn(text) : text;
  
  // Find dependency changes for enhanced display
  const depChanges = comparison.differences.filter((diff: any) => diff.category === 'dependencies');
  
  if (depChanges.length > 0) {
    console.log('\n' + colorize('📦 Dependencies Changed:', chalk.bold.blue));
    
    for (const change of depChanges) {
      if (change.type === 'changed') {
        const name = change.field.replace('dependency.', '');
        console.log(colorize(`- ${name}==${change.oldValue}`, chalk.red));
        console.log(colorize(`+ ${name}==${change.newValue}`, chalk.green));
      } else if (change.type === 'added') {
        const name = change.field.replace('dependency.', '');
        console.log(colorize(`+ ${name}==${change.newValue}`, chalk.green));
      } else if (change.type === 'removed') {
        const name = change.field.replace('dependency.', '');
        console.log(colorize(`- ${name}==${change.oldValue}`, chalk.red));
      }
    }
  }

  // Model parameter changes
  const modelChanges = comparison.differences.filter((diff: any) => 
    diff.category === 'model' && (diff.field.includes('Parameters') || diff.field.includes('totalParameters'))
  );
  
  if (modelChanges.length > 0) {
    console.log('\n' + colorize('🧠 Model Params:', chalk.bold.magenta));
    
    for (const change of modelChanges) {
      if (change.type === 'changed' && typeof change.oldValue === 'number' && typeof change.newValue === 'number') {
        const diff = change.newValue - change.oldValue;
        const percentage = ((diff / change.oldValue) * 100).toFixed(1);
        const diffText = diff > 0 ? `+${percentage}%` : `${percentage}%`;
        const diffColor = diff > 0 ? chalk.green : chalk.red;
        
        console.log(colorize(`- Total: ${formatNumber(change.oldValue)} → ${formatNumber(change.newValue)} (${diffColor(diffText)})`, chalk.cyan));
      }
    }
  }
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  } else if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toString();
}