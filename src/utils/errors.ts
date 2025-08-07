import chalk from 'chalk';
import { logger } from './logger';

/**
 * CLI Error Codes for programmatic error handling
 * 
 * Exit codes follow Unix conventions:
 * - 0: Success
 * - 1-125: General errors
 * - 126: Command cannot execute
 * - 127: Command not found
 * - 128+n: Fatal error signal "n"
 */
export enum CLIErrorCode {
  // Success
  SUCCESS = 0,

  // General script and execution errors (1-10)
  SCRIPT_FAILED = 1,
  PYTHON_SYNTAX_ERROR = 2,
  PYTHON_IMPORT_ERROR = 3,
  TIMEOUT = 4,
  COMMAND_NOT_FOUND = 5,

  // Hardware and system errors (11-20)
  CUDA_FAILURE = 11,
  GPU_FAILURE = 12,
  SYSTEM_REQUIREMENTS_NOT_MET = 13,
  INSUFFICIENT_RESOURCES = 14,

  // ML-specific errors (21-30)
  MODEL_CREATION_FAILED = 21,
  MODEL_LOADING_FAILED = 22,
  MODEL_VALIDATION_FAILED = 23,
  INFERENCE_FAILED = 24,
  TRAINING_FAILED = 25,

  // Project and configuration errors (31-40)
  PROJECT_NOT_FOUND = 31,
  INVALID_CONFIG = 32,
  MISSING_DEPENDENCIES = 33,
  BUILD_FAILED = 34,
  VALIDATION_FAILED = 35,
  COMPILE_FAILED = 36,

  // Testing and quality errors (41-50)
  UNIT_TESTS_FAILED = 41,
  LINT_FAILED = 42,
  TYPE_CHECK_FAILED = 43,
  CODE_QUALITY_FAILED = 44,

  // Infrastructure and deployment errors (51-60)
  DOCKER_FAILED = 51,
  DEPLOYMENT_FAILED = 52,
  NETWORK_ERROR = 53,
  AUTHENTICATION_FAILED = 54,

  // File system and I/O errors (61-70)
  FILE_NOT_FOUND = 61,
  PERMISSION_DENIED = 62,
  DISK_FULL = 63,
  IO_ERROR = 64,

  // Git and version control errors (71-80)
  GIT_ERROR = 71,
  REPOSITORY_ERROR = 72,

  // Generic internal errors (81-90)
  INTERNAL_ERROR = 81,
  UNKNOWN_ERROR = 82
}

export interface CLIErrorDetails {
  code: CLIErrorCode;
  message: string;
  cause?: Error | string;
  details?: Record<string, any>;
  suggestions?: string[];
  recoverable?: boolean;
  strictModeOnly?: boolean;
}

export class CLIError extends Error {
  public readonly code: CLIErrorCode;
  public readonly details?: Record<string, any>;
  public readonly suggestions?: string[];
  public readonly recoverable: boolean;
  public readonly strictModeOnly: boolean;

  constructor(errorDetails: CLIErrorDetails) {
    super(errorDetails.message);
    this.name = 'CLIError';
    this.code = errorDetails.code;
    this.recoverable = errorDetails.recoverable ?? false;
    this.strictModeOnly = errorDetails.strictModeOnly ?? false;

    if (errorDetails.details) {
      this.details = errorDetails.details;
    }
    if (errorDetails.suggestions) {
      this.suggestions = errorDetails.suggestions;
    }
    if (errorDetails.cause) {
      (this as any).cause = errorDetails.cause;
    }

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, CLIError);
    }
  }

  /**
   * Create a CLIError from an execution result
   */
  static fromExecutionResult(result: any, baseCode: CLIErrorCode = CLIErrorCode.SCRIPT_FAILED): CLIError {
    if (result.success) {
      return new CLIError({
        code: CLIErrorCode.SUCCESS,
        message: 'Operation completed successfully'
      });
    }

    let code = baseCode;
    let suggestions: string[] = [];
    let recoverable = false;

    // Determine specific error code based on parsed errors
    if (result.parsedErrors && result.parsedErrors.length > 0) {
      const firstError = result.parsedErrors[0];
      
      switch (firstError.type) {
        case 'syntax':
          code = CLIErrorCode.PYTHON_SYNTAX_ERROR;
          suggestions.push('Check Python syntax in the specified file and line');
          recoverable = true;
          break;
        case 'import':
          code = CLIErrorCode.PYTHON_IMPORT_ERROR;
          suggestions.push('Install missing Python packages with pip install');
          suggestions.push('Check your Python environment and PATH');
          recoverable = true;
          break;
        case 'runtime':
          if (firstError.message.includes('CUDA')) {
            code = CLIErrorCode.CUDA_FAILURE;
            suggestions.push('Verify CUDA installation and GPU availability');
            suggestions.push('Try running without GPU acceleration');
            recoverable = true;
          } else if (firstError.message.includes('GPU')) {
            code = CLIErrorCode.GPU_FAILURE;
            suggestions.push('Check GPU drivers and availability');
            recoverable = true;
          }
          break;
      }
    }

    // Check for timeout
    if (result.stderr && result.stderr.includes('timed out')) {
      code = CLIErrorCode.TIMEOUT;
      suggestions.push('Increase timeout or optimize the operation');
      recoverable = true;
    }

    // Check for specific error patterns in stderr
    if (result.stderr) {
      if (result.stderr.includes('command not found')) {
        code = CLIErrorCode.COMMAND_NOT_FOUND;
        suggestions.push('Install the required command or check PATH');
        recoverable = true;
      } else if (result.stderr.includes('Permission denied')) {
        code = CLIErrorCode.PERMISSION_DENIED;
        suggestions.push('Check file permissions or run with appropriate privileges');
        recoverable = true;
      } else if (result.stderr.includes('No space left')) {
        code = CLIErrorCode.DISK_FULL;
        suggestions.push('Free up disk space and try again');
        recoverable = false;
      }
    }

    return new CLIError({
      code,
      message: result.parsedErrors && result.parsedErrors.length > 0 
        ? result.parsedErrors[0].message 
        : result.stderr || 'Script execution failed',
      details: {
        command: result.command,
        exitCode: result.exitCode,
        duration: result.duration,
        stdout: result.stdout,
        stderr: result.stderr,
        parsedErrors: result.parsedErrors
      },
      suggestions,
      recoverable
    });
  }

  /**
   * Format error for display
   */
  format(verbose = false): string {
    const parts: string[] = [];
    
    parts.push(chalk.red(`Error ${this.code}: ${this.message}`));
    
    if (this.suggestions && this.suggestions.length > 0) {
      parts.push('');
      parts.push(chalk.yellow('Suggestions:'));
      this.suggestions.forEach(suggestion => {
        parts.push(chalk.yellow(`  • ${suggestion}`));
      });
    }

    if (verbose && this.details) {
      parts.push('');
      parts.push(chalk.gray('Details:'));
      Object.entries(this.details).forEach(([key, value]) => {
        if (key === 'parsedErrors' && Array.isArray(value)) {
          value.forEach((error, index) => {
            parts.push(chalk.gray(`  ${key}[${index}]: ${error.type} - ${error.message}`));
            if (error.file && error.line) {
              parts.push(chalk.gray(`    Location: ${error.file}:${error.line}`));
            }
          });
        } else if (typeof value === 'string' && value.trim()) {
          const displayValue = value.length > 200 ? value.substring(0, 200) + '...' : value;
          parts.push(chalk.gray(`  ${key}: ${displayValue}`));
        } else if (typeof value === 'number') {
          parts.push(chalk.gray(`  ${key}: ${value}`));
        }
      });
    }

    return parts.join('\n');
  }
}

/**
 * Handle CLI error and exit with appropriate code
 */
export function handleCLIError(error: unknown, strictMode = false, verbose = false): never {
  if (error instanceof CLIError) {
    // In non-strict mode, some errors can be treated as warnings
    if (!strictMode && error.recoverable && !error.strictModeOnly) {
      logger.warn(error.format(verbose));
      logger.warn('Continuing in non-strict mode...');
      process.exit(CLIErrorCode.SUCCESS);
    }

    logger.error(error.format(verbose));
    process.exit(error.code);
  } else if (error instanceof Error) {
    const cliError = new CLIError({
      code: CLIErrorCode.INTERNAL_ERROR,
      message: error.message,
      cause: error
    });
    
    logger.error(cliError.format(verbose));
    if (verbose) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(CLIErrorCode.INTERNAL_ERROR);
  } else {
    logger.error('Unknown error:', String(error));
    process.exit(CLIErrorCode.UNKNOWN_ERROR);
  }
}

/**
 * Create domain-specific error factory functions
 */
export const ErrorFactories = {
  cudaError: (message: string, details?: Record<string, any>): CLIError => {
    const errorDetails: CLIErrorDetails = {
      code: CLIErrorCode.CUDA_FAILURE,
      message,
      suggestions: [
        'Verify CUDA installation and GPU availability',
        'Try running without GPU acceleration (--arch cpu)',
        'Check NVIDIA driver compatibility'
      ],
      recoverable: true
    };
    if (details) errorDetails.details = details;
    return new CLIError(errorDetails);
  },

  modelError: (message: string, details?: Record<string, any>): CLIError => {
    const errorDetails: CLIErrorDetails = {
      code: CLIErrorCode.MODEL_CREATION_FAILED,
      message,
      suggestions: [
        'Check model.py for syntax errors',
        'Verify model dependencies are installed',
        'Review model architecture configuration'
      ],
      recoverable: true
    };
    if (details) errorDetails.details = details;
    return new CLIError(errorDetails);
  },

  validationError: (message: string, details?: Record<string, any>, strict = false): CLIError => {
    const errorDetails: CLIErrorDetails = {
      code: CLIErrorCode.VALIDATION_FAILED,
      message,
      suggestions: [
        'Fix validation issues and retry',
        'Run with --validate flag for detailed checks'
      ],
      recoverable: true,
      strictModeOnly: strict
    };
    if (details) errorDetails.details = details;
    return new CLIError(errorDetails);
  },

  buildError: (message: string, details?: Record<string, any>): CLIError => {
    const errorDetails: CLIErrorDetails = {
      code: CLIErrorCode.BUILD_FAILED,
      message,
      suggestions: [
        'Check build logs for specific errors',
        'Verify all dependencies are available',
        'Try cleaning and rebuilding'
      ],
      recoverable: true
    };
    if (details) errorDetails.details = details;
    return new CLIError(errorDetails);
  },

  testError: (message: string, details?: Record<string, any>): CLIError => {
    const errorDetails: CLIErrorDetails = {
      code: CLIErrorCode.UNIT_TESTS_FAILED,
      message,
      suggestions: [
        'Fix failing tests',
        'Check test dependencies',
        'Review test configuration'
      ],
      recoverable: true,
      strictModeOnly: true
    };
    if (details) errorDetails.details = details;
    return new CLIError(errorDetails);
  }
};

/**
 * Get human-readable description of error code
 */
export function getErrorCodeDescription(code: CLIErrorCode): string {
  const descriptions: Record<CLIErrorCode, string> = {
    [CLIErrorCode.SUCCESS]: 'Operation completed successfully',
    [CLIErrorCode.SCRIPT_FAILED]: 'Script execution failed',
    [CLIErrorCode.PYTHON_SYNTAX_ERROR]: 'Python syntax error detected',
    [CLIErrorCode.PYTHON_IMPORT_ERROR]: 'Python import error - missing module',
    [CLIErrorCode.TIMEOUT]: 'Operation timed out',
    [CLIErrorCode.COMMAND_NOT_FOUND]: 'Required command not found',
    [CLIErrorCode.CUDA_FAILURE]: 'CUDA-related operation failed',
    [CLIErrorCode.GPU_FAILURE]: 'GPU operation failed',
    [CLIErrorCode.SYSTEM_REQUIREMENTS_NOT_MET]: 'System requirements not met',
    [CLIErrorCode.INSUFFICIENT_RESOURCES]: 'Insufficient system resources',
    [CLIErrorCode.MODEL_CREATION_FAILED]: 'ML model creation failed',
    [CLIErrorCode.MODEL_LOADING_FAILED]: 'ML model loading failed',
    [CLIErrorCode.MODEL_VALIDATION_FAILED]: 'ML model validation failed',
    [CLIErrorCode.INFERENCE_FAILED]: 'Model inference failed',
    [CLIErrorCode.TRAINING_FAILED]: 'Model training failed',
    [CLIErrorCode.PROJECT_NOT_FOUND]: 'Cirron project not found',
    [CLIErrorCode.INVALID_CONFIG]: 'Invalid project configuration',
    [CLIErrorCode.MISSING_DEPENDENCIES]: 'Missing required dependencies',
    [CLIErrorCode.BUILD_FAILED]: 'Build process failed',
    [CLIErrorCode.VALIDATION_FAILED]: 'Validation checks failed',
    [CLIErrorCode.COMPILE_FAILED]: 'Compilation failed',
    [CLIErrorCode.UNIT_TESTS_FAILED]: 'Unit tests failed',
    [CLIErrorCode.LINT_FAILED]: 'Code linting failed',
    [CLIErrorCode.TYPE_CHECK_FAILED]: 'Type checking failed',
    [CLIErrorCode.CODE_QUALITY_FAILED]: 'Code quality checks failed',
    [CLIErrorCode.DOCKER_FAILED]: 'Docker operation failed',
    [CLIErrorCode.DEPLOYMENT_FAILED]: 'Deployment failed',
    [CLIErrorCode.NETWORK_ERROR]: 'Network operation failed',
    [CLIErrorCode.AUTHENTICATION_FAILED]: 'Authentication failed',
    [CLIErrorCode.FILE_NOT_FOUND]: 'Required file not found',
    [CLIErrorCode.PERMISSION_DENIED]: 'Permission denied',
    [CLIErrorCode.DISK_FULL]: 'Insufficient disk space',
    [CLIErrorCode.IO_ERROR]: 'Input/output error',
    [CLIErrorCode.GIT_ERROR]: 'Git operation failed',
    [CLIErrorCode.REPOSITORY_ERROR]: 'Repository operation failed',
    [CLIErrorCode.INTERNAL_ERROR]: 'Internal CLI error',
    [CLIErrorCode.UNKNOWN_ERROR]: 'Unknown error occurred'
  };

  return descriptions[code] || 'Unknown error';
}