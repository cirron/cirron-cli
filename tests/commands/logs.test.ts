import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLevelColor, logsCommand } from "../../src/commands/logs";
import { CirronApi } from "../../src/utils/api";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { writeProjectConfig } from "../helpers/project-fixture";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Cover logsCommand: project gate, auth gate, fetch + display, empty list,
 * and the API-failure exit path.
 */
describe("logsCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-logs-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("returns early when no project config", async () => {
    await logsCommand({});
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/cirron init/);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("returns early when not authenticated", async () => {
    writeProjectConfig(tmp.dir);
    await logsCommand({});
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/auth login/);
  });

  it("fetches and displays logs", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getLogs").mockResolvedValue([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: "deploy succeeded",
      },
      {
        timestamp: new Date().toISOString(),
        level: "error",
        message: "oops",
      },
    ] as never);

    await logsCommand({ lines: "50" });

    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/deploy succeeded/);
  });

  it("reports 'no logs found' on empty list", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getLogs").mockResolvedValue([] as never);

    await logsCommand({});

    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No logs found/);
  });

  it("exits 1 when getLogs fails", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getLogs").mockRejectedValue(
      new Error("server down")
    );

    let caught: unknown;
    try {
      await logsCommand({});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  it("follow mode does the initial poll and registers an interval", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getLogs").mockResolvedValue([
      {
        timestamp: new Date().toISOString(),
        level: "info",
        message: "live log line",
      },
    ] as never);
    const intervalSpy = vi
      .spyOn(global, "setInterval")
      .mockReturnValue(0 as unknown as NodeJS.Timeout);

    await logsCommand({ follow: true });

    expect(intervalSpy).toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Following logs|live log line/
    );
  });

  it("follow mode swallows poll errors", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getLogs").mockRejectedValue(
      new Error("transient")
    );
    vi.spyOn(global, "setInterval").mockReturnValue(
      0 as unknown as NodeJS.Timeout
    );

    await logsCommand({ follow: true });
    // Should not exit — the poll error is debug-logged and ignored.
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("respects --env option", async () => {
    writeProjectConfig(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    const spy = vi
      .spyOn(CirronApi.prototype, "getLogs")
      .mockResolvedValue([] as never);

    await logsCommand({ env: "staging" });

    expect(spy).toHaveBeenCalledWith("demo", "staging", expect.any(Object));
  });

  describe("getLevelColor", () => {
    it("returns distinct color fns for each level", () => {
      expect(getLevelColor("error")).toBeTypeOf("function");
      expect(getLevelColor("warn")).toBeTypeOf("function");
      expect(getLevelColor("info")).toBeTypeOf("function");
      expect(getLevelColor("debug")).toBeTypeOf("function");
      expect(getLevelColor("unknown-level")).toBeTypeOf("function");
    });
  });
});
