import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authCommand,
  loginCommand,
  logoutCommand,
  refreshCommand,
} from "../../src/commands/auth";
import { CirronApi } from "../../src/utils/api";
import {
  NotAuthenticatedError,
  PlatformUnavailableError,
} from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
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

  it("authCommand reports 'authenticated' on valid JWT", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      auth: {
        accessToken: "valid-token",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: true,
      user: { email: "user@example.com", name: "Test User" },
      token: {
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        scopes: ["read", "write"],
      },
    } as never);

    await authCommand();

    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Authenticated|user@example\.com/);
  });

  it("logoutCommand is a no-op when not logged in (no exit, no API call)", async () => {
    // Spinner-only output goes to stderr (ora's TTY writer), not console.log,
    // so we verify the behavior instead of the message: no exit, no API call.
    const verifySpy = vi
      .spyOn(CirronApi.prototype, "verifyAuth")
      .mockResolvedValue({} as never);
    await logoutCommand();
    expect(exitSpy).not.toHaveBeenCalled();
    expect(verifySpy).not.toHaveBeenCalled();
  });

  it("logoutCommand clears both legacy token and JWT auth", async () => {
    const cm = new ConfigManager();
    cm.save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "legacy-token",
      auth: {
        accessToken: "jwt-token",
        refreshToken: "refresh",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });

    await logoutCommand();

    const reloaded = cm.load();
    expect(reloaded.token).toBeUndefined();
    expect(reloaded.auth).toBeUndefined();
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

describe("loginCommand (legacy --token)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-login-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("verifies the token, saves it, and prints the user", async () => {
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: true,
      user: { email: "ci@example.com", name: "CI Bot" },
    } as never);

    await loginCommand({ token: "sk-ci-token", url: "https://api.cirron.dev" });

    const cfg = new ConfigManager().load();
    expect(cfg.token).toBe("sk-ci-token");
    expect(cfg.apiUrl).toBe("https://api.cirron.dev");
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/ci@example\.com/);
  });

  it("rejects when the token is invalid", async () => {
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: false,
    } as never);

    await expect(loginCommand({ token: "bad-token" })).rejects.toThrow(
      /Invalid token/
    );
  });

  it("rejects when verifyAuth throws", async () => {
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
      new NotAuthenticatedError("nope")
    );

    await expect(loginCommand({ token: "bad-token" })).rejects.toThrow();
  });
});

describe("refreshCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-refresh-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits 1 when there's no refresh token", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "legacy-only",
    });

    let caught: unknown;
    try {
      await refreshCommand();
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  it("refreshes tokens and persists the new access token", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      auth: {
        accessToken: "old",
        refreshToken: "refresh-me",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    vi.spyOn(CirronApi.prototype, "refreshToken").mockResolvedValue({
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 604_800,
      token_type: "bearer",
    } as never);
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: true,
      user: { email: "u@example.com" },
    } as never);

    await refreshCommand();

    const cfg = new ConfigManager().load();
    expect(cfg.auth?.accessToken).toBe("new-access");
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/u@example\.com/);
  });

  it("exits 1 when refresh fails", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      auth: {
        accessToken: "old",
        refreshToken: "refresh-me",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    });
    vi.spyOn(CirronApi.prototype, "refreshToken").mockRejectedValue(
      new Error("refresh endpoint down")
    );

    let caught: unknown;
    try {
      await refreshCommand();
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });
});
