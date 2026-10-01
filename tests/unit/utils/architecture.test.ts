import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  containerArchitecture,
  determineArchitectureFromHardware,
  determineDefaultArchitecture,
  isAppleSilicon,
  isGpuArchitecture,
  loadIndexFile,
  pytorchDevicePlacement,
  resolveTargetArchitecture,
  validateHardwareCompatibility,
  validateTargetFramework,
} from "../../../src/utils/architecture";
import { makeTmpDir } from "../../helpers/tmpdir";

/**
 * These four helpers were byte-identical copies in build.ts and compile.ts
 * before being moved here, and neither command suite exercised them directly.
 * The truth tables below are written against the moved code so a future edit to
 * architecture resolution has to break a test to change behavior.
 */

/** Minimal ProjectConfig; only the fields these helpers read are set. */
function project(extra: Record<string, unknown> = {}) {
  return { name: "demo", version: "0.1.0", ...extra } as never;
}

/** Minimal HardwareConfig with everything compatible unless overridden. */
function hardware(extra: Record<string, unknown> = {}) {
  return {
    type: "cpu",
    architecture: "x86_64",
    specifications: {
      cpu: { cores: 4, model: "x", architecture: "x86_64" },
    },
    compatibility: { pytorch: true, tensorflow: true, sklearn: true },
    ...extra,
  } as never;
}

/**
 * A cuda config that also satisfies HardwareDetector.validateHardwareConfig,
 * which independently requires `specifications.cuda.available` for this type.
 */
function cudaHardware(extra: Record<string, unknown> = {}) {
  return hardware({
    type: "cuda",
    specifications: {
      cpu: { cores: 4, model: "x", architecture: "x86_64" },
      gpu: { model: "A100", memoryMb: 40_960 },
      cuda: { available: true, version: "12.1" },
    },
    ...extra,
  });
}

/**
 * What the "Apple Silicon" preset writes, with the gpu spec
 * HardwareDetector.validateHardwareConfig requires for a `gpu` type.
 */
function appleSiliconHardware(extra: Record<string, unknown> = {}) {
  return hardware({
    type: "gpu",
    architecture: "arm64",
    specifications: {
      cpu: { cores: 10, model: "Apple Silicon", architecture: "arm64" },
      gpu: { model: "Apple GPU", memoryMb: 16_384 },
    },
    ...extra,
  });
}

/** A generic, non-Apple GPU: `gpu` type on an x86_64 CPU. */
function genericGpuHardware() {
  return hardware({
    type: "gpu",
    specifications: {
      cpu: { cores: 4, model: "x", architecture: "x86_64" },
      gpu: { model: "Radeon", memoryMb: 8192 },
    },
  });
}

describe("determineDefaultArchitecture", () => {
  it.each([
    ["pytorch", false, "cpu"],
    ["pytorch", true, "cuda"],
    ["tensorflow", false, "cpu"],
    ["tensorflow", true, "gpu"],
    ["sklearn", false, "cpu"],
    ["sklearn", true, "cpu"],
    ["custom", true, "cpu"],
  ])("%s with gpuRequired=%s resolves to %s", async (fw, gpu, expected) => {
    const arch = await determineDefaultArchitecture(
      project({ framework: fw, gpuRequired: gpu })
    );
    expect(arch).toBe(expected);
  });

  it("defaults to cpu when no framework is declared", async () => {
    expect(await determineDefaultArchitecture(project())).toBe("cpu");
  });
});

describe("determineArchitectureFromHardware", () => {
  it.each([
    ["pytorch", "cuda", "cuda"],
    ["pytorch", "gpu", "cuda"],
    ["pytorch", "cpu", "cpu"],
    ["tensorflow", "cuda", "gpu"],
    ["tensorflow", "gpu", "gpu"],
    ["tensorflow", "cpu", "cpu"],
    ["sklearn", "cuda", "cpu"],
    ["custom", "gpu", "cpu"],
  ])("%s on %s hardware resolves to %s", async (fw, hwType, expected) => {
    const arch = await determineArchitectureFromHardware(
      project({ framework: fw, hardware: hardware({ type: hwType }) })
    );
    expect(arch).toBe(expected);
  });

  it.each([
    ["pytorch", "mps"],
    ["tensorflow", "gpu"],
    ["sklearn", "cpu"],
  ])("%s on Apple Silicon hardware resolves to %s", async (fw, expected) => {
    // Before the mps target, pytorch resolved to cuda here, which
    // validateHardwareCompatibility then rejected.
    const arch = await determineArchitectureFromHardware(
      project({ framework: fw, hardware: appleSiliconHardware() })
    );
    expect(arch).toBe(expected);
  });

  it("falls back to the framework default when no hardware is declared", async () => {
    // pytorch + gpuRequired reaches determineDefaultArchitecture, not the
    // hardware branch, so it resolves to cuda without any hardware block.
    const arch = await determineArchitectureFromHardware(
      project({ framework: "pytorch", gpuRequired: true })
    );
    expect(arch).toBe("cuda");
  });
});

