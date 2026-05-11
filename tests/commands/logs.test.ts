import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logsCommand } from "../../src/commands/logs";
import { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("logsCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-logs-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returns early when no project config exists", async () => {
    await logsCommand({});
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/No cirron config|cirron init/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("prompts to authenticate when no token is configured", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await logsCommand({});
    const output = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(output).toMatch(/cirron auth login/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with code 3 when platform unreachable", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
    vi.spyOn(CirronApi.prototype, "getLogs").mockRejectedValue(
      new PlatformUnavailableError("offline")
    );

    await logsCommand({});
    expect(exitSpy).toHaveBeenCalledWith(3);
  });
});
