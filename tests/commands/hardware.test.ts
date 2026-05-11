import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hardwareCommand } from "../../src/commands/hardware";
import { HardwareDetector } from "../../src/utils/hardware";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * hardwareCommand routes to detect / configure / list / interactive.
 * We stub HardwareDetector's static methods and inquirer to drive each path.
 */
describe("hardwareCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  function sampleConfig(overrides: Record<string, unknown> = {}) {
    return {
      type: "cpu",
      architecture: "x86_64",
      specifications: {
        cpu: { cores: 8, model: "Test CPU", architecture: "x86_64" },
        memory: { total: "16 GB", available: "8 GB" },
      },
      compatibility: { pytorch: true, tensorflow: true, sklearn: true },
      isCurrentDevice: true,
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-hw-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("--detect", () => {
    it("--json prints raw config", async () => {
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig()
      );
      await hardwareCommand({ detect: true, json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"architecture"')
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "{}").type).toBe("cpu");
    });

    it("text mode renders CPU/memory/compat sections + prompts to save", async () => {
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig({
          specifications: {
            cpu: { cores: 8, model: "Test CPU", architecture: "x86_64" },
            memory: { total: "16 GB", available: "8 GB" },
            gpu: { model: "Test GPU", memory: "8 GB", drivers: "NVIDIA" },
            cuda: {
              available: true,
              version: "11.8",
              devices: [{ name: "GPU0", memory: "8 GB" }],
            },
          },
          compatibility: {
            pytorch: true,
            tensorflow: false,
            sklearn: true,
            requirements: ["install cuda toolkit"],
            warnings: ["old driver"],
          },
        })
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        shouldSave: false,
      } as never);

      await hardwareCommand({ detect: true });

      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/CPU:|Memory:|GPU:|CUDA:|Framework Compatibility/);
    });

    it("--save writes hardware.json", async () => {
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig()
      );
      vi.spyOn(HardwareDetector, "saveHardwareConfig").mockResolvedValue(
        path.join(tmp.dir, "hardware.json")
      );

      await hardwareCommand({ detect: true, save: "hardware.json" });

      expect(HardwareDetector.saveHardwareConfig).toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Hardware profile saved/
      );
    });

    it("applies config to project when in a project dir and user confirms", async () => {
      writeProjectConfig(tmp.dir);
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig({ type: "cuda" })
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        shouldSave: false,
        shouldApplyToProject: true,
      } as never);

      await hardwareCommand({ detect: true });

      const cfg = JSON.parse(
        fs.readFileSync(path.join(tmp.dir, "cirron.json"), "utf-8")
      );
      expect(cfg.hardware).toBeTruthy();
      expect(cfg.gpuRequired).toBe(true);
    });

    it("exits 1 when detection throws", async () => {
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockRejectedValue(
        new Error("no /proc")
      );

      let caught: unknown;
      try {
        await hardwareCommand({ detect: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });

  describe("--list", () => {
    it("text mode lists preset profiles", async () => {
      await hardwareCommand({ list: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Available Hardware Profiles|CPU Only|NVIDIA GPU/
      );
    });

    it("--json dumps profiles", async () => {
      await hardwareCommand({ list: true, json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.trim().startsWith("[")
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "[]").length).toBeGreaterThan(0);
    });
  });

  describe("--configure", () => {
    it("--from loads a config file and applies it", async () => {
      writeProjectConfig(tmp.dir);
      vi.spyOn(HardwareDetector, "loadHardwareConfig").mockResolvedValue(
        sampleConfig()
      );
      vi.spyOn(HardwareDetector, "validateHardwareConfig").mockReturnValue({
        valid: true,
        errors: [],
      });
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        shouldApplyToProject: true,
      } as never);

      await hardwareCommand({ configure: true, from: "hardware.json" });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Hardware configuration loaded|applied to project/
      );
    });

    it("--from missing file exits 1", async () => {
      vi.spyOn(HardwareDetector, "loadHardwareConfig").mockResolvedValue(null);

      let caught: unknown;
      try {
        await hardwareCommand({ configure: true, from: "nope.json" });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });

    it("preset selection path", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ configType: "preset" } as never)
        .mockResolvedValueOnce({
          selectedProfile: sampleConfig(),
        } as never)
        .mockResolvedValueOnce({ shouldSaveToFile: false } as never);
      vi.spyOn(HardwareDetector, "validateHardwareConfig").mockReturnValue({
        valid: true,
        errors: [],
      });

      await hardwareCommand({ configure: true });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Hardware Configuration Summary|Hardware Configuration Setup/
      );
    });

    it("current-device path with save-to-file", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ configType: "current" } as never)
        .mockResolvedValueOnce({ shouldSaveToFile: true } as never);
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig()
      );
      vi.spyOn(HardwareDetector, "validateHardwareConfig").mockReturnValue({
        valid: true,
        errors: [],
      });
      vi.spyOn(HardwareDetector, "saveHardwareConfig").mockResolvedValue(
        path.join(tmp.dir, "hardware.json")
      );

      await hardwareCommand({ configure: true });

      expect(HardwareDetector.saveHardwareConfig).toHaveBeenCalled();
    });

    it("validation failure exits 1", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValueOnce({
        configType: "current",
      } as never);
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig()
      );
      vi.spyOn(HardwareDetector, "validateHardwareConfig").mockReturnValue({
        valid: false,
        errors: ["bad type"],
      });

      let caught: unknown;
      try {
        await hardwareCommand({ configure: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });

  describe("interactive (no flags)", () => {
    it("'detect' action routes to detect", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "detect" } as never)
        .mockResolvedValueOnce({ shouldSave: false } as never);
      vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue(
        sampleConfig()
      );

      await hardwareCommand({});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Current Device Hardware Configuration/
      );
    });

    it("'list' action routes to list", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValueOnce({
        action: "list",
      } as never);

      await hardwareCommand({});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Available Hardware Profiles/
      );
    });

    it("'load' action reads an existing config", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValueOnce({
        action: "load",
      } as never);
      vi.spyOn(HardwareDetector, "loadHardwareConfig").mockResolvedValue(
        sampleConfig()
      );

      await hardwareCommand({});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Hardware configuration loaded|Hardware Configuration Summary/
      );
    });

    it("'load' action warns when no config file exists", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValueOnce({
        action: "load",
      } as never);
      vi.spyOn(HardwareDetector, "loadHardwareConfig").mockResolvedValue(null);

      await hardwareCommand({});

      // logged via logger.warn / logger.info
      const all = infoSpy.mock.calls.flat().join(" ");
      expect(all).toMatch(/config hardware --configure|No hardware config/i);
    });
  });
});
