import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  determineArchitectureFromHardware,
  determineDefaultArchitecture,
  loadIndexFile,
  validateHardwareCompatibility,
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
