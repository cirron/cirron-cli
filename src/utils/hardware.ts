import { execSync } from "child_process";
import fs from "fs-extra";
import os from "os";
import path from "path";
import type {
  CudaDevice,
  FrameworkCompatibility,
  HardwareConfig,
  HardwareProfile,
  HardwareSpecs,
} from "../types";
import { logger } from "./logger";

export class HardwareDetector {
  static async detectCurrentDevice(): Promise<HardwareConfig> {
    const specs = await HardwareDetector.detectHardwareSpecs();
    const compatibility =
      await HardwareDetector.checkFrameworkCompatibility(specs);

    // Determine hardware type based on capabilities
    let type: "cpu" | "gpu" | "cuda" | "custom" = "cpu";
    if (specs.cuda?.available) {
      type = "cuda";
    } else if (specs.gpu) {
      type = "gpu";
    }

    return {
      type,
      architecture: specs.cpu?.architecture || os.arch(),
      specifications: specs,
      compatibility,
      detectedAt: new Date().toISOString(),
      isCurrentDevice: true,
    };
  }

  static async detectHardwareSpecs(): Promise<HardwareSpecs> {
    const specs: HardwareSpecs = {};

    // CPU Detection
    specs.cpu = {
      cores: os.cpus().length,
      model: os.cpus()[0]?.model || "Unknown",
      architecture: os.arch(),
    };

    // Memory Detection
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    specs.memory = {
      total: HardwareDetector.formatBytes(totalMemory),
      available: HardwareDetector.formatBytes(freeMemory),
    };

    // GPU Detection
    try {
      const gpu = await HardwareDetector.detectGPU();
      if (gpu) {
        specs.gpu = gpu;
      }
    } catch (error) {
      logger.debug("GPU detection failed:", error);
    }

    // CUDA Detection
    try {
      const cuda = await HardwareDetector.detectCUDA();
      if (cuda) {
        specs.cuda = cuda;
      }
    } catch (error) {
      logger.debug("CUDA detection failed:", error);
    }

    return specs;
  }

  static async detectGPU(): Promise<HardwareSpecs["gpu"] | undefined> {
    try {
      // Try different methods based on platform
      if (process.platform === "darwin") {
        return HardwareDetector.detectGPUMacOS();
      }
      if (process.platform === "linux") {
        return HardwareDetector.detectGPULinux();
      }
      if (process.platform === "win32") {
        return HardwareDetector.detectGPUWindows();
      }
    } catch (error) {
      logger.debug("GPU detection error:", error);
    }
    return;
  }

  static async detectGPUMacOS(): Promise<HardwareSpecs["gpu"] | undefined> {
    try {
      const output = execSync("system_profiler SPDisplaysDataType", {
        encoding: "utf8",
      });
      const gpuMatch = output.match(/Chipset Model:\s*(.+)/);
      const memoryMatch = output.match(/VRAM \(Total\):\s*(.+)/);

      if (gpuMatch && gpuMatch[1]) {
        return {
          model: gpuMatch[1].trim(),
          memory:
            memoryMatch && memoryMatch[1] ? memoryMatch[1].trim() : "Unknown",
          drivers: "Metal",
        };
      }
    } catch (error) {
      logger.debug("macOS GPU detection failed:", error);
    }
    return;
  }

  static async detectGPULinux(): Promise<HardwareSpecs["gpu"] | undefined> {
    try {
      // Try nvidia-smi first
      const nvidiaOutput = execSync(
        "nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits",
        { encoding: "utf8" }
      );
      const lines = nvidiaOutput.trim().split("\n");
      if (lines.length > 0 && lines[0]) {
        const parts = lines[0].split(", ");
        const name = parts[0];
        const memory = parts[1];
        return {
          model: name?.trim() || "Unknown NVIDIA GPU",
          memory: memory ? `${memory.trim()} MB` : "Unknown",
          drivers: "NVIDIA",
        };
      }
    } catch (error) {
      // Try lspci as fallback
      try {
        const lspciOutput = execSync("lspci | grep -i vga", {
          encoding: "utf8",
        });
        const gpuMatch = lspciOutput.match(/VGA compatible controller:\s*(.+)/);
        if (gpuMatch && gpuMatch[1]) {
          return {
            model: gpuMatch[1].trim(),
            memory: "Unknown",
            drivers: "Unknown",
          };
        }
      } catch (lspciError) {
        logger.debug("Linux GPU detection failed:", error);
      }
    }
    return;
  }

