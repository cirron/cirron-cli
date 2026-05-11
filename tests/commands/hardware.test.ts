import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hardwareCommand } from "../../src/commands/hardware";
import { HardwareDetector } from "../../src/utils/hardware";
import { makeTmpDir } from "../helpers/tmpdir";

describe("hardwareCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-hw-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    // hardware --detect prompts for save/apply confirmation at the end; auto-decline
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      shouldSave: false,
      shouldApplyToProject: false,
    } as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("--detect prints JSON when --json is set", async () => {
    vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue({
      type: "cpu",
      architecture: "x86_64",
      specifications: {
        cpu: {
          model: "Test CPU",
          cores: 8,
          architecture: "x86_64",
        },
      },
      compatibility: {
        pytorch: true,
        tensorflow: false,
        sklearn: true,
      },
    });

    await hardwareCommand({ detect: true, json: true });
    const output = infoSpy.mock.calls.flat().join("\n");
    expect(() => JSON.parse(output)).not.toThrow();
    expect(output).toContain("cpu");
  });

  it("--detect prints human-readable output by default", async () => {
    vi.spyOn(HardwareDetector, "detectCurrentDevice").mockResolvedValue({
      type: "gpu",
      architecture: "x86_64",
      specifications: {
        cpu: {
          model: "Test CPU",
          cores: 8,
          architecture: "x86_64",
        },
      },
      compatibility: {
        pytorch: true,
        tensorflow: false,
        sklearn: true,
      },
    });

    await hardwareCommand({ detect: true });
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Hardware/i);
  });

  it("exits with code 1 when detection throws", async () => {
    vi.spyOn(HardwareDetector, "detectCurrentDevice").mockRejectedValue(
      new Error("detection failed")
    );

    await hardwareCommand({ detect: true });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
