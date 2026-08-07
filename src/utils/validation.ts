import { execSync } from "node:child_process";
import fs from "fs-extra";
import type { CLIErrorCode } from "./errors";
import { executePythonScript, handleExecutionResult } from "./execution";
import { logger } from "./logger";

/**
 * Shared pre-flight validation checks for build, compile and plan.
 *
 * Each check returns the error strings it found rather than throwing, so the
 * commands keep their own accumulate-then-decide tails: build categorizes and
 * honors --force, compile raises a CLIError under strict mode, plan throws a
 * plain joined message.
 *
 * The three commands genuinely differ in how they invoke the Python probes
 * (whether strict mode is threaded through, whether a failure is surfaced via
 * handleExecutionResult, whether parsed errors are debug-logged). Those
 * differences are options here rather than unified behavior: this module was
 * extracted to remove duplication, not to change what any command does.
 */

const DEFAULT_REQUIRED_FILES = ["src/model.py", "requirements.txt"];

/** Files a project must contain before any of build/compile/plan will run. */
export function checkRequiredFiles(files?: string[]): string[] {
  const errors: string[] = [];
  for (const file of files ?? DEFAULT_REQUIRED_FILES) {
    if (!fs.existsSync(file)) {
      errors.push(`Required file missing: ${file}`);
    }
  }
  return errors;
}

/**
 * Verify the interpreter on PATH satisfies the project's minimum.
 *
 * A version string that doesn't match the expected shape is treated as
 * acceptable, matching the original behavior: only a probe that throws
 * (python3 absent) or a genuinely lower version is an error.
 */
export function checkPythonVersion(required?: string): string[] {
  const errors: string[] = [];
  try {
    const pythonVersion = execSync("python3 --version", {
      encoding: "utf8",
    }).trim();
    const versionMatch = pythonVersion.match(/Python (\d+\.\d+\.\d+)/);

    if (versionMatch?.[1]) {
      const versionParts = versionMatch[1].split(".");
      const major = Number.parseInt(versionParts[0] || "0", 10);
      const minor = Number.parseInt(versionParts[1] || "0", 10);
      const requiredParts = (required || "3.9").split(".");
      const requiredMajor = Number.parseInt(requiredParts[0] || "3", 10);
      const requiredMinor = Number.parseInt(requiredParts[1] || "9", 10);

      if (
        major < requiredMajor ||
        (major === requiredMajor && minor < requiredMinor)
      ) {
        errors.push(
          `Python ${required || "3.9"}+ required, found ${major}.${minor}`
        );
      }
    }
  } catch {
    errors.push("Python3 not available");
  }
  return errors;
}

/**
 * Options controlling how a Python probe is executed.
 *
 * `strictMode` undefined means the probe is invoked with NO options argument
 * at all, which is how build calls it; passing `{ strictMode: undefined }`
 * is not equivalent under exactOptionalPropertyTypes.
 */
interface ProbeOptions {
  /** Debug-log the first parsed error when the probe fails. */
  debugLog?: boolean;
  /** Route the result through handleExecutionResult before inspecting it. */
  handleResult?: boolean;
  strictMode?: boolean;
}

async function runProbe(
  script: string,
  failureMessage: string,
  debugLabel: string,
  opts: ProbeOptions & { baseErrorCode?: CLIErrorCode }
): Promise<string[]> {
  const errors: string[] = [];
  try {
    const execOptions: { strictMode?: boolean; baseErrorCode?: CLIErrorCode } =
      {};
    if (opts.strictMode !== undefined) {
      execOptions.strictMode = opts.strictMode;
    }
    if (opts.baseErrorCode !== undefined) {
      execOptions.baseErrorCode = opts.baseErrorCode;
    }

    const result =
      Object.keys(execOptions).length > 0
        ? await executePythonScript(script, execOptions)
        : await executePythonScript(script);

    if (opts.handleResult) {
      handleExecutionResult(result, opts.strictMode ?? false);
    }

    if (!result.success) {
      errors.push(failureMessage);
      if (opts.debugLog && result.parsedErrors && result.parsedErrors[0]) {
        const firstError = result.parsedErrors[0];
        logger.debug(`${debugLabel}:`, firstError.message);
        if (firstError.file && firstError.line) {
          logger.debug(`Error location: ${firstError.file}:${firstError.line}`);
        }
      }
    }
  } catch {
    errors.push(failureMessage);
  }
  return errors;
}

/** Probe that PyTorch can see a CUDA device. */
export function checkCudaPytorch(opts: ProbeOptions = {}): Promise<string[]> {
  return runProbe(
    "import torch; assert torch.cuda.is_available()",
    "CUDA not available for PyTorch",
    "CUDA validation details",
    opts
  );
}

/** Probe that TensorFlow can see a GPU device. */
export function checkTensorflowGpu(opts: ProbeOptions = {}): Promise<string[]> {
  return runProbe(
    'import tensorflow as tf; assert len(tf.config.list_physical_devices("GPU")) > 0',
    "GPU not available for TensorFlow",
    "TensorFlow GPU validation details",
    opts
  );
}

/**
 * Validate an index/manifest config's shape.
 *
 * A falsy `indexConfig` is not an error: the index file is optional and this
 * only checks the contents when one was supplied.
 */
export function checkIndexConfig(
  indexConfig: unknown,
  opts: { requireDataTypes: boolean }
): string[] {
  if (!indexConfig) {
    return [];
  }

  const errors: string[] = [];
  const config = indexConfig as {
    features?: unknown;
    dataTypes?: unknown;
  };

  if (!(config.features && Array.isArray(config.features))) {
    errors.push("Index file missing or invalid features array");
  }

  if (
    opts.requireDataTypes &&
    !(config.dataTypes && typeof config.dataTypes === "object")
  ) {
    errors.push("Index file missing or invalid dataTypes object");
  }

  return errors;
}

/** Probe that the project's model module can be imported and instantiated. */
export function checkModelCreation(
  opts: ProbeOptions & { script: string; baseErrorCode?: CLIErrorCode }
): Promise<string[]> {
  const { script, ...rest } = opts;
  return runProbe(
    script,
    "Model creation failed during validation",
    "Model validation error",
    rest
  );
}
