import { spawn } from "node:child_process";
import chalk from "chalk";
import { CLIError, CLIErrorCode } from "./errors";
import { logger } from "./logger";

export interface ExecutionResult {
  cliError?: CLIError;
  command: string;
  duration: number;
  exitCode: number;
  parsedErrors?: ParsedError[];
  stderr: string;
  stdout: string;
  success: boolean;
}

export interface ParsedError {
  file?: string;
  line?: number;
  message: string;
  suggestions?: string[];
  traceback: string[];
  type: "exception" | "syntax" | "import" | "runtime";
}

export interface ExecutionOptions {
  baseErrorCode?: CLIErrorCode;
  cwd?: string;
  encoding?: string;
  env?: Record<string, string>;
  jsonMode?: boolean;
  retries?: number;
  retryCondition?: (result: ExecutionResult) => boolean;
  retryDelay?: number;
  showOutput?: boolean;
  strictMode?: boolean;
  timeout?: number;
}

export interface RetryableOperation {
  backoffMultiplier: number;
  baseDelay: number;
  maxAttempts: number;
  maxDelay: number;
}

const DEFAULT_RETRY_CONFIG: RetryableOperation = {
  maxAttempts: 3,
  baseDelay: 1000,
  maxDelay: 10_000,
  backoffMultiplier: 2,
};

export class ExecutionError extends Error {
  result: ExecutionResult;
  constructor(result: ExecutionResult, message?: string) {
    super(message || `Command failed: ${result.command}`);
    this.result = result;
    this.name = "ExecutionError";
  }
}

