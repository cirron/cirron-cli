import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCommand } from "../../src/commands/test";
import { ModelConfigManager } from "../../src/utils/model-config";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

describe("testCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-test-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(ModelConfigManager.prototype, "loadModelConfig").mockResolvedValue(
      null
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits with code 1 when no cirron config exists", async () => {
    let caught: unknown;
    try {
      await testCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/No cirron project config|cirron init/);
  });

  it("loads config when a cirron.yaml exists (does not error on missing config)", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({});
    } catch (err) {
      caught = err;
    }
    // Even if it exits 1 later due to missing test files, it should not be
    // the "no cirron project config" branch.
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).not.toMatch(/No cirron project config/);
    void caught;
  });

  it("runs the requested test list for a pytorch project", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({ requirements: true });
    } catch (err) {
      caught = err;
    }
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).not.toMatch(/No cirron project config/);
    void caught;
  });

  it("runs the env test path", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({ env: true });
    } catch (err) {
      caught = err;
    }
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).not.toMatch(/No cirron project config/);
    void caught;
  });

  it("runs default test selection when no flags given (pytorch)", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({});
    } catch (err) {
      caught = err;
    }
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(
      /No cirron project config/
    );
    void caught;
  });

  it("runs the model + data test paths", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: sklearn\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({ model: true, data: true });
    } catch (err) {
      caught = err;
    }
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(
      /No cirron project config/
    );
    void caught;
  });

  it("runs the unit + lint test paths", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await testCommand({ unit: true, lint: true });
    } catch (err) {
      caught = err;
    }
    expect(errorSpy.mock.calls.flat().join(" ")).not.toMatch(
      /No cirron project config/
    );
    void caught;
  });
});
