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
import { testCommand } from "../../src/commands/test";
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn
import * as executionMod from "../../src/utils/execution";
import { ModelConfigManager } from "../../src/utils/model-config";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

const execSyncMock = vi.mocked(execSync);

/**
 * testCommand runs a suite of ML tests, each shelling out via execSync or the
 * execution.ts helpers. We mock both, lay down the files each test runner
 * expects, and assert the suite runs to a green result.
 */
describe("testCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  /** Lay down every file the env/requirements/unit/lint/model/data runners need. */
  function fullProject(framework = "pytorch") {
    writeProjectConfig(tmp.dir, { framework });
    writeFileAt(tmp.dir, "requirements.txt", "numpy\n");
    writeFileAt(tmp.dir, "src/model.py", "def create_model():\n    return 1\n");
    writeFileAt(tmp.dir, "src/data_loader.py", "def load():\n    return []\n");
    writeFileAt(tmp.dir, "tests/test_x.py", "def test_x():\n    assert True\n");
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-test-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("Python 3.10.0\n");
    vi.spyOn(ModelConfigManager.prototype, "loadModelConfig").mockResolvedValue(
      null
    );
    vi.spyOn(executionMod, "executePythonFile").mockResolvedValue({
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
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits 1 when no cirron config exists", async () => {
    let caught: unknown;
    try {
      await testCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/cirron init/);
  });

  it("runs the default suite green for a fully-populated project", async () => {
    fullProject("pytorch");
    await testCommand({});
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Test Results|test suites passed/i
    );
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("runs the env test (parses python version)", async () => {
    fullProject("pytorch");
    await testCommand({ env: true });
    expect(execSyncMock).toHaveBeenCalledWith(
      "python3 --version",
      expect.any(Object)
    );
  });

  it("runs the requirements test", async () => {
    fullProject("pytorch");
    await testCommand({ requirements: true });
    // pip check / dry-run go through execSync
    expect(execSyncMock).toHaveBeenCalled();
  });

  it("runs the unit test (pytest)", async () => {
    fullProject("custom");
    await testCommand({ unit: true });
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("pytest"),
      expect.any(Object)
    );
  });

  it("runs the lint test", async () => {
    fullProject("custom");
    await testCommand({ lint: true });
    expect(executionMod.executeScript).toHaveBeenCalled();
  });

  it("runs the model test (sklearn)", async () => {
    fullProject("sklearn");
    await testCommand({ model: true });
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("python3"),
      expect.any(Object)
    );
  });

  it("runs the data test", async () => {
    fullProject("pytorch");
    await testCommand({ data: true });
    expect(executionMod.executePythonFile).toHaveBeenCalled();
  });

  it("exits 1 when a test runner fails (missing file)", async () => {
    // No project files at all besides config → model/unit/etc. all fail.
    writeProjectConfig(tmp.dir, { framework: "pytorch" });
    let caught: unknown;
    try {
      await testCommand({ model: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Model file not found|test suites failed/i
    );
  });

  it("exits 1 when the python version is too old", async () => {
    fullProject("pytorch");
    execSyncMock.mockReturnValue("Python 3.7.0\n");
    let caught: unknown;
    try {
      await testCommand({ env: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  it("--build test fails without a Dockerfile", async () => {
    fullProject("pytorch");
    let caught: unknown;
    try {
      await testCommand({ build: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Dockerfile not found|test suites failed/i
    );
  });

  it("--build test passes with a Dockerfile present", async () => {
    fullProject("pytorch");
    writeFileAt(tmp.dir, "Dockerfile", "FROM python:3.10\n");
    await testCommand({ build: true });
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("docker build"),
      expect.any(Object)
    );
  });

  it("--inference runs the inference test (src/inference.py present)", async () => {
    fullProject("sklearn");
    writeFileAt(
      tmp.dir,
      "src/inference.py",
      "class ModelInference:\n    pass\n"
    );
    await testCommand({ inference: true });
    expect(executionMod.executePythonFile).toHaveBeenCalled();
  });

  it("--inference fails without src/inference.py", async () => {
    writeProjectConfig(tmp.dir, { framework: "sklearn" });
    let caught: unknown;
    try {
      await testCommand({ inference: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Inference file not found|test suites failed/i
    );
  });

  it("--val runs the validation test (model.py + inference.py)", async () => {
    fullProject("sklearn");
    writeFileAt(
      tmp.dir,
      "src/inference.py",
      "class ModelInference:\n    pass\n"
    );
    writeFileAt(tmp.dir, "data/sample/sample_data.csv", "a,b\n1,2\n");
    await testCommand({ val: true });
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("python3"),
      expect.any(Object)
    );
  });

  it("--endpoint rejects an invalid URL", async () => {
    fullProject("pytorch");
    let caught: unknown;
    try {
      await testCommand({ endpoint: "not a url" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Invalid endpoint URL|test suites failed/i
    );
  });

  it("--endpoint runs against a valid URL", async () => {
    fullProject("pytorch");
    await testCommand({ endpoint: "https://api.example.com/predict" });
    // endpoint test writes a temp script and execSyncs it
    expect(execSyncMock).toHaveBeenCalledWith(
      expect.stringContaining("python3"),
      expect.any(Object)
    );
  });

  it("--pipeline runs the end-to-end pipeline", async () => {
    fullProject("sklearn");
    writeFileAt(
      tmp.dir,
      "src/inference.py",
      "class ModelInference:\n    pass\n"
    );
    await testCommand({ pipeline: true });
    // pipeline runs env (execSync python --version) + the others
    expect(execSyncMock).toHaveBeenCalled();
  });

  it("CUDA-required pytorch project runs the GPU framework probe", async () => {
    writeProjectConfig(tmp.dir, { framework: "pytorch" });
    const fs2 = require("fs-extra");
    const path2 = require("node:path");
    const cfgPath = path2.join(tmp.dir, "cirron.json");
    const cfg = JSON.parse(fs2.readFileSync(cfgPath, "utf-8"));
    cfg.gpuRequired = true;
    fs2.writeFileSync(cfgPath, JSON.stringify(cfg));
    writeFileAt(tmp.dir, "requirements.txt", "torch\n");

    await testCommand({ env: true });
    // the GPU probe writes a temp file and runs it via executePythonFile
    expect(executionMod.executePythonFile).toHaveBeenCalled();
  });
});
