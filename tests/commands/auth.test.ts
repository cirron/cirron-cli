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
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

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

/**
 * Device-flow login, driven through the real transport against the shapes the
 * platform actually sends.
 *
 * These used to stub `pollDeviceAuthorization` wholesale and resolve
 * `{ status: "pending" }`, a body the server has never sent. The suite stayed
 * green while the real flow died after roughly 35 seconds, so the mock is gone
 * and the global fetch is the seam instead.
 */
describe("loginCommand (device flow)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  // Originals to restore (these may be undefined on a non-TTY stdin).
  const orig: Record<string, unknown> = {};

  /** Scripted poll responses, consumed in order; the last one repeats. */
  let pollQueue: FakeResponse[];
  let pollCount: number;
  /** When set, every poll rejects with this instead of answering. */
  let pollError: Error | null;
  let verificationUrl: string;

  interface FakeResponse {
    headers: { get: (name: string) => string | null };
    json: () => Promise<unknown>;
    ok: boolean;
    status: number;
    statusText: string;
  }

  function makeResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): FakeResponse {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : "Error",
      headers: { get: (name) => headers[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(body),
    };
  }

  const jsonResponse = (body: unknown) => makeResponse(200, body);
  const errorResponse = (
    status: number,
    body: unknown,
    headers?: Record<string, string>
  ) => makeResponse(status, body, headers);

  beforeEach(() => {
    pollQueue = [];
    pollCount = 0;
    pollError = null;
    verificationUrl = "https://cirron.dev/activate";

    fetchMock.mockReset();
    fetchMock.mockImplementation(((url: string, init?: { method?: string }) => {
      const method = init?.method ?? "GET";

      if (url.includes("/api/cli/auth/device")) {
        if (method === "POST") {
          return Promise.resolve(
            jsonResponse({
              deviceCode: `device_${"a".repeat(32)}`,
              userCode: "ABCD12345678",
              verificationUrl,
              expiresIn: 600,
              interval: 1,
            })
          );
        }

        pollCount++;
        if (pollError) {
          return Promise.reject(pollError);
        }
        const next = pollQueue.length > 1 ? pollQueue.shift() : pollQueue.at(0);
        return Promise.resolve(next);
      }

      if (url.includes("/api/cli/status")) {
        return Promise.resolve(
          jsonResponse({
            valid: true,
            user: { email: "dev@example.com", name: "Dev User" },
          })
        );
      }

      return Promise.reject(new Error(`unexpected request: ${method} ${url}`));
    }) as never);

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

  it("keeps polling through a long authorization and then succeeds", async () => {
    // The platform allows 10 minutes. The old poll loop tolerated 5 errors
    // and treated every 400 authorization_pending as one, so it gave up after
    // roughly 35 seconds.
    for (let i = 0; i < 12; i++) {
      pollQueue.push(errorResponse(400, { error: "authorization_pending" }));
    }
    pollQueue.push(
      jsonResponse({
        accessToken: "access-xyz",
        refreshToken: "refresh-xyz",
        tokenType: "Bearer",
        expiresIn: 604_800,
      })
    );

    await loginCommand({});

    const cfg = new ConfigManager().load();
    expect(cfg.auth?.accessToken).toBe("access-xyz");
    expect(cfg.auth?.refreshToken).toBe("refresh-xyz");
    expect(pollCount).toBe(13);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/dev@example\.com/);
  });

  it("succeeds when the first poll already carries tokens", async () => {
    pollQueue.push(
      jsonResponse({
        accessToken: "a",
        refreshToken: "r",
        tokenType: "Bearer",
        expiresIn: 604_800,
      })
    );

    await loginCommand({});

    expect(new ConfigManager().load().auth?.accessToken).toBe("a");
    expect(pollCount).toBe(1);
    expect(openMock).toHaveBeenCalledWith("https://cirron.dev/activate");
  });

  it("stops immediately on an expired device code", async () => {
    pollQueue.push(errorResponse(400, { error: "expired_token" }));

    await expect(loginCommand({})).rejects.toThrow(/expired/i);
    expect(pollCount).toBe(1);
  });

  it("honors Retry-After on a 429 and carries on", async () => {
    pollQueue.push(
      errorResponse(
        429,
        { error: "Rate limit exceeded" },
        { "retry-after": "7" }
      )
    );
    pollQueue.push(
      jsonResponse({
        accessToken: "a",
        refreshToken: "r",
        tokenType: "Bearer",
        expiresIn: 604_800,
      })
    );

    await loginCommand({});

    expect(new ConfigManager().load().auth?.accessToken).toBe("a");
    // The 429 neither aborted the login nor burned the transport budget.
    expect(pollCount).toBe(2);
  });

  it("gives up after repeated transport failures", async () => {
    pollError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    await expect(loginCommand({})).rejects.toThrow();
  });

  it("rewrites a 'null/...' verification URL using the API base", async () => {
    verificationUrl = "null/activate";
    pollQueue.push(
      jsonResponse({
        accessToken: "a",
        refreshToken: "r",
        tokenType: "Bearer",
        expiresIn: 604_800,
      })
    );

    await loginCommand({ url: "https://platform.cirron.dev/api" });

    // base = "https://platform.cirron.dev" (with /api stripped)
    expect(openMock).toHaveBeenCalledWith(
      "https://platform.cirron.dev/activate"
    );
  });

  it("rejects when requestDeviceCode fails", async () => {
    vi.spyOn(CirronApi.prototype, "requestDeviceCode").mockRejectedValue(
      new Error("device endpoint down")
    );

    await expect(loginCommand({})).rejects.toThrow(/device endpoint down/);
  });
});
