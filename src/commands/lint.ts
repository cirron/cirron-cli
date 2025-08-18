import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronIgnore } from '../utils/ignore';
import { executeScript } from '../utils/execution';
import type { ProjectConfig } from '../types';

interface LintOptions {
  config?: boolean;
  structure?: boolean;
  dependencies?: boolean;
  code?: boolean;
  all?: boolean;
  fix?: boolean;
  verbose?: boolean;
  json?: boolean;
  strict?: boolean;
}

interface LintResult {
  category: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  file?: string;
  line?: number;
  fixable?: boolean;
  suggestion?: string;
}

interface LintSummary {
  errors: number;
  warnings: number;
  infos: number;
  results: LintResult[];
}

export async function lintCommand(options: LintOptions): Promise<void> {
  const spinner = ora('Starting project linting...').start();
  
  try {
    const summary: LintSummary = {
      errors: 0,
      warnings: 0,
      infos: 0,
      results: []
    };

    // Determine what to lint
    const shouldLintAll = options.all || (!options.config && !options.structure && !options.dependencies && !options.code);
    
    if (shouldLintAll || options.config) {
      spinner.text = 'Linting project configuration...';
      await lintProjectConfig(summary, options);
    }

    if (shouldLintAll || options.structure) {
      spinner.text = 'Checking project structure...';
      await lintProjectStructure(summary, options);
    }

    if (shouldLintAll || options.dependencies) {
      spinner.text = 'Validating dependencies...';
      await lintDependencies(summary, options);
    }

    if (shouldLintAll || options.code) {
      spinner.text = 'Running code quality checks...';
      await lintCode(summary, options);
    }

    spinner.stop();

    // Apply fixes if requested
    if (options.fix && summary.results.some(r => r.fixable)) {
      await applyFixes(summary, options);
    }

    // Output results
    if (options.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      displayResults(summary, options);
    }

    // Exit with appropriate code
    if (summary.errors > 0) {
      process.exit(1);
    }

  } catch (error) {
    spinner.fail('Linting failed');
    logger.error('Lint error:', error);
    process.exit(1);
  }
}

async function lintProjectConfig(summary: LintSummary, _options: LintOptions): Promise<void> {
  const configPath = path.join(process.cwd(), 'cirron.json');
  
  if (!fs.existsSync(configPath)) {
    addResult(summary, {
      category: 'config',
      severity: 'error',
      message: 'Missing cirron.json configuration file',
      file: 'cirron.json',
      fixable: false,
      suggestion: 'Run "cirron init" to create a project configuration'
    });
    return;
  }

  try {
    const config: ProjectConfig = await fs.readJSON(configPath);
    
    // Validate required fields
    const requiredFields = ['name', 'version', 'template'];
    for (const field of requiredFields) {
      if (!config[field as keyof ProjectConfig]) {
        addResult(summary, {
          category: 'config',
          severity: 'error',
          message: `Missing required field: ${field}`,
          file: 'cirron.json',
          fixable: false
        });
      }
    }

    // Validate framework-specific requirements
    if (config.framework) {
      validateFrameworkConfig(config, summary);
    }

    // Validate environments
    if (!config.environments || Object.keys(config.environments).length === 0) {
      addResult(summary, {
        category: 'config',
        severity: 'warning',
        message: 'No environments configured',
        file: 'cirron.json',
        fixable: false,
        suggestion: 'Add at least one environment configuration'
      });
    }

    // Validate version format
    if (config.projectVersion && !/^\d+\.\d+\.\d+/.test(config.projectVersion)) {
      addResult(summary, {
        category: 'config',
        severity: 'warning',
        message: 'Version should follow semantic versioning (e.g., 1.0.0)',
        file: 'cirron.json',
        fixable: false
      });
    }

    addResult(summary, {
      category: 'config',
      severity: 'info',
      message: 'Project configuration is valid',
      file: 'cirron.json'
    });

  } catch (error) {
    addResult(summary, {
      category: 'config',
      severity: 'error',
      message: 'Invalid JSON in cirron.json',
      file: 'cirron.json',
      fixable: false,
      suggestion: 'Check JSON syntax and formatting'
    });
  }
}

async function lintProjectStructure(summary: LintSummary, _options: LintOptions): Promise<void> {
  const requiredFiles = [
    { path: 'src/model.py', required: true },
    { path: 'requirements.txt', required: true },
    { path: 'Dockerfile', required: true },
    { path: 'src/inference.py', required: false },
    { path: 'src/data_loader.py', required: false },
    { path: 'tests/', required: false, isDir: true }
  ];

  for (const file of requiredFiles) {
    const fullPath = path.join(process.cwd(), file.path);
    const exists = fs.existsSync(fullPath);
    
    if (file.required && !exists) {
      addResult(summary, {
        category: 'structure',
        severity: 'error',
        message: `Missing required ${file.isDir ? 'directory' : 'file'}: ${file.path}`,
        file: file.path,
        fixable: false,
        suggestion: `Create ${file.path} with appropriate content`
      });
    } else if (!file.required && !exists) {
      addResult(summary, {
        category: 'structure',
        severity: 'info',
        message: `Optional ${file.isDir ? 'directory' : 'file'} not found: ${file.path}`,
        file: file.path
      });
    }
  }

  // Check for ML-specific directories
  const mlDirs = ['models/', 'data/', 'checkpoints/', 'logs/'];
  for (const dir of mlDirs) {
    const fullPath = path.join(process.cwd(), dir);
    if (!fs.existsSync(fullPath)) {
      addResult(summary, {
        category: 'structure',
        severity: 'warning',
        message: `ML directory not found: ${dir}`,
        file: dir,
        fixable: true,
        suggestion: `Create ${dir} directory for ML artifacts`
      });
    }
  }

  // Check .cirronignore
  const ignorePath = path.join(process.cwd(), '.cirronignore');
  if (!fs.existsSync(ignorePath)) {
    addResult(summary, {
      category: 'structure',
      severity: 'warning',
      message: 'No .cirronignore file found',
      file: '.cirronignore',
      fixable: true,
      suggestion: 'Create .cirronignore to exclude unnecessary files from builds'
    });
  }
}

async function lintDependencies(summary: LintSummary, _options: LintOptions): Promise<void> {
  const requirementsPath = path.join(process.cwd(), 'requirements.txt');
  
  if (!fs.existsSync(requirementsPath)) {
    addResult(summary, {
      category: 'dependencies',
      severity: 'error',
      message: 'Missing requirements.txt file',
      file: 'requirements.txt',
      fixable: false
    });
    return;
  }

  try {
    const content = await fs.readFile(requirementsPath, 'utf-8');
    const lines = content.split('\n').filter(line => line.trim());
    
    // Check for common ML dependencies
    const commonDeps = ['numpy', 'pandas', 'scikit-learn'];
    const hasDeps = commonDeps.some(dep => 
      lines.some(line => line.toLowerCase().includes(dep))
    );
    
    if (!hasDeps) {
      addResult(summary, {
        category: 'dependencies',
        severity: 'info',
        message: 'No common ML dependencies found',
        file: 'requirements.txt'
      });
    }

    // Check for version pins
    const unpinnedDeps = lines.filter(line => 
      line.includes('==') === false && 
      line.includes('>=') === false && 
      line.includes('~=') === false &&
      line.trim() && 
      !line.startsWith('#')
    );

    if (unpinnedDeps.length > 0) {
      addResult(summary, {
        category: 'dependencies',
        severity: 'warning',
        message: `${unpinnedDeps.length} dependencies without version constraints`,
        file: 'requirements.txt',
        suggestion: 'Pin dependency versions for reproducible builds'
      });
    }

    addResult(summary, {
      category: 'dependencies',
      severity: 'info',
      message: `Found ${lines.length} dependencies`,
      file: 'requirements.txt'
    });

  } catch (error) {
    addResult(summary, {
      category: 'dependencies',
      severity: 'error',
      message: 'Could not read requirements.txt',
      file: 'requirements.txt',
      fixable: false
    });
  }
}