describe("loadIndexFile", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-arch-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("reads a JSON index", async () => {
    const p = path.join(tmp.dir, "index.json");
    fs.writeFileSync(p, JSON.stringify({ model: "resnet", layers: 50 }));
    await expect(loadIndexFile(p)).resolves.toEqual({
      model: "resnet",
      layers: 50,
    });
  });

  it.each(["yaml", "yml"])("reads a .%s index", async (ext) => {
    const p = path.join(tmp.dir, `index.${ext}`);
    fs.writeFileSync(p, "model: resnet\nlayers: 50\n");
    await expect(loadIndexFile(p)).resolves.toEqual({
      model: "resnet",
      layers: 50,
    });
  });

  it("rejects an unsupported extension", async () => {
    const p = path.join(tmp.dir, "index.toml");
    fs.writeFileSync(p, "model = 'resnet'");
    await expect(loadIndexFile(p)).rejects.toThrow(
      /Unsupported index file format: \.toml/
    );
  });

  it("wraps a malformed JSON body", async () => {
    const p = path.join(tmp.dir, "index.json");
    fs.writeFileSync(p, "{not json");
    await expect(loadIndexFile(p)).rejects.toThrow(/Failed to load index file/);
  });

  it("wraps a missing file", async () => {
    await expect(
      loadIndexFile(path.join(tmp.dir, "absent.json"))
    ).rejects.toThrow(/Failed to load index file/);
  });
});

describe("validateHardwareCompatibility", () => {
  it("accepts a cpu build on cpu hardware", async () => {
    await expect(
      validateHardwareCompatibility(hardware(), "cpu", "pytorch")
    ).resolves.toBeUndefined();
  });

  it("accepts a cuda build on cuda hardware", async () => {
    await expect(
      validateHardwareCompatibility(cudaHardware(), "cuda", "pytorch")
    ).resolves.toBeUndefined();
  });

  it("rejects cuda hardware that does not report CUDA as available", async () => {
    // Surfaced by HardwareDetector.validateHardwareConfig, not by the
    // architecture checks below it.
    await expect(
      validateHardwareCompatibility(
        hardware({ type: "cuda" }),
        "cuda",
        "pytorch"
      )
    ).rejects.toThrow(/CUDA type selected but CUDA not available/);
  });

  it("rejects a config missing its architecture field", async () => {
    await expect(
      validateHardwareCompatibility(
        hardware({ architecture: undefined }),
        "cpu",
        "pytorch"
      )
    ).rejects.toThrow(/Architecture is required/);
  });

  it("rejects a cuda build on non-cuda hardware", async () => {
    await expect(
      validateHardwareCompatibility(hardware(), "cuda", "pytorch")
    ).rejects.toThrow(
      /CUDA architecture selected but hardware configuration is not CUDA-capable/
    );
  });

  it("accepts the target pytorch resolves to on Apple Silicon hardware", async () => {
    // End to end over the two functions that used to disagree: resolution
    // must produce something validation accepts.
    const hw = appleSiliconHardware();
    const arch = await determineArchitectureFromHardware(
      project({ framework: "pytorch", hardware: hw })
    );
    await expect(
      validateHardwareCompatibility(hw, arch, "pytorch")
    ).resolves.toBeUndefined();
  });

  it("rejects an mps build on cpu hardware", async () => {
    await expect(
      validateHardwareCompatibility(hardware(), "mps", "pytorch")
    ).rejects.toThrow(/MPS architecture selected but .* not Apple Silicon/);
  });

  it("rejects an mps build on non-arm64 gpu hardware", async () => {
    await expect(
      validateHardwareCompatibility(genericGpuHardware(), "mps", "pytorch")
    ).rejects.toThrow(/not Apple Silicon/);
  });

  it("still rejects a cuda build on Apple Silicon, pointing at --arch", async () => {
    await expect(
      validateHardwareCompatibility(appleSiliconHardware(), "cuda", "pytorch")
    ).rejects.toThrow(/not CUDA-capable \(type "gpu"\); use --arch cpu/);
  });

  it("rejects a gpu build on cpu-only hardware", async () => {
    await expect(
      validateHardwareCompatibility(hardware(), "gpu", "pytorch")
    ).rejects.toThrow(
      /GPU architecture selected but hardware configuration is CPU-only/
    );
  });

  it("rejects a framework the hardware is marked incompatible with", async () => {
    await expect(
      validateHardwareCompatibility(
        hardware({
          compatibility: { pytorch: false, tensorflow: true, sklearn: true },
        }),
        "cpu",
        "pytorch"
      )
    ).rejects.toThrow(/Hardware not compatible with pytorch framework/);
  });

  it("ignores an unknown framework rather than rejecting it", async () => {
    await expect(
      validateHardwareCompatibility(hardware(), "cpu", "jax")
    ).resolves.toBeUndefined();
  });

  it("reports every failure at once", async () => {
    await expect(
      validateHardwareCompatibility(
        hardware({
          compatibility: { pytorch: false, tensorflow: true, sklearn: true },
        }),
        "cuda",
        "pytorch"
      )
    ).rejects.toThrow(/not CUDA-capable[\s\S]*not compatible with pytorch/);
  });

  it("logs compatibility warnings without failing", async () => {
    await expect(
      validateHardwareCompatibility(
        hardware({
          compatibility: {
            pytorch: true,
            tensorflow: true,
            sklearn: true,
            warnings: ["driver is out of date"],
          },
        }),
        "cpu",
        "pytorch"
      )
    ).resolves.toBeUndefined();
  });
});