export async function executeScript(
  command: string,
  args: string[] = [],
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const {
    cwd = process.cwd(),
    timeout = 30_000,
    retries = 0,
    retryDelay = 1000,
    retryCondition,
    encoding = "utf8",
    env = process.env as Record<string, string>,
    showOutput = false,
    baseErrorCode = CLIErrorCode.SCRIPT_FAILED,
  } = options;

  let attempt = 0;
  let lastResult: ExecutionResult;

  do {
    attempt++;

    if (attempt > 1) {
      logger.info(`Retry attempt ${attempt}/${retries + 1} for: ${command}`);
      await sleep(retryDelay * 2 ** (attempt - 2)); // Exponential backoff
    }

    lastResult = await executeOnce(command, args, {
      cwd,
      timeout,
      encoding,
      env,
      showOutput,
      baseErrorCode,
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
  args: string[],
  options: {
    cwd: string;
    timeout: number;
    encoding: string;
    env: Record<string, string>;
    showOutput: boolean;
    baseErrorCode: CLIErrorCode;
  }
): Promise<ExecutionResult> {
  const startTime = Date.now();

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, options.timeout);

    child.stdout?.on("data", (data) => {
      const chunk = data.toString(options.encoding);
      stdout += chunk;
      if (options.showOutput) {
        process.stdout.write(chunk);
      }
    });

    child.stderr?.on("data", (data) => {
      const chunk = data.toString(options.encoding);
      stderr += chunk;
      if (options.showOutput) {
        process.stderr.write(chunk);
      }
    });

    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const commandStr = `${command} ${args.join(" ")}`.trim();

      if (timedOut) {
        const result: ExecutionResult = {
          success: false,
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nProcess timed out`,
          command: commandStr,
          duration,
        };
        result.parsedErrors = parseErrors(`${stderr}\nProcess timed out`);
        result.cliError = new CLIError({
          code: CLIErrorCode.TIMEOUT,
          message: `Operation timed out after ${options.timeout}ms`,
          details: { command: commandStr, duration, stdout, stderr },
          suggestions: ["Increase timeout or optimize the operation"],
          recoverable: true,
        });
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
        duration,
      };

      if (!success) {
        result.parsedErrors = parseErrors(stderr);
        // Create CLI error for failed executions
        result.cliError = CLIError.fromExecutionResult(
          result,
          options.baseErrorCode || CLIErrorCode.SCRIPT_FAILED
        );
      }

      resolve(result);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      const duration = Date.now() - startTime;
      const commandStr = `${command} ${args.join(" ")}`.trim();

      const result: ExecutionResult = {
        success: false,
        exitCode: -1,
        stdout,
        stderr: `${stderr}\nProcess error: ${error.message}`,
        command: commandStr,
        duration,
      };
      result.parsedErrors = parseErrors(`Process error: ${error.message}`);
      result.cliError = new CLIError({
        code: CLIErrorCode.COMMAND_NOT_FOUND,
        message: `Process error: ${error.message}`,
        details: { command: commandStr, duration, stdout, stderr },
        cause: error,
        recoverable: true,
      });
      resolve(result);
    });
  });
}

export function parseErrors(stderr: string): ParsedError[] {
  if (!stderr.trim()) {
    return [];
  }

  const errors: ParsedError[] = [];
  const lines = stderr.split("\n");

  // Parse Python tracebacks
  let currentTraceback: string[] = [];
  let inTraceback = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) {
      continue;
    }

    // Start of traceback
    if (line.includes("Traceback (most recent call last):")) {
      inTraceback = true;
      currentTraceback = [line];
      continue;
    }

    if (inTraceback) {
      currentTraceback.push(line);

      // Check for exception types
      const exceptionMatch = line.match(
        /^(\w+Error|\w+Exception|\w+Warning):\s*(.+)$/
      );
      if (exceptionMatch && exceptionMatch[1] && exceptionMatch[2]) {
        const exceptionType = exceptionMatch[1];
        const message = exceptionMatch[2];

        // Extract file and line info from traceback
        let file: string | undefined;
        let lineNumber: number | undefined;

        const fileMatches = currentTraceback.filter((l) =>
          l.includes('File "')
        );
        if (fileMatches.length > 0) {
          const lastFileMatch = fileMatches[fileMatches.length - 1];
          if (lastFileMatch) {
            const fileMatch = lastFileMatch.match(/File "([^"]+)", line (\d+)/);
            if (fileMatch && fileMatch[1] && fileMatch[2]) {
              file = fileMatch[1];
              lineNumber = Number.parseInt(fileMatch[2], 10);
            }
          }
        }

        const errorType = getErrorType(exceptionType);
        const parsedError: ParsedError = {
          type: errorType,
          message,
          traceback: [...currentTraceback],
          suggestions: generateSuggestions(errorType, message, exceptionType),
        };
        if (file) {
          parsedError.file = file;
        }
        if (lineNumber) {
          parsedError.line = lineNumber;
        }
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
          type: "syntax",
          message: syntaxMatch[1],
          traceback: [line],
          suggestions: generateSuggestions("syntax", syntaxMatch[1]),
        });
      }

      // Import errors
      const importMatch = line.match(
        /(ImportError|ModuleNotFoundError):\s*(.+)/
      );
      if (importMatch && importMatch[1] && importMatch[2]) {
        errors.push({
          type: "import",
          message: importMatch[2],
          traceback: [line],
          suggestions: generateSuggestions(
            "import",
            importMatch[2],
            importMatch[1]
          ),
        });
      }
    }
  }

  return errors;
}

function getErrorType(exceptionName: string): ParsedError["type"] {
  if (exceptionName.includes("Syntax")) {
    return "syntax";
  }
  if (
    exceptionName.includes("Import") ||
    exceptionName.includes("ModuleNotFound")
  ) {
    return "import";
  }
  if (exceptionName.includes("Runtime")) {
    return "runtime";
  }
  return "exception";
}

function generateSuggestions(
  errorType: ParsedError["type"],
  message: string,
  exceptionName?: string
): string[] {
  const suggestions: string[] = [];
  const lowerMessage = message.toLowerCase();

  // Import/Module errors
  if (errorType === "import" || exceptionName?.includes("ModuleNotFound")) {
    // Common ML libraries
    if (lowerMessage.includes("torch")) {
      suggestions.push("Try running: pip install torch torchvision");
      suggestions.push(
        "For GPU support: pip install torch torchvision --index-url https://download.pytorch.org/whl/cu118"
      );
    } else if (lowerMessage.includes("tensorflow")) {
      suggestions.push("Try running: pip install tensorflow");
      suggestions.push("For GPU support: pip install tensorflow[gpu]");
    } else if (
      lowerMessage.includes("sklearn") ||
      lowerMessage.includes("scikit")
    ) {
      suggestions.push("Try running: pip install scikit-learn");
    } else if (lowerMessage.includes("numpy")) {
      suggestions.push("Try running: pip install numpy");
    } else if (lowerMessage.includes("pandas")) {
      suggestions.push("Try running: pip install pandas");
    } else if (lowerMessage.includes("matplotlib")) {
      suggestions.push("Try running: pip install matplotlib");
    } else if (
      lowerMessage.includes("cv2") ||
      lowerMessage.includes("opencv")
    ) {
      suggestions.push("Try running: pip install opencv-python");
    } else if (
      lowerMessage.includes("pil") ||
      lowerMessage.includes("pillow")
    ) {
      suggestions.push("Try running: pip install Pillow");
    } else {
      // Generic module not found
      const moduleMatch = message.match(/No module named '([^']+)'/);
      if (moduleMatch && moduleMatch[1]) {
        suggestions.push(`Try running: pip install ${moduleMatch[1]}`);
      }
    }
  }

  // CUDA errors
  if (lowerMessage.includes("cuda")) {
    if (lowerMessage.includes("out of memory")) {
      suggestions.push("Reduce batch size or model parameters");
      suggestions.push("Try running: torch.cuda.empty_cache()");
      suggestions.push("Consider using gradient checkpointing");
    } else if (
      lowerMessage.includes("unavailable") ||
      lowerMessage.includes("not available")
    ) {
      suggestions.push("CUDA not available - retrying with CPU backend...");
      suggestions.push(
        "Install CUDA toolkit: https://developer.nvidia.com/cuda-downloads"
      );
      suggestions.push("Verify GPU drivers are installed");
    } else if (lowerMessage.includes("driver")) {
      suggestions.push("Update your GPU drivers");
      suggestions.push("Check CUDA compatibility with your GPU");
    }
  }

  // Syntax errors
  if (errorType === "syntax") {
    if (lowerMessage.includes("indentation")) {
      suggestions.push("Check for consistent indentation (spaces vs tabs)");
      suggestions.push("Python requires consistent indentation within blocks");
    } else if (lowerMessage.includes("parenthes")) {
      suggestions.push("Check for matching parentheses ( )");
      suggestions.push("Verify function calls have proper closing parentheses");
    } else if (lowerMessage.includes("bracket")) {
      suggestions.push("Check for matching brackets [ ]");
      suggestions.push("Verify list/dict syntax is correct");
    } else if (lowerMessage.includes("colon")) {
      suggestions.push("Add missing colon : after if/for/while/def statements");
    }
  }

  // Runtime errors
  if (errorType === "runtime" || errorType === "exception") {
    if (lowerMessage.includes("device-side assert")) {
      suggestions.push("Check tensor shapes and indices in CUDA operations");
      suggestions.push(
        "Add torch.cuda.synchronize() to get clearer error location"
      );
    } else if (
      lowerMessage.includes("shape") ||
      lowerMessage.includes("dimension")
    ) {
      suggestions.push("Verify tensor shapes match expected dimensions");
      suggestions.push("Use tensor.shape or tensor.size() to debug dimensions");
    } else if (
      lowerMessage.includes("index") &&
      lowerMessage.includes("out of range")
    ) {
      suggestions.push("Check array/tensor indices are within bounds");
      suggestions.push("Verify data loading and batch processing logic");
    } else if (lowerMessage.includes("key error")) {
      suggestions.push("Check dictionary keys exist before accessing");
      suggestions.push("Use dict.get(key, default) for safe access");
    } else if (lowerMessage.includes("attribute")) {
      suggestions.push("Check object has the expected attributes/methods");
      suggestions.push("Verify object initialization and type");
    }
  }

  return suggestions;
}

export function formatExecutionError(
  result: ExecutionResult,
  showDetails = false,
  useColors = true
): string {
  const parts: string[] = [];

  // Helper function for conditional coloring
  const colorize = (text: string, colorFn: (text: string) => string) =>
    useColors ? colorFn(text) : text;

  parts.push(colorize(`Command failed: ${result.command}`, chalk.red));
  parts.push(colorize(`Exit code: ${result.exitCode}`, chalk.gray));
  parts.push(colorize(`Duration: ${result.duration}ms`, chalk.gray));

  if (result.parsedErrors && result.parsedErrors.length > 0) {
    parts.push("");
    parts.push(colorize("Parsed Errors:", chalk.yellow));

    for (const [index, error] of result.parsedErrors.entries()) {
      // Error header with type and message
      parts.push(
        colorize(`  ${index + 1}. ${error.type.toUpperCase()}: `, chalk.red) +
          colorize(error.message, chalk.bold)
      );

      // File and line information
      if (error.file && error.line !== undefined) {
        parts.push(
          colorize(`     Location: ${error.file}:${error.line}`, chalk.yellow)
        );
      }

      // Suggestions
      if (error.suggestions && error.suggestions.length > 0) {
        parts.push(colorize("     Suggestions:", chalk.cyan));
        for (const suggestion of error.suggestions) {
          parts.push(colorize(`       • ${suggestion}`, chalk.green));
        }
      }

      // Colorized traceback
      if (showDetails && error.traceback.length > 0) {
        parts.push(colorize("     Traceback:", chalk.blue));
        for (const tracebackLine of error.traceback) {
          if (tracebackLine && tracebackLine.trim()) {
            parts.push(formatTracebackLine(tracebackLine, useColors));
          }
        }
      }
    }
  }

  if (showDetails) {
    if (result.stdout) {
      parts.push("");
      parts.push(colorize("STDOUT:", chalk.blue));
      parts.push(result.stdout);
    }

    if (result.stderr) {
      parts.push("");
      parts.push(colorize("STDERR:", chalk.magenta));
      parts.push(result.stderr);
    }
  }

  return parts.join("\n");
}

function formatTracebackLine(line: string, useColors = true): string {
  const colorize = (text: string, colorFn: (text: string) => string) =>
    useColors ? colorFn(text) : text;

  // File reference lines (e.g., File "/path/to/file.py", line 42, in function_name)
  const fileMatch = line.match(/^\s*File "(.*?)", line (\d+)(?:, in (.*))?$/);
  if (fileMatch && fileMatch[1] && fileMatch[2]) {
    const [, filePath, lineNum, functionName] = fileMatch;
    const fileName = filePath.split("/").pop() || filePath;
    let formatted = `       ${colorize("File", chalk.gray)} "${colorize(fileName, chalk.yellow)}"`;
    formatted += `, ${colorize("line", chalk.gray)} ${colorize(lineNum, chalk.cyan)}`;
    if (functionName) {
      formatted += `, in ${colorize(functionName, chalk.blue)}`;
    }
    return formatted;
  }

  // Code lines (indented source code)
  if (line.match(/^\s{4,}/)) {
    return `       ${colorize(line.trim(), chalk.white)}`;
  }

  // Exception lines (e.g., RuntimeError: something went wrong)
  const exceptionMatch = line.match(
    /^(\w+(?:Error|Exception|Warning)):\s*(.*)$/
  );
  if (exceptionMatch && exceptionMatch[1] && exceptionMatch[2]) {
    const [, exceptionType, message] = exceptionMatch;
    return `       ${colorize(exceptionType, chalk.red)}: ${colorize(message, chalk.bold)}`;
  }

  // Traceback header
  if (line.includes("Traceback (most recent call last)")) {
    return `       ${colorize(line, chalk.yellow)}`;
  }

  // Default formatting
  return `       ${colorize(line, chalk.gray)}`;
}

export function formatExecutionResultAsJSON(
  result: ExecutionResult,
  includeRaw = false
): string {
  const jsonResult: any = {
    timestamp: new Date().toISOString(),
    command: result.command,
    success: result.success,
    exitCode: result.exitCode,
    duration: result.duration,
    errors:
      result.parsedErrors?.map((error) => ({
        type: error.type,
        message: error.message,
        file: error.file,
        line: error.line,
        suggestions: error.suggestions,
        ...(includeRaw && { traceback: error.traceback }),
      })) || [],
    ...(result.cliError && {
      cliError: {
        code: result.cliError.code,
        message: result.cliError.message,
        recoverable: result.cliError.recoverable,
        suggestions: result.cliError.suggestions,
      },
    }),
  };

  // Include raw output if requested
  if (includeRaw) {
    jsonResult.stdout = result.stdout;
    jsonResult.stderr = result.stderr;
  }

  return JSON.stringify(jsonResult, null, 2);
}

export function logExecutionResult(
  result: ExecutionResult,
  options: {
    jsonMode?: boolean;
    showDetails?: boolean;
    includeRaw?: boolean;
  } = {}
): void {
  if (options.jsonMode) {
    console.log(formatExecutionResultAsJSON(result, options.includeRaw));
  } else {
    console.log(formatExecutionError(result, options.showDetails));
  }
}

export async function executePythonScript(
  script: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  return executeScript("python3", ["-c", script], {
    retryCondition: (result) => {
      // Retry for CUDA setup issues and certain import errors
      return (
        result.stderr.includes("CUDA") ||
        result.stderr.includes("RuntimeError") ||
        result.stderr.includes("device-side assert")
      );
    },
    retries: 2,
    retryDelay: 2000,
    baseErrorCode: CLIErrorCode.PYTHON_SYNTAX_ERROR, // More specific error code for Python scripts
    ...options,
  });
}

/**
 * Execute a result and throw CLIError in strict mode if it fails
 */
export function handleExecutionResult(
  result: ExecutionResult,
  strictMode = false
): ExecutionResult {
  if (!result.success && strictMode && result.cliError) {
    throw result.cliError;
  }
  return result;
}

/**
 * Execute a command and handle strict mode errors
 */
export async function executeWithStrictMode(
  command: string,
  args: string[] = [],
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const result = await executeScript(command, args, options);
  return handleExecutionResult(result, options.strictMode);
}

export async function executePythonFile(
  filePath: string,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  return executeScript("python3", [filePath], {
    retryCondition: (result) => {
      // Retry for CUDA setup issues
      return (
        result.stderr.includes("CUDA") || result.stderr.includes("RuntimeError")
      );
    },
    retries: 1,
    retryDelay: 1500,
    baseErrorCode: CLIErrorCode.SCRIPT_FAILED,
    ...options,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRetryableOperation(
  config: Partial<RetryableOperation> = {}
): RetryableOperation {
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
        config.baseDelay * config.backoffMultiplier ** (attempt - 1),
        config.maxDelay
      );

      logger.info(
        `Operation failed, retrying in ${delay}ms (attempt ${attempt}/${config.maxAttempts})`
      );
      await sleep(delay);
    }
  }

  throw lastError!;
}
