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
import { InteractiveManager } from "../../src/utils/interactive";
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
    /** A custom project with a build config that has a command + hooks. */
    function customProject(extra: Record<string, unknown> = {}) {
      writeProjectConfig(tmp.dir, {
        framework: "custom",
        build: {
          outputDir: "dist",
          // these extra build-config keys aren't in the helper's typed surface,
          // so write them via raw json afterwards
        },
      });
      const fs2 = require("fs-extra");
      const path2 = require("node:path");
      const cfgPath = path2.join(tmp.dir, "cirron.json");
      const cfg = JSON.parse(fs2.readFileSync(cfgPath, "utf-8"));
      cfg.build = {
        outputDir: "dist",
        command: "echo build",
        beforeBuild: ["echo before"],
        afterBuild: ["echo after"],
        ...extra,
      };
      cfg.environments = { production: { variables: { FOO: "bar" } } };
      fs2.writeFileSync(cfgPath, JSON.stringify(cfg));
    }

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

    it("runs build command + pre/post hooks + reports success", async () => {
      customProject();
      await buildCommand({ env: "production", clean: true });

      // beforeBuild + afterBuild go through execSync
      expect(execSyncMock).toHaveBeenCalledWith(
        "echo before",
        expect.any(Object)
      );
      expect(execSyncMock).toHaveBeenCalledWith(
        "echo after",
        expect.any(Object)
      );
      // runBuild spawns the command
      expect(spawnMock).toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Build completed successfully|Environment:/
      );
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("--analyze runs the bundle analysis", async () => {
      customProject();
      // Make sure the output dir exists so analyzeBuild does real work.
      const fs2 = require("fs-extra");
      const path2 = require("node:path");
      fs2.ensureDirSync(path2.join(tmp.dir, "dist"));
      fs2.writeFileSync(
        path2.join(tmp.dir, "dist", "bundle.js"),
        "x".repeat(100)
      );

      await buildCommand({ env: "production", analyze: true });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Build Analysis/);
    });

    it("exits when the build command fails", async () => {
      customProject();
      spawnMock.mockImplementation(() => fakeChild(1));
      await buildCommand({ env: "production" });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("--force swallows a failing pre-build hook", async () => {
      customProject();
      execSyncMock.mockImplementation((cmd: string) => {
        if (cmd === "echo before") {
          throw new Error("hook failed");
        }
        return "ok";
      });
      await buildCommand({ env: "production", force: true });
      // build still proceeds (warning, not exit)
      expect(spawnMock).toHaveBeenCalled();
    });

    it("non-production env suggests `cirron deploy`", async () => {
      customProject();
      const fs2 = require("fs-extra");
      const path2 = require("node:path");
      const cfgPath = path2.join(tmp.dir, "cirron.json");
      const cfg = JSON.parse(fs2.readFileSync(cfgPath, "utf-8"));
      cfg.environments = { staging: { variables: {} } };
      fs2.writeFileSync(cfgPath, JSON.stringify(cfg));

      await buildCommand({ env: "staging" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/cirron deploy/);
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

    it("builds a tensorflow project (script-gen branch)", async () => {
      writeProjectConfig(tmp.dir, { framework: "tensorflow" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "tensorflow\n");
      await buildCommand({ env: "production", arch: "gpu" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Build Results/i);
    });

    it("builds an sklearn project (script-gen branch)", async () => {
      writeProjectConfig(tmp.dir, { framework: "sklearn" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "scikit-learn\n");
      await buildCommand({ env: "production", arch: "cpu" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Build Results/i);
    });

    it("validates hardware compatibility when a hardware config is present", async () => {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "torch\n");
      const fs2 = require("fs-extra");
      const path2 = require("node:path");
      const cfgPath = path2.join(tmp.dir, "cirron.json");
      const cfg = JSON.parse(fs2.readFileSync(cfgPath, "utf-8"));
      cfg.hardware = {
        type: "cpu",
        architecture: "x86_64",
        specifications: {
          cpu: { cores: 4, model: "x", architecture: "x86_64" },
        },
        compatibility: { pytorch: true, tensorflow: true, sklearn: true },
      };
      fs2.writeFileSync(cfgPath, JSON.stringify(cfg));

      await buildCommand({ env: "production", arch: "cpu" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Hardware compatibility validated|Build Results/i
      );
    });

    /** A pytorch project whose declared hardware can't satisfy a cuda build. */
    function incompatibleHardwareProject() {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "torch\n");
      const fs2 = require("fs-extra");
      const path2 = require("node:path");
      const cfgPath = path2.join(tmp.dir, "cirron.json");
      const cfg = JSON.parse(fs2.readFileSync(cfgPath, "utf-8"));
      cfg.hardware = {
        type: "cpu",
        architecture: "x86_64",
        specifications: {
          cpu: { cores: 4, model: "x", architecture: "x86_64" },
        },
        compatibility: { pytorch: true, tensorflow: true, sklearn: true },
      };
      fs2.writeFileSync(cfgPath, JSON.stringify(cfg));
    }

    it("fails the build when hardware validation fails without --force", async () => {
      incompatibleHardwareProject();
      await buildCommand({ env: "production", arch: "cuda" });

      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("--force runs hardware validation and warns instead of failing", async () => {
      incompatibleHardwareProject();
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      await buildCommand({ env: "production", arch: "cuda", force: true });

      // --force used to skip validation entirely, leaving the warn branch dead.
      expect(warnSpy.mock.calls.flat().join(" ")).toContain(
        "continuing with --force"
      );
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("--analyze on an ML build", async () => {
      pytorchProject();
      await buildCommand({ env: "production", arch: "cpu", analyze: true });
      expect(exitSpy).not.toHaveBeenCalledWith(1);
    });

    it("uses model config architecture when --arch is not given", async () => {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      writeFileAt(
        tmp.dir,
        "src/model.py",
        "def create_model():\n    return 1\n"
      );
      writeFileAt(tmp.dir, "requirements.txt", "torch\n");
      vi.spyOn(
        ModelConfigManager.prototype,
        "loadModelConfig"
      ).mockResolvedValue({
        name: "m",
        framework: "pytorch",
        inference: { device: "cuda" },
      } as never);

      await buildCommand({ env: "production" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Target architecture: cuda|Build Results/i
      );
    });

    it("builds with the interactively selected architecture, not the detected one", async () => {
      pytorchProject();
      vi.spyOn(
        ModelConfigManager.prototype,
        "loadModelConfig"
      ).mockResolvedValue({
        name: "m",
        framework: "pytorch",
        inference: { device: "cuda" },
      } as never);
      vi.spyOn(InteractiveManager.prototype, "isInteractive").mockReturnValue(
        true
      );
      vi.spyOn(InteractiveManager.prototype, "confirmStep").mockResolvedValue(
        true
      );
      vi.spyOn(InteractiveManager.prototype, "selectOption").mockResolvedValue(
        "gpu"
      );

      await buildCommand({ env: "production", interactive: true });

      // The bug: `architecture` was const, so the selection was logged and
      // then discarded. Assert on the value the build actually used.
      const logged = infoSpy.mock.calls.flat().join(" ");
      expect(logged).toContain("Architecture changed from cuda to gpu");
      expect(logged).toContain("Target architecture: gpu");
      expect(logged).not.toContain("Target architecture: cuda");
    });
  });
});
