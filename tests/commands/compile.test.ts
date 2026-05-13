import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue("Python 3.10.0\n"),
  };
});

import { execSync } from "node:child_process";
import { compileCommand } from "../../src/commands/compile";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn
import * as executionMod from "../../src/utils/execution";
import { ModelConfigManager } from "../../src/utils/model-config";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

const execSyncMock = vi.mocked(execSync);

/**
 * compileCommand shells out via execSync (`python3 …`) and the execution.ts
 * helpers. We mock both so the full ML-compilation flow runs end-to-end:
 * load model config → resolve arch → optional validate → performCompilation →
 * runIntegrityTests → success.
 */
describe("compileCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-compile-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("Python 3.10.0\n");
    vi.spyOn(ModelConfigManager.prototype, "loadModelConfig").mockResolvedValue(
      null
    );
    vi.spyOn(executionMod, "executePythonScript").mockResolvedValue({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    } as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  function mlProject(framework: "pytorch" | "tensorflow" | "sklearn") {
    writeProjectConfig(tmp.dir, { framework });
    writeFileAt(tmp.dir, "src/model.py", "def create_model():\n    return 1\n");
    writeFileAt(tmp.dir, "requirements.txt", "numpy\n");
  }

  it("exits with PROJECT_NOT_FOUND when no config exists", async () => {
    await compileCommand({});
    expect(exitSpy.mock.calls[0]?.[0]).toBe(31);
  });

  it("compiles a pytorch project end-to-end", async () => {
    mlProject("pytorch");
    await compileCommand({ arch: "cpu" });

    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("python3"),
      expect.any(Object)
    );
    expect(executionMod.executePythonScript).toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Compilation Results|compilation completed/i
    );
    expect(exitSpy.mock.calls[0]?.[0]).not.toBe(31);
  });

  it("compiles a tensorflow project", async () => {
    mlProject("tensorflow");
    await compileCommand({ arch: "gpu" });
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Compilation Results/i);
  });

  it("compiles a sklearn project", async () => {
    mlProject("sklearn");
    await compileCommand({ arch: "cpu" });
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Compilation Results/i);
  });

  it("runs validation checks when --validate is set", async () => {
    mlProject("pytorch");
    await compileCommand({ arch: "cpu", validate: true });
    // executePythonScript is used by validation checks too
    expect(executionMod.executePythonScript).toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Validation checks/i);
  });

  it("exits 1 when --index file is missing", async () => {
    mlProject("pytorch");
    await compileCommand({ arch: "cpu", index: "nope.json" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("loads an --index file when present", async () => {
    mlProject("pytorch");
    writeFileAt(tmp.dir, "manifest.json", '{"layers":[]}');
    await compileCommand({ arch: "cpu", index: "manifest.json" });
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Using index file/);
  });

  it("exits when the compilation python step throws", async () => {
    mlProject("pytorch");
    execSyncMock.mockImplementation(() => {
      throw new Error("compile crashed");
    });
    await compileCommand({ arch: "cpu" });
    // catch path calls process.exit
    expect(exitSpy).toHaveBeenCalled();
  });

  it("validates hardware compatibility when hardware config is present", async () => {
    writeProjectConfig(tmp.dir, {
      framework: "pytorch",
      // hardware key forces the validateHardwareCompatibility branch
    });
    // append a hardware block via raw json
    const fs = await import("fs-extra");
    const path = await import("node:path");
    const cfgPath = path.join(tmp.dir, "cirron.json");
    const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
    cfg.hardware = {
      type: "cpu",
      architecture: "x86_64",
      specifications: {},
      compatibility: {},
    };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    writeFileAt(tmp.dir, "src/model.py", "def create_model():\n    return 1\n");
    writeFileAt(tmp.dir, "requirements.txt", "numpy\n");

    await compileCommand({ arch: "cpu" });
    // Should complete one way or another without PROJECT_NOT_FOUND
    expect(exitSpy.mock.calls[0]?.[0]).not.toBe(31);
  });
});