describe("isAppleSilicon", () => {
  it.each([
    ["gpu", "arm64", true],
    ["gpu", "x86_64", false],
    ["cpu", "arm64", false],
    ["cuda", "arm64", false],
  ])("type %s on %s is %s", (type, architecture, expected) => {
    expect(isAppleSilicon(hardware({ type, architecture }))).toBe(expected);
  });
});

describe("isGpuArchitecture", () => {
  it.each([
    ["cuda", true],
    ["gpu", true],
    ["mps", true],
    ["cpu", false],
    ["transformer", false],
  ])("%s is %s", (arch, expected) => {
    expect(isGpuArchitecture(arch)).toBe(expected);
  });
});

describe("containerArchitecture", () => {
  it.each([
    ["mps", "cpu"],
    ["cuda", "cuda"],
    ["gpu", "gpu"],
    ["cpu", "cpu"],
  ])("%s builds as %s", (arch, expected) => {
    expect(containerArchitecture(arch)).toBe(expected);
  });
});

describe("pytorchDevicePlacement", () => {
  it("places an mps target on MPS, warning when it is unavailable", () => {
    const py = pytorchDevicePlacement("mps");
    expect(py).toContain('elif "mps" == "mps":');
    expect(py).toContain("torch.backends.mps.is_available()");
    expect(py).toContain('model = model.to("mps")');
    expect(py).toContain("Warning: MPS not available, using CPU");
  });

  it("keeps the cuda branch and its CPU fallback warning", () => {
    const py = pytorchDevicePlacement("cuda");
    expect(py).toContain('if "cuda" == "cuda":');
    expect(py).toContain("model = model.cuda()");
    expect(py).toContain("Warning: CUDA not available, using CPU");
  });
});

describe("resolveTargetArchitecture", () => {
  const appleProject = () =>
    project({ framework: "pytorch", hardware: appleSiliconHardware() });

  it("prefers an explicit --arch over everything else", async () => {
    const modelConfig = { inference: { device: "cpu" } } as never;
    expect(
      await resolveTargetArchitecture(appleProject(), modelConfig, "cuda")
    ).toBe("cuda");
  });

  it("prefers the model config's inference.device over the hardware block", async () => {
    // plan used to skip this step, so it planned mps where compile used cpu.
    const modelConfig = { inference: { device: "cpu" } } as never;
    expect(await resolveTargetArchitecture(appleProject(), modelConfig)).toBe(
      "cpu"
    );
  });

  it("falls back to the hardware block", async () => {
    expect(await resolveTargetArchitecture(appleProject(), null)).toBe("mps");
  });
});

describe("validateTargetFramework", () => {
  it("accepts mps for pytorch", () => {
    expect(() => validateTargetFramework("mps", "pytorch")).not.toThrow();
  });

  it.each([
    "tensorflow",
    "sklearn",
    "custom",
    undefined,
  ])("rejects mps for %s, whose scripts have no MPS path", (fw) => {
    expect(() => validateTargetFramework("mps", fw)).toThrow(
      /MPS architecture is only supported for PyTorch/
    );
  });

  it.each(["cpu", "cuda", "gpu"])("leaves %s alone for tensorflow", (arch) => {
    expect(() => validateTargetFramework(arch, "tensorflow")).not.toThrow();
  });
});
