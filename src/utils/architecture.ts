import path from "node:path";
import fs from "fs-extra";
import { load as loadYaml } from "js-yaml";
import type { HardwareConfig, ProjectConfig } from "../types";
import { HardwareDetector } from "./hardware";
import { logger } from "./logger";

/**
 * Target-architecture resolution and the index-file reader shared by build and
 * compile.
 *
 * `cirron build` began as a copy of `cirron compile`, and these four helpers
 * stayed byte-identical across both files. They live here so a change to
 * architecture detection or hardware validation is a one-file edit.
 *
 * Note the split with `./validation`: that module's checks return the error
 * strings they find so each command can decide what to do with them, whereas
 * `validateHardwareCompatibility` throws. `checkIndexConfig` there validates a
 * loaded index config; `loadIndexFile` here is the reader.
 */

/**
 * Resolve the target architecture from a project's declared hardware.
 *
 * Falls back to `determineDefaultArchitecture` when the project declares no
 * hardware block.
 *
 * @param projectConfig - The loaded project configuration.
 * @returns One of `cuda`, `gpu` or `cpu`.
 */
export async function determineArchitectureFromHardware(
  projectConfig: ProjectConfig
): Promise<string> {
  // First check if hardware configuration exists in project
  if (projectConfig.hardware) {
    const hardwareType = projectConfig.hardware.type;

    // Map hardware type to architecture based on framework
    if (projectConfig.framework === "pytorch") {
      return hardwareType === "cuda"
        ? "cuda"
        : hardwareType === "gpu"
          ? "cuda"
          : "cpu";
    }
    if (projectConfig.framework === "tensorflow") {
      return hardwareType === "cuda" || hardwareType === "gpu" ? "gpu" : "cpu";
    }
    return "cpu"; // sklearn and custom default to CPU
  }

  // Fallback to legacy logic
  return await determineDefaultArchitecture(projectConfig);
}

/**
 * Resolve the target architecture from framework and `gpuRequired` alone.
 *
 * @param projectConfig - The loaded project configuration.
 * @returns One of `cuda`, `gpu` or `cpu`.
 */
export async function determineDefaultArchitecture(
  projectConfig: ProjectConfig
): Promise<string> {
  // Determine default architecture based on framework and requirements
  if (projectConfig.framework === "pytorch") {
    return projectConfig.gpuRequired ? "cuda" : "cpu";
  }
  if (projectConfig.framework === "tensorflow") {
    return projectConfig.gpuRequired ? "gpu" : "cpu";
  }
  if (projectConfig.framework === "sklearn") {
    return "cpu";
  }

  // For custom or unspecified frameworks, default to CPU
  return "cpu";
}

/**
 * Read an index/manifest file, dispatching on its extension.
 *
 * @param indexPath - Path to a `.json`, `.yaml` or `.yml` file.
 * @returns The parsed contents.
 * @throws If the extension is unsupported, or the file is missing or malformed.
 */
export async function loadIndexFile(indexPath: string): Promise<any> {
  try {
    const ext = path.extname(indexPath).toLowerCase();

    if (ext === ".json") {
      return await fs.readJSON(indexPath);
    }
    if (ext === ".yaml" || ext === ".yml") {
      const content = await fs.readFile(indexPath, "utf8");
      return loadYaml(content);
    }
    throw new Error(`Unsupported index file format: ${ext}. Use JSON or YAML.`);
  } catch (error) {
    // `${error}` on an Error renders "Error: ...", so the wrapped message
    // would carry the prefix twice.
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load index file: ${detail}`);
  }
}

/**
 * Check a declared hardware config against a target architecture and framework.
 *
 * Unlike the checks in `./validation`, this throws rather than returning the
 * errors it found: callers treat a mismatch as fatal unless `--force` is set.
 * Compatibility warnings on the config are logged, not raised.
 *
 * @param hardwareConfig - The project's declared hardware block.
 * @param targetArch - The architecture being built or compiled for.
 * @param framework - The project's ML framework, when known.
 * @throws If the hardware config is malformed, cannot satisfy `targetArch`, or
 * is marked incompatible with `framework`.
 */
export async function validateHardwareCompatibility(
  hardwareConfig: HardwareConfig,
  targetArch: string,
  framework?: string
): Promise<void> {
  const validationErrors: string[] = [];

  // Validate hardware configuration
  const validation = HardwareDetector.validateHardwareConfig(hardwareConfig);
  if (!validation.valid) {
    validationErrors.push(...validation.errors);
  }

  // Check architecture compatibility
  if (targetArch === "cuda" && hardwareConfig.type !== "cuda") {
    validationErrors.push(
      "CUDA architecture selected but hardware configuration is not CUDA-capable"
    );
  }

  if (targetArch === "gpu" && hardwareConfig.type === "cpu") {
    validationErrors.push(
      "GPU architecture selected but hardware configuration is CPU-only"
    );
  }

  // Framework-specific validation
  if (framework) {
    const frameworkCompatible =
      hardwareConfig.compatibility[
        framework as keyof typeof hardwareConfig.compatibility
      ];
    if (typeof frameworkCompatible === "boolean" && !frameworkCompatible) {
      validationErrors.push(
        `Hardware not compatible with ${framework} framework`
      );
    }
  }

  // Check for compatibility warnings
  if (
    hardwareConfig.compatibility.warnings &&
    hardwareConfig.compatibility.warnings.length > 0
  ) {
    for (const warning of hardwareConfig.compatibility.warnings) {
      logger.warn(`Hardware warning: ${warning}`);
    }
  }

  if (validationErrors.length > 0) {
    throw new Error(
      `Hardware compatibility validation failed:\n${validationErrors.map((err) => `  • ${err}`).join("\n")}`
    );
  }
}