  static async detectGPUWindows(): Promise<HardwareSpecs["gpu"] | undefined> {
    try {
      const output = execSync(
        "wmic path win32_VideoController get name,AdapterRAM",
        { encoding: "utf8" }
      );
      const lines = output
        .split("\n")
        .filter((line) => line.trim() && !line.includes("AdapterRAM"));
      if (lines.length > 0 && lines[0]) {
        const parts = lines[0].trim().split(/\s+/);
        const ram = parts[0];
        const name = parts.slice(1).join(" ");
        return {
          model: name || "Unknown GPU",
          memory: ram
            ? HardwareDetector.formatBytes(Number.parseInt(ram))
            : "Unknown",
          drivers: "DirectX",
        };
      }
    } catch (error) {
      logger.debug("Windows GPU detection failed:", error);
    }
    return;
  }

  static async detectCUDA(): Promise<HardwareSpecs["cuda"] | undefined> {
    try {
      const nvccOutput = execSync("nvcc --version", { encoding: "utf8" });
      const versionMatch = nvccOutput.match(/release (\d+\.\d+)/);

      if (versionMatch && versionMatch[1]) {
        const version = versionMatch[1];
        const devices = await HardwareDetector.detectCUDADevices();

        return {
          version,
          available: devices.length > 0,
          devices,
        };
      }
    } catch (error) {
      logger.debug("CUDA detection failed:", error);
    }
    return;
  }

  static async detectCUDADevices(): Promise<CudaDevice[]> {
    try {
      const output = execSync(
        "nvidia-smi --query-gpu=index,name,memory.total,compute_cap --format=csv,noheader,nounits",
        { encoding: "utf8" }
      );
      const lines = output.trim().split("\n");

      return lines.map((line) => {
        const [id, name, memory, computeCap] = line.split(", ");
        return {
          id: Number.parseInt(id || "0"),
          name: name?.trim() || "Unknown",
          memory: memory ? `${memory.trim()} MB` : "Unknown",
          computeCapability: computeCap?.trim() || "Unknown",
        };
      });
    } catch (error) {
      logger.debug("CUDA device detection failed:", error);
      return [];
    }
  }

  static async checkFrameworkCompatibility(
    specs: HardwareSpecs
  ): Promise<FrameworkCompatibility> {
    const compatibility: FrameworkCompatibility = {
      pytorch: false,
      tensorflow: false,
      sklearn: true, // sklearn is always compatible
      requirements: [],
      warnings: [],
    };

    // Check PyTorch compatibility
    try {
      execSync('python3 -c "import torch; print(torch.__version__)"', {
        encoding: "utf8",
      });
      compatibility.pytorch = true;

      if (specs.cuda?.available) {
        try {
          const cudaCheck = execSync(
            'python3 -c "import torch; print(torch.cuda.is_available())"',
            { encoding: "utf8" }
          );
          if (!cudaCheck.includes("True")) {
            compatibility.warnings?.push(
              "CUDA available but PyTorch not compiled with CUDA support"
            );
          }
        } catch (error) {
          compatibility.warnings?.push("Could not verify PyTorch CUDA support");
        }
      }
    } catch (error) {
      compatibility.requirements?.push("pip install torch");
    }

    // Check TensorFlow compatibility
    try {
      execSync('python3 -c "import tensorflow as tf; print(tf.__version__)"', {
        encoding: "utf8",
      });
      compatibility.tensorflow = true;

      if (specs.gpu) {
        try {
          const gpuCheck = execSync(
            "python3 -c \"import tensorflow as tf; print(len(tf.config.list_physical_devices('GPU')))\"",
            { encoding: "utf8" }
          );
          if (gpuCheck.trim() === "0") {
            compatibility.warnings?.push(
              "GPU available but TensorFlow not detecting it"
            );
          }
        } catch (error) {
          compatibility.warnings?.push(
            "Could not verify TensorFlow GPU support"
          );
        }
      }
    } catch (error) {
      compatibility.requirements?.push("pip install tensorflow");
    }

    return compatibility;
  }

