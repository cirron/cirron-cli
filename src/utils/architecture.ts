import path from "node:path";
import fs from "fs-extra";
import { load as loadYaml } from "js-yaml";
import type { HardwareConfig, ModelConfig, ProjectConfig } from "../types";
import { HardwareDetector } from "./hardware";
import { logger } from "./logger";

/**
 * Target-architecture resolution, hardware validation, the PyTorch device
 * placement snippet and the index-file reader shared by build, compile, plan
 * and replay.
 *
 * `cirron build` began as a copy of `cirron compile`, and these helpers had
 * drifted into byte-identical copies across those files. They live here so a
 * change to architecture detection, hardware validation or device placement is
 * a one-file edit.
 *
 * Note the split with `./validation`: that module's checks return the error
 * strings they find so each command can decide what to do with them, whereas
 * `validateHardwareCompatibility` throws. `checkIndexConfig` there validates a
 * loaded index config; `loadIndexFile` here is the reader.
 */

/**
 * Whether a declared hardware config describes an Apple Silicon machine.
 *
 * This is the shape the "Apple Silicon" preset and `cirron hardware` detection
 * on a Mac both write: a generic `gpu` type on an `arm64` CPU. Resolution and
 * validation share this test so they cannot disagree about it.
 *
 * @param hardware - The project's declared hardware block.
 */
export function isAppleSilicon(hardware: HardwareConfig): boolean {
  return hardware.type === "gpu" && hardware.architecture === "arm64";
}

/**
 * Whether a target architecture runs on an accelerator rather than the CPU.
 *
 * @param architecture - The resolved target architecture.
 */
export function isGpuArchitecture(architecture: string): boolean {
  return (
    architecture === "cuda" || architecture === "gpu" || architecture === "mps"
  );
}

/**
 * Map a target architecture to one a Linux container can run.
 *
 * `cirron build` ships its artifacts in a Linux image, which cannot reach
 * Metal, and a state dict saved from MPS tensors would not load there. An
 * `mps` target therefore builds for `cpu`; every other target is unchanged.
 *
 * @param architecture - The resolved target architecture.
 * @returns `cpu` for `mps`, otherwise `architecture`.
 */
export function containerArchitecture(architecture: string): string {
  return architecture === "mps" ? "cpu" : architecture;
}

/**
 * Python that moves `model` onto the device for a PyTorch target architecture.
 *
 * Shared by the compile, build and replay script generators. A `cuda` or `mps`
 * target whose device is unavailable at run time prints a warning and leaves
 * the model on the CPU; any other target leaves it there silently.
 *
 * @param architecture - The resolved target architecture.
 * @returns A top-level Python block that expects `torch` imported and `model`
 * bound.
 */
export function pytorchDevicePlacement(architecture: string): string {
  return `if "${architecture}" == "cuda":
    if torch.cuda.is_available():
        model = model.cuda()
        print("Model moved to CUDA")
    else:
        print("Warning: CUDA not available, using CPU")
elif "${architecture}" == "mps":
    if torch.backends.mps.is_available():
        model = model.to("mps")
        print("Model moved to MPS")
    else:
        print("Warning: MPS not available, using CPU")
`;
}

/**
 * Resolve the target architecture the same way in compile, build and plan.
 *
 * An explicit `--arch` wins, then the model config's `inference.device`, then
 * the project's declared hardware via `determineArchitectureFromHardware`.
 *
 * @param projectConfig - The loaded project configuration.
 * @param modelConfig - The loaded model config, or null when there is none.
 * @param explicitArch - The `--arch` value, when one was given.
 */
export async function resolveTargetArchitecture(
  projectConfig: ProjectConfig,
  modelConfig: ModelConfig | null,
  explicitArch?: string
): Promise<string> {
  return (
    explicitArch ||
    modelConfig?.inference?.device ||
    (await determineArchitectureFromHardware(projectConfig))
  );
}

/**
 * Check that a framework's generated scripts can target an architecture.
 *
 * Runs whether or not the project declares hardware, since `--arch` and
 * `inference.device` can name a target without one. Only the PyTorch scripts
 * place a model on MPS; any other framework would train on the CPU and still
 * label the artifact `mps`.
 *
 * @param architecture - The resolved target architecture.
 * @param framework - The project's ML framework, when declared.
 * @throws If `architecture` is `mps` and `framework` is not `pytorch`.
 */
export function validateTargetFramework(
  architecture: string,
  framework?: string
): void {
  if (architecture === "mps" && framework !== "pytorch") {
    throw new Error("MPS architecture is only supported for PyTorch");
  }
}

/**
 * Resolve the target architecture from a project's declared hardware.
 *
 * Falls back to `determineDefaultArchitecture` when the project declares no
 * hardware block. PyTorch on Apple Silicon resolves to `mps`; PyTorch on any
 * other `gpu` hardware resolves to `cuda`.
 *
 * @param projectConfig - The loaded project configuration.
 * @returns One of `cuda`, `mps`, `gpu` or `cpu`.
 */
export async function determineArchitectureFromHardware(
  projectConfig: ProjectConfig
): Promise<string> {
  // First check if hardware configuration exists in project
  if (projectConfig.hardware) {
    const hardwareType = projectConfig.hardware.type;

    // Map hardware type to architecture based on framework
    if (projectConfig.framework === "pytorch") {
      if (isAppleSilicon(projectConfig.hardware)) {
        return "mps";
      }
      return hardwareType === "cuda" || hardwareType === "gpu" ? "cuda" : "cpu";
    }
    if (projectConfig.framework === "tensorflow") {
      return hardwareType === "cuda" || hardwareType === "gpu" ? "gpu" : "cpu";
    }
    return "cpu"; // sklearn and custom default to CPU
  }

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
    throw new Error(`Failed to load index file: ${detail}`, { cause: error });
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
      hardwareConfig.type === "gpu"
        ? 'CUDA architecture selected but hardware configuration is not CUDA-capable (type "gpu"); use --arch cpu, or --arch mps on Apple Silicon'
        : "CUDA architecture selected but hardware configuration is not CUDA-capable"
    );
  }

  if (targetArch === "mps" && !isAppleSilicon(hardwareConfig)) {
    validationErrors.push(
      'MPS architecture selected but hardware configuration is not Apple Silicon (type "gpu", architecture "arm64")'
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
