import { spawn } from 'child_process';
import { logger } from './logger';
import chalk from 'chalk';

export interface ExecutionResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  duration: number;
  parsedErrors?: ParsedError[];
}

export interface ParsedError {
  type: 'exception' | 'syntax' | 'import' | 'runtime';
  message: string;
  file?: string;
  line?: number;
  traceback: string[];
}

export interface ExecutionOptions {
  cwd?: string;
  timeout?: number;
  retries?: number;
  retryDelay?: number;
  retryCondition?: (result: ExecutionResult) => boolean;
  encoding?: string;
  env?: Record<string, string>;
  showOutput?: boolean;
}

export interface RetryableOperation {
  maxAttempts: number;
  baseDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
}

const DEFAULT_RETRY_CONFIG: RetryableOperation = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2
};

export class ExecutionError extends Error {
  constructor(
    public result: ExecutionResult,
    message?: string
  ) {
    super(message || `Command failed: ${result.command}`);
    this.name = 'ExecutionError';
  }
}

export async function executeScript(
  command: string,
  args: string[] = [],
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const {
    cwd = process.cwd(),
    timeout = 30000,
    retries = 0,
    retryDelay = 1000,
    retryCondition,
    encoding = 'utf8',
    env = process.env as Record<string, string>,
    showOutput = false
  } = options;

  let attempt = 0;
  let lastResult: ExecutionResult;

  do {
    attempt++;
    
    if (attempt > 1) {
      logger.info(`Retry attempt ${attempt}/${retries + 1} for: ${command}`);
      await sleep(retryDelay * Math.pow(2, attempt - 2)); // Exponential backoff
    }

    lastResult = await executeOnce(command, args, {
      cwd,
      timeout,
      encoding,
      env,
      showOutput
    });

    // Check if retry condition is met
    if (lastResult.success || !retryCondition || !retryCondition(lastResult)) {
      break;
    }

  } while (attempt <= retries);

  return lastResult;
}

async function executeOnce(
  command: string,
  args: string[] = [],
  options: {
    cwd: string;
    timeout: number;
    encoding: string;
    env: Record<string, string>;
    showOutput: boolean;
  }
): Promise<ExecutionResult> {
  const startTime = Date.now();
  
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000);
    }, options.timeout);

    child.stdout?.on('data', (data) => {
      const chunk = data.toString(options.encoding);
      stdout += chunk;
      if (options.showOutput) {
        process.stdout.write(chunk);
      }
    });

    child.stderr?.on('data', (data) => {
      const chunk = data.toString(options.encoding);
      stderr += chunk;
      if (options.showOutput) {
        process.stderr.write(chunk);
      }
    });

    child.on('close', (exitCode) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const commandStr = `${command} ${args.join(' ')}`.trim();

      if (timedOut) {
        const result: ExecutionResult = {
          success: false,
          exitCode: -1,
          stdout,
          stderr: stderr + '\nProcess timed out',
          command: commandStr,
          duration
        };
        result.parsedErrors = parseErrors(stderr + '\nProcess timed out');
        resolve(result);
        return;
      }

      const success = exitCode === 0;
      const result: ExecutionResult = {
        success,
        exitCode: exitCode || 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        command: commandStr,
        duration
      };

      if (!success) {
        result.parsedErrors = parseErrors(stderr);
      }

      resolve(result);
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const commandStr = `${command} ${args.join(' ')}`.trim();

      const result: ExecutionResult = {
        success: false,
        exitCode: -1,
        stdout,
        stderr: stderr + `\nProcess error: ${error.message}`,
        command: commandStr,
        duration
      };
      result.parsedErrors = parseErrors(`Process error: ${error.message}`);
      resolve(result);
    });
  });
}