async function lintCode(summary: LintSummary, _options: LintOptions): Promise<void> {
  // Lint TypeScript files with ESLint
  try {
    execSync('npm run lint', { 
      stdio: 'pipe', 
      encoding: 'utf-8',
      cwd: process.cwd()
    });
    
    addResult(summary, {
      category: 'code',
      severity: 'info',
      message: 'TypeScript code passes ESLint checks'
    });
  } catch (error: any) {
    const output = error.stdout || error.stderr || '';
    const eslintErrors = parseESLintOutput(output);
    
    eslintErrors.forEach(eslintError => {
      addResult(summary, {
        category: 'code',
        severity: eslintError.severity,
        message: eslintError.message,
        ...(eslintError.file && { file: eslintError.file }),
        ...(eslintError.line && { line: eslintError.line }),
        ...(eslintError.fixable && { fixable: eslintError.fixable })
      });
    });
  }

  // Basic Python syntax check
  const pythonFiles = await findPythonFiles();
  for (const file of pythonFiles) {
    try {
      const result = await executeScript('python', ['-m', 'py_compile', file]);
      if (result.success) {
        addResult(summary, {
          category: 'code',
          severity: 'info',
          message: 'Python syntax is valid',
          file: path.relative(process.cwd(), file)
        });
      } else {
        const errorDetails = result.parsedErrors && result.parsedErrors.length > 0 && result.parsedErrors[0] ? 
          result.parsedErrors[0].message : result.stderr;
        addResult(summary, {
          category: 'code',
          severity: 'error',
          message: `Python syntax error: ${errorDetails}`,
          file: path.relative(process.cwd(), file),
          fixable: false
        });
      }
    } catch (error) {
      addResult(summary, {
        category: 'code',
        severity: 'error',
        message: 'Python syntax error',
        file: path.relative(process.cwd(), file),
        fixable: false
      });
    }
  }
}

function validateFrameworkConfig(config: ProjectConfig, summary: LintSummary): void {
  const framework = config.framework;
  
  if (framework === 'pytorch' && !config.pythonVersion) {
    addResult(summary, {
      category: 'config',
      severity: 'warning',
      message: 'PyTorch projects should specify Python version',
      file: 'cirron.json',
      suggestion: 'Add "pythonVersion": "3.8" or appropriate version'
    });
  }

  if (framework === 'tensorflow' && config.gpuRequired === undefined) {
    addResult(summary, {
      category: 'config',
      severity: 'info',
      message: 'Consider specifying GPU requirements for TensorFlow',
      file: 'cirron.json'
    });
  }
}

async function findPythonFiles(): Promise<string[]> {
  const ignore = new CirronIgnore();
  
  const pythonFiles: string[] = [];
  const srcDir = path.join(process.cwd(), 'src');
  
  if (fs.existsSync(srcDir)) {
    const files = await fs.readdir(srcDir, { recursive: true });
    for (const file of files) {
      const fullPath = path.join(srcDir, file as string);
      if (file.toString().endsWith('.py') && !ignore.isIgnored(fullPath)) {
        pythonFiles.push(fullPath);
      }
    }
  }
  
  return pythonFiles;
}

function parseESLintOutput(output: string): LintResult[] {
  const results: LintResult[] = [];
  const lines = output.split('\n');
  
  for (const line of lines) {
    const match = line.match(/^(.+?):(\d+):\d+: (error|warning) (.+)$/);
    if (match && match[1] && match[2] && match[4]) {
      results.push({
        category: 'code',
        severity: match[3] as 'error' | 'warning',
        message: match[4],
        file: match[1],
        line: parseInt(match[2]),
        fixable: line.includes('(fixable)')
      });
    }
  }
  
  return results;
}