  static getPresetProfiles(): HardwareProfile[] {
    return [
      {
        name: "CPU Only",
        description: "CPU-only configuration for lightweight models",
        config: {
          type: "cpu",
          architecture: "x86_64",
          specifications: {
            cpu: {
              cores: 4,
              model: "Generic CPU",
              architecture: "x86_64",
            },
          },
          compatibility: {
            pytorch: true,
            tensorflow: true,
            sklearn: true,
          },
        },
        frameworks: ["pytorch", "tensorflow", "sklearn"],
        recommended: true,
      },
      {
        name: "NVIDIA GPU",
        description: "NVIDIA GPU with CUDA support",
        config: {
          type: "cuda",
          architecture: "x86_64",
          specifications: {
            gpu: {
              model: "NVIDIA GPU",
              memory: "8GB",
              drivers: "NVIDIA",
            },
            cuda: {
              version: "11.8",
              available: true,
              devices: [],
            },
          },
          compatibility: {
            pytorch: true,
            tensorflow: true,
            sklearn: true,
          },
        },
        frameworks: ["pytorch", "tensorflow"],
        recommended: true,
      },
      {
        name: "Apple Silicon",
        description: "Apple M1/M2 with Metal support",
        config: {
          type: "gpu",
          architecture: "arm64",
          specifications: {
            cpu: {
              cores: 8,
              model: "Apple Silicon",
              architecture: "arm64",
            },
            gpu: {
              model: "Apple GPU",
              memory: "Unified Memory",
              drivers: "Metal",
            },
          },
          compatibility: {
            pytorch: true,
            tensorflow: true,
            sklearn: true,
          },
        },
        frameworks: ["pytorch", "tensorflow", "sklearn"],
        recommended: true,
      },
    ];
  }

  static async saveHardwareConfig(
    config: HardwareConfig,
    filePath?: string
  ): Promise<string> {
    const configPath = filePath || path.join(process.cwd(), "hardware.json");
    await fs.writeJSON(configPath, config, { spaces: 2 });
    return configPath;
  }

  static async loadHardwareConfig(
    filePath?: string
  ): Promise<HardwareConfig | null> {
    const configPath = filePath || path.join(process.cwd(), "hardware.json");

    if (await fs.pathExists(configPath)) {
      return await fs.readJSON(configPath);
    }

    return null;
  }

  static formatBytes(bytes: number): string {
    const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
    if (bytes === 0) {
      return "0 Bytes";
    }
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return Math.round((bytes / 1024 ** i) * 100) / 100 + " " + sizes[i];
  }

  static validateHardwareConfig(config: HardwareConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (
      !(config.type && ["cpu", "gpu", "cuda", "custom"].includes(config.type))
    ) {
      errors.push("Invalid hardware type");
    }

    if (!config.architecture) {
      errors.push("Architecture is required");
    }

    if (!config.specifications) {
      errors.push("Hardware specifications are required");
    }

    if (config.type === "cuda" && !config.specifications.cuda?.available) {
      errors.push("CUDA type selected but CUDA not available");
    }

    if (config.type === "gpu" && !config.specifications.gpu) {
      errors.push("GPU type selected but no GPU specifications provided");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
