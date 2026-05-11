import { execSync } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return { ...actual, execSync: vi.fn().mockReturnValue("ok") };
});
const execSyncMock = vi.mocked(execSync);

import { replayCommand } from "../../src/commands/replay";
import { PlanStorage } from "../../src/utils/plan-storage";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Verify replayCommand: validates the saved plan, checks framework/python
 * compatibility, dry-run, compile/build replay execution paths, and the
 * unsupported-command branch.
 */
describe("replayCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  function plan(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      plan: {
        command: "compile",
        framework: "custom",
        pythonVersion: "3.10",
        architecture: "cpu",
        timestamp: new Date().toISOString(),
        artifacts: [{ path: "models/m.pth", estimatedSize: 1024 }],
        buildSteps: ["init", "compile"],
        warnings: [],
        ...overrides,
      },
      metadata: {
        savedAt: new Date().toISOString(),
        description: "test plan",
      },
    };
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-replay-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execSyncMock.mockClear();
    execSyncMock.mockReturnValue("ok" as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits 1 when plan validation fails", async () => {
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue({
      plan: null,
      metadata: null,
    } as never);

    let caught: unknown;
    try {
      await replayCommand({ plan: "/nope.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Missing plan data/);
  });

  it("exits 1 when no project config in current dir", async () => {
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(plan() as never);

    let caught: unknown;
    try {
      await replayCommand({ plan: "/p.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Navigate to a Cirron project/
    );
  });

  it("exits 1 on framework mismatch without --force", async () => {
    writeProjectConfig(tmp.dir, { framework: "tensorflow" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ framework: "pytorch" }) as never
    );

    let caught: unknown;
    try {
      await replayCommand({ plan: "/p.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Framework mismatch/);
  });

  it("exits 1 when required files (model.py / requirements.txt) are missing", async () => {
    writeProjectConfig(tmp.dir);
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(plan() as never);

    let caught: unknown;
    try {
      await replayCommand({ plan: "/p.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Required file missing/
    );
  });

  it("--force downgrades framework mismatch to a warning", async () => {
    writeProjectConfig(tmp.dir, { framework: "tensorflow" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ framework: "pytorch" }) as never
    );

    await replayCommand({ plan: "/p.json", force: true, dryRun: true });

    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/Framework mismatch/);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("dry-run displays the plan and skips execution", async () => {
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(plan() as never);
    const execSpy = execSyncMock;

    await replayCommand({ plan: "/p.json", dryRun: true });

    expect(execSpy).not.toHaveBeenCalled();
    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toMatch(/Replay Plan|Expected Artifacts|Build Steps/);
  });

  it("executes compile replay (writes temp script + execSync)", async () => {
    writeProjectConfig(tmp.dir, { framework: "pytorch" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ command: "compile", framework: "pytorch" }) as never
    );
    const execSpy = execSyncMock;

    await replayCommand({ plan: "/p.json", validate: false });

    expect(execSpy).toHaveBeenCalledWith(
      expect.stringContaining("python3 temp_replay_compile.py"),
      expect.any(Object)
    );
    expect(fs.existsSync(path.join(tmp.dir, "temp_replay_compile.py"))).toBe(
      false
    );
  });

  it("executes build replay", async () => {
    writeProjectConfig(tmp.dir, { framework: "sklearn" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ command: "build", framework: "sklearn" }) as never
    );
    const execSpy = execSyncMock;

    await replayCommand({ plan: "/p.json", validate: false });

    expect(execSpy).toHaveBeenCalledWith(
      expect.stringContaining("python3 temp_replay_build.py"),
      expect.any(Object)
    );
  });

  it("exits 1 for unsupported plan command", async () => {
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ command: "deploy" }) as never
    );

    let caught: unknown;
    try {
      await replayCommand({ plan: "/p.json", validate: false });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Unsupported plan command/
    );
  });

  it("exits 1 on python version mismatch without --force", async () => {
    writeProjectConfig(tmp.dir, { pythonVersion: "3.11" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ pythonVersion: "3.10" }) as never
    );

    let caught: unknown;
    try {
      await replayCommand({ plan: "/p.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Python version mismatch/
    );
  });

  it("dry-run renders warnings section if plan has warnings", async () => {
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ warnings: ["beware of bears"] }) as never
    );

    await replayCommand({ plan: "/p.json", dryRun: true });

    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/beware of bears/);
  });

  it("verbose compile replay logs framework + arch + output", async () => {
    writeProjectConfig(tmp.dir, { framework: "tensorflow" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({
        command: "compile",
        framework: "tensorflow",
        architecture: "gpu",
      }) as never
    );

    await replayCommand({ plan: "/p.json", validate: false, verbose: true });

    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toMatch(/Using architecture: gpu|Target framework/);
  });

  it("verbose build replay logs artifact size for existing artifact", async () => {
    writeProjectConfig(tmp.dir, { framework: "sklearn" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    writeFileAt(tmp.dir, "models/m.pth", "fake bytes");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({ command: "build", framework: "sklearn" }) as never
    );

    await replayCommand({ plan: "/p.json", validate: false, verbose: true });

    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toMatch(/Created: models\/m\.pth/);
  });

  it("warns about missing artifact after compile replay", async () => {
    writeProjectConfig(tmp.dir, { framework: "pytorch" });
    writeFileAt(tmp.dir, "src/model.py", "");
    writeFileAt(tmp.dir, "requirements.txt", "");
    vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(
      plan({
        command: "compile",
        framework: "pytorch",
        artifacts: [{ path: "models/missing.pth", estimatedSize: 100 }],
      }) as never
    );

    await replayCommand({ plan: "/p.json", validate: false });

    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(
      /Expected artifact not found/
    );
  });
});