async function applyFixes(summary: LintSummary, _options: LintOptions): Promise<void> {
  const spinner = ora('Applying automatic fixes...').start();
  
  try {
    // Create missing directories
    const fixableStructure = summary.results.filter(r => 
      r.category === 'structure' && r.fixable && r.file
    );
    
    for (const result of fixableStructure) {
      const fullPath = path.join(process.cwd(), result.file!);
      if (result.file!.endsWith('/')) {
        await fs.ensureDir(fullPath);
        spinner.text = `Created directory: ${result.file}`;
      }
    }

    // Create .cirronignore if missing
    const needsIgnoreFile = summary.results.find(r => 
      r.file === '.cirronignore' && r.fixable
    );
    
    if (needsIgnoreFile) {
      const ignoreContent = `# Cirron ignore file
# Version control
.git/
.svn/

# Large data files
data/raw/
*.csv
!data/sample/*.csv

# Model artifacts
*.pth
*.pkl
!model_config.*

# Development
.vscode/
.idea/
__pycache__/
*.pyc
*.log
*.tmp
temp_*

# Build artifacts
build/
dist/
node_modules/
`;
      await fs.writeFile(path.join(process.cwd(), '.cirronignore'), ignoreContent);
      spinner.text = 'Created .cirronignore file';
    }

    spinner.succeed('Fixes applied successfully');
  } catch (error) {
    spinner.fail('Failed to apply fixes');
    logger.error('Fix error:', error);
  }
}

function addResult(summary: LintSummary, result: LintResult): void {
  summary.results.push(result);
  
  switch (result.severity) {
    case 'error':
      summary.errors++;
      break;
    case 'warning':
      summary.warnings++;
      break;
    case 'info':
      summary.infos++;
      break;
  }
}

function displayResults(summary: LintSummary, options: LintOptions): void {
  console.log('\n' + chalk.bold('Cirron Lint Results'));
  console.log('='.repeat(50));
  
  if (summary.results.length === 0) {
    console.log(chalk.green('✓ No issues found'));
    return;
  }

  // Group by category
  const categories = Array.from(new Set(summary.results.map(r => r.category)));
  
  for (const category of categories) {
    const categoryResults = summary.results.filter(r => r.category === category);
    console.log(`\n${chalk.bold.cyan(category.toUpperCase())}:`);
    
    for (const result of categoryResults) {
      const icon = result.severity === 'error' ? '✗' : result.severity === 'warning' ? '⚠' : 'ℹ';
      const color = result.severity === 'error' ? chalk.red : result.severity === 'warning' ? chalk.yellow : chalk.blue;
      
      let message = `  ${color(icon)} ${result.message}`;
      
      if (result.file) {
        message += chalk.gray(` (${result.file}`);
        if (result.line) {
          message += chalk.gray(`:${result.line}`);
        }
        message += chalk.gray(')');
      }
      
      console.log(message);
      
      if (result.suggestion && options.verbose) {
        console.log(`    ${chalk.gray('→')} ${chalk.italic(result.suggestion)}`);
      }
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  const errorText = summary.errors > 0 ? chalk.red(`${summary.errors} errors`) : '0 errors';
  const warningText = summary.warnings > 0 ? chalk.yellow(`${summary.warnings} warnings`) : '0 warnings';
  const infoText = `${summary.infos} infos`;
  
  console.log(`${errorText}, ${warningText}, ${infoText}`);
  
  if (summary.errors > 0) {
    console.log(chalk.red('\n✗ Linting failed'));
  } else {
    console.log(chalk.green('\n✓ Linting passed'));
  }

  // Show fix hint
  const fixableCount = summary.results.filter(r => r.fixable).length;
  if (fixableCount > 0) {
    console.log(chalk.gray(`\nℹ ${fixableCount} issues can be automatically fixed with --fix`));
  }
}