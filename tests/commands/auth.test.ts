import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authCommand } from "../../src/commands/auth";
import { CirronApi } from "../../src/utils/api";
import {
  NotAuthenticatedError,
  PlatformUnavailableError,
} from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Verifies the graceful-error layer for the auth command:
 *  - PlatformUnavailableError → exit code 3, "private preview" message
 *  - NotAuthenticatedError    → exit code 2, "Run 'cirron auth login'" message
 *
 * authCommand inspects the local config first; we redirect HOME to a tmp dir
 * so each test gets a clean config state.
 */
describe("authCommand graceful error handling", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-auth-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("reports 'not authenticated' (no exit) when no token is configured", async () => {
    await authCommand();
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Not authenticated/i);
    // No platform call attempted → no exit
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits with code 3 and waitlist CTA when platform is unreachable", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });

    vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
      new PlatformUnavailableError("ECONNREFUSED")
    );

    await authCommand();

    expect(exitSpy).toHaveBeenCalledWith(3);
    const stderr = errorSpy.mock.calls.flat().join(" ");
    expect(stderr).toMatch(/private preview/i);
    expect(stderr).toMatch(/cirron\.com\/waitlist/);
  });

  it("exits with code 2 when credentials are rejected (401/403)", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "stale-token",
    });

    vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
      new NotAuthenticatedError("token expired")
    );

    await authCommand();

    expect(exitSpy).toHaveBeenCalledWith(2);
    const stderr = errorSpy.mock.calls.flat().join(" ");
    expect(stderr).toMatch(/cirron auth login/);
  });

  it("does not leak stack traces for PlatformError types", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "x",
    });

    vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
      new PlatformUnavailableError("offline", {
        cause: new Error("inner stack should not leak"),
      })
    );

    await authCommand();
    const stderr = errorSpy.mock.calls.flat().join(" ");
    expect(stderr).not.toContain("inner stack should not leak");
    expect(stderr).not.toMatch(/at .+\(.+:\d+:\d+\)/); // no "at file:line:col" frames
  });
});
