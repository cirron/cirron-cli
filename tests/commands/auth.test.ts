import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("open", () => ({ default: vi.fn() }));

import open from "open";
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

const openMock = vi.mocked(open);

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

describe("loginCommand (device flow)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  // Originals to restore (these may be undefined on a non-TTY stdin).
  const orig: Record<string, unknown> = {};

  beforeEach(() => {
    tmp = makeTmpDir("cirron-deviceflow-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    openMock.mockReset();
    openMock.mockResolvedValue(undefined as never);
    // Directly stub stdin's TTY-ish methods (spyOn fails when they're absent).
    const stdin = process.stdin as unknown as Record<string, unknown>;
    for (const key of ["setRawMode", "resume", "pause", "once"]) {
      orig[key] = stdin[key];
    }
    stdin.setRawMode = vi.fn();
    stdin.resume = vi.fn();
    stdin.pause = vi.fn();
    stdin.once = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      if (event === "data") {
        setImmediate(() => cb(Buffer.from("\n")));
      }
      return process.stdin;
    });
    // Skip the polling-interval sleeps.
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });

  afterEach(() => {
    const stdin = process.stdin as unknown as Record<string, unknown>;
    for (const key of ["setRawMode", "resume", "pause", "once"]) {
      if (orig[key] === undefined) {
        delete stdin[key];
      } else {
        stdin[key] = orig[key];
      }
    }
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("completes the device flow and persists JWT tokens", async () => {
    vi.spyOn(CirronApi.prototype, "requestDeviceCode").mockResolvedValue({
      deviceCode: "dev-123",
      userCode: "ABCD-1234",
      verificationUrl: "https://cirron.dev/activate",
      expiresIn: 600,
      interval: 1,
    } as never);
    vi.spyOn(CirronApi.prototype, "pollDeviceAuthorization")
      .mockResolvedValueOnce({ status: "pending" } as never)
      .mockResolvedValueOnce({
        status: "authorized",
        accessToken: "access-xyz",
        refreshToken: "refresh-xyz",
        expiresIn: 604_800,
      } as never);
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: true,
      user: { email: "dev@example.com", name: "Dev User" },
    } as never);

    await loginCommand({});

    const cfg = new ConfigManager().load();
    expect(cfg.auth?.accessToken).toBe("access-xyz");
    expect(cfg.auth?.refreshToken).toBe("refresh-xyz");
    expect(openMock).toHaveBeenCalledWith("https://cirron.dev/activate");
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/dev@example\.com/);
  });

  it("rewrites a 'null/...' verification URL using the API base", async () => {
    vi.spyOn(CirronApi.prototype, "requestDeviceCode").mockResolvedValue({
      deviceCode: "dev-1",
      userCode: "AAAA-1111",
      verificationUrl: "null/activate",
      expiresIn: 600,
      interval: 1,
    } as never);
    vi.spyOn(CirronApi.prototype, "pollDeviceAuthorization").mockResolvedValue({
      status: "authorized",
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 604_800,
    } as never);
    vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
      valid: true,
    } as never);

    await loginCommand({ url: "https://platform.cirron.dev/api" });

    // base = "https://platform.cirron.dev" (with /api stripped)
    expect(openMock).toHaveBeenCalledWith(
      "https://platform.cirron.dev/activate"
    );
  });

  it("rejects when the device authorization is denied", async () => {
    vi.spyOn(CirronApi.prototype, "requestDeviceCode").mockResolvedValue({
      deviceCode: "dev-1",
      userCode: "AAAA-1111",
      verificationUrl: "https://cirron.dev/activate",
      expiresIn: 600,
      interval: 1,
    } as never);
    vi.spyOn(CirronApi.prototype, "pollDeviceAuthorization").mockResolvedValue({
      status: "denied",
    } as never);

    await expect(loginCommand({})).rejects.toThrow(/denied/);
  });

  it("rejects when requestDeviceCode fails", async () => {
    vi.spyOn(CirronApi.prototype, "requestDeviceCode").mockRejectedValue(
      new Error("device endpoint down")
    );

    await expect(loginCommand({})).rejects.toThrow(/device endpoint down/);
  });
});
