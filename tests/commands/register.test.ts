import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCommand } from "../../src/commands/register";
import { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * registerCommand expects process.exit to actually terminate execution
 * (it destructures `projectConfigResult` AFTER calling exit on missing
 * config). Tests use the throwing stub so we can assert on the exit code
 * and stop execution at the exit point.
 */
describe("registerCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-register-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits with 1 when not authenticated", async () => {
    let caught: unknown;
    try {
      await registerCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Not authenticated/);
  });

  it("exits with 1 when no project config exists", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
    let caught: unknown;
    try {
      await registerCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/No cirron config/);
  });

  it("--dry-run prints payload without calling the API", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
    const apiSpy = vi
      .spyOn(CirronApi.prototype, "createProject")
      .mockResolvedValue({} as never);

    await registerCommand({ dryRun: true });

    expect(apiSpy).not.toHaveBeenCalled();
    const output = infoSpy.mock.calls.flat().join("\n");
    expect(output).toContain("demo");
    expect(output).toContain("pytorch");
  });

  it("exits with code 3 (waitlist message) when platform is unreachable", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
    vi.spyOn(CirronApi.prototype, "createProject").mockRejectedValue(
      new PlatformUnavailableError("offline")
    );

    let caught: unknown;
    try {
      await registerCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(3);
  });

  it("uses --name flag to override config name", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: original\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });

    await registerCommand({ name: "overridden", dryRun: true });
    const output = infoSpy.mock.calls.flat().join("\n");
    expect(output).toContain("overridden");
  });
});
