import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue("Python 3.10.0\n"),
    spawn: vi.fn(),
  };
});

import { execSync, spawn } from "node:child_process";
import { buildCommand } from "../../src/commands/build";
import { CirronApi } from "../../src/utils/api";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn
import * as executionMod from "../../src/utils/execution";
import { ModelConfigManager } from "../../src/utils/model-config";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

const execSyncMock = vi.mocked(execSync);
const spawnMock = vi.mocked(spawn);

/** Build a fake child process that immediately closes with the given code. */
function fakeChild(code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from("Step 1/3 : FROM python\n"));
    child.emit("close", code);
  });
  return child as never;
}

describe("buildCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-build-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("Python 3.10.0\n");
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild(0));
    vi.spyOn(ModelConfigManager.prototype, "loadModelConfig").mockResolvedValue(
      null
    );
    vi.spyOn(executionMod, "executePythonScript").mockResolvedValue({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    } as never);
    vi.spyOn(executionMod, "executeScript").mockResolvedValue({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    } as never);
    // reportBuildStatus is a no-op without a token; if a token IS present
    // (shouldn't be in tmp HOME), this keeps it from making a real request.
    vi.spyOn(CirronApi.prototype, "reportBuild").mockResolvedValue(
      undefined as never
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits 1 when no cirron config exists in cwd", async () => {
    await buildCommand({ env: "production" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe("traditional (non-ML) build", () => {
    it("exits 1 when there is no build config", async () => {
      writeProjectConfig(tmp.dir, { framework: "custom" });
      await buildCommand({ env: "production" });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Add build configuration/
      );
    });

    it("--force skips the missing-build-config gate", async () => {
      writeProjectConfig(tmp.dir, { framework: "custom" });
      await buildCommand({ env: "production", force: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/--force/);
    });

    it("runs a build when a build config is present", async () => {
      writeProjectConfig(tmp.dir, {
        framework: "custom",
        build: { outputDir: "dist" },
      });
      // Even if a later step exits, the command should not throw uncaught.
      await expect(
        buildCommand({ env: "production", clean: true })
      ).resolves.toBeUndefined();
    });
  });

  describe("ML build", () => {
    function pytorchProject() {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "torch\n");
    }

    it("compiles, runs integrity tests, and reports success (no Dockerfile)", async () => {
      pytorchProject();
      await buildCommand({ env: "production", arch: "cpu" });

      expect(execSyncMock).toHaveBeenCalled();
      expect(executionMod.executePythonScript).toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Build Results|model build completed/i
      );
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("builds a Docker image when a Dockerfile is present", async () => {
      pytorchProject();
      writeFileAt(tmp.dir, "Dockerfile", "FROM python:3.10\n");

      await buildCommand({ env: "production", arch: "cpu" });

      expect(spawnMock).toHaveBeenCalledWith(
        "docker",
        expect.arrayContaining(["build"]),
        expect.any(Object)
      );
    });

    it("pushes the image when --push is set", async () => {
      pytorchProject();
      writeFileAt(tmp.dir, "Dockerfile", "FROM python:3.10\n");

      await buildCommand({ env: "production", arch: "cpu", push: true });

      const pushCall = spawnMock.mock.calls.find(
        (c) => c[1] && (c[1] as string[]).includes("push")
      );
      expect(pushCall).toBeTruthy();
    });

    it("--force swallows a failing Docker build", async () => {
      pytorchProject();
      writeFileAt(tmp.dir, "Dockerfile", "FROM python:3.10\n");
      spawnMock.mockImplementation(() => fakeChild(1));

      await buildCommand({ env: "production", arch: "cpu", force: true });

      // --force converts the docker failure into a warning, not an exit.
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("exits 1 when --index file is missing (without --force)", async () => {
      pytorchProject();
      await buildCommand({
        env: "production",
        arch: "cpu",
        index: "nope.json",
      });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("--validate runs validation checks", async () => {
      pytorchProject();
      await buildCommand({ env: "production", arch: "cpu", validate: true });
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("exits 1 when the ML build python step throws", async () => {
      pytorchProject();
      execSyncMock.mockImplementation(() => {
        throw new Error("python build crashed");
      });
      await buildCommand({ env: "production", arch: "cpu" });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/crashed/);
    });
  });
});