export function parseErrors(stderr: string): ParsedError[] {
  if (!stderr.trim()) return [];

  const errors: ParsedError[] = [];
  const lines = stderr.split('\n');
  
  // Parse Python tracebacks
  let currentTraceback: string[] = [];
  let inTraceback = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    
    // Start of traceback
    if (line.includes('Traceback (most recent call last):')) {
      inTraceback = true;
      currentTraceback = [line];
      continue;
    }
    
    if (inTraceback) {
      currentTraceback.push(line);
      
      // Check for exception types
      const exceptionMatch = line.match(/^(\w+Error|\w+Exception|\w+Warning):\s*(.+)$/);
      if (exceptionMatch && exceptionMatch[1] && exceptionMatch[2]) {
        const exceptionType = exceptionMatch[1];
        const message = exceptionMatch[2];
        
        // Extract file and line info from traceback
        let file: string | undefined;
        let lineNumber: number | undefined;
        
        const fileMatches = currentTraceback.filter(l => l.includes('File "'));
        if (fileMatches.length > 0) {
          const lastFileMatch = fileMatches[fileMatches.length - 1];
          if (lastFileMatch) {
            const fileMatch = lastFileMatch.match(/File "([^"]+)", line (\d+)/);
            if (fileMatch && fileMatch[1] && fileMatch[2]) {
              file = fileMatch[1];
              lineNumber = parseInt(fileMatch[2], 10);
            }
          }
        }
        
        const parsedError: ParsedError = {
          type: getErrorType(exceptionType),
          message,
          traceback: [...currentTraceback]
        };
        if (file) parsedError.file = file;
        if (lineNumber) parsedError.line = lineNumber;
        errors.push(parsedError);
        
        inTraceback = false;
        currentTraceback = [];
      }
    }
    
    // Handle other error patterns
    if (!inTraceback) {
      // Syntax errors
      const syntaxMatch = line.match(/SyntaxError:\s*(.+)/);
      if (syntaxMatch && syntaxMatch[1]) {
        errors.push({
          type: 'syntax',
          message: syntaxMatch[1],
          traceback: [line]
        });
      }
      
      // Import errors
      const importMatch = line.match(/(ImportError|ModuleNotFoundError):\s*(.+)/);
      if (importMatch && importMatch[1] && importMatch[2]) {
        errors.push({
          type: 'import',
          message: importMatch[2],
          traceback: [line]
        });
      }
    }
  }
  
  return errors;
}

function getErrorType(exceptionName: string): ParsedError['type'] {
  if (exceptionName.includes('Syntax')) return 'syntax';
  if (exceptionName.includes('Import') || exceptionName.includes('ModuleNotFound')) return 'import';
  if (exceptionName.includes('Runtime')) return 'runtime';
  return 'exception';
}

export function formatExecutionError(result: ExecutionResult, showDetails = false): string {
  const parts: string[] = [];
  
  parts.push(chalk.red(`Command failed: ${result.command}`));
  parts.push(chalk.gray(`Exit code: ${result.exitCode}`));
  parts.push(chalk.gray(`Duration: ${result.duration}ms`));
  
  if (result.parsedErrors && result.parsedErrors.length > 0) {
    parts.push('');
    parts.push(chalk.yellow('Parsed Errors:'));
    
    result.parsedErrors.forEach((error, index) => {
      parts.push(chalk.red(`  ${index + 1}. ${error.type.toUpperCase()}: ${error.message}`));
      
      if (error.file && error.line !== undefined) {
        parts.push(chalk.gray(`     ${error.file}:${error.line}`));
      }
      
      if (showDetails && error.traceback.length > 0) {
        parts.push(chalk.gray('     Traceback:'));
        error.traceback.forEach(tracebackLine => {
          if (tracebackLine && tracebackLine.trim()) {
            parts.push(chalk.gray(`       ${tracebackLine}`));
          }
        });
      }
    });
  }
  
  if (showDetails) {
    if (result.stdout) {
      parts.push('');
      parts.push(chalk.blue('STDOUT:'));
      parts.push(result.stdout);
    }
    
    if (result.stderr) {
      parts.push('');
      parts.push(chalk.magenta('STDERR:'));
      parts.push(result.stderr);
    }
  }
  
  return parts.join('\n');
}

export async function executePythonScript(
  script: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  return executeScript('python3', ['-c', script], {
    retryCondition: (result) => {
      // Retry for CUDA setup issues and certain import errors
      return result.stderr.includes('CUDA') ||
             result.stderr.includes('RuntimeError') ||
             result.stderr.includes('device-side assert');
    },
    retries: 2,
    retryDelay: 2000,
    ...options
  });
}

export async function executePythonFile(
  filePath: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  return executeScript('python3', [filePath], {
    retryCondition: (result) => {
      // Retry for CUDA setup issues
      return result.stderr.includes('CUDA') ||
             result.stderr.includes('RuntimeError');
    },
    retries: 1,
    retryDelay: 1500,
    ...options
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function createRetryableOperation(config: Partial<RetryableOperation> = {}): RetryableOperation {
  return { ...DEFAULT_RETRY_CONFIG, ...config };
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  retryConfig: Partial<RetryableOperation> = {}
): Promise<T> {
  const config = createRetryableOperation(retryConfig);
  let lastError: Error;
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === config.maxAttempts) {
        throw lastError;
      }
      
      const delay = Math.min(
        config.baseDelay * Math.pow(config.backoffMultiplier, attempt - 1),
        config.maxDelay
      );
      
      logger.info(`Operation failed, retrying in ${delay}ms (attempt ${attempt}/${config.maxAttempts})`);
      await sleep(delay);
    }
  }
  
  throw lastError!;
}