import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deployCommand } from "../../src/commands/deploy";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

describe("deployCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-deploy-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Always auto-confirm the deploy prompt
    vi.spyOn(inquirer, "prompt").mockResolvedValue({ confirm: true } as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits with code 1 when no project config exists", async () => {
    let caught: unknown;
    try {
      await deployCommand({ env: "production" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/No cirron config|cirron init/);
  });

  it("exits with code 1 when not authenticated", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    let caught: unknown;
    try {
      await deployCommand({ env: "production" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Not authenticated|cirron auth login/);
  });
});
