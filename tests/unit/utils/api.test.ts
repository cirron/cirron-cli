import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import fs from "fs-extra";
import fetch from "node-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
const fetchMock = vi.mocked(fetch);

import type { CirronConfig } from "../../../src/types";
import { CirronApi } from "../../../src/utils/api";
import { PlatformRateLimitError } from "../../../src/utils/api-errors";
import { ConfigManager } from "../../../src/utils/config";
import { makeTmpDir } from "../../helpers/tmpdir";

/** Header bag matching what node-fetch hands back, with optional entries. */
function headerBag(entries: Record<string, string> = {}) {
  return { get: (name: string) => entries[name.toLowerCase()] ?? null };
}

/** The Authorization header sent on the Nth fetch call (0-indexed). */
function authHeaderOnCall(index: number): string | undefined {
  const call = fetchMock.mock.calls.at(index);
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.Authorization;
}

/** The URL of the Nth fetch call (0-indexed, negatives count from the end). */
function urlOnCall(index: number): string {
  return String(fetchMock.mock.calls.at(index)?.[0] ?? "");
}

/**
 * Cover the retry/timeout lifecycle in requestRaw, the transport under every
 * non-streaming call the CLI makes.
 *
 * The client is built with a tiny timeout and one retry so the abort path runs
 * on real timers in about a second. Fake timers are deliberately avoided here:
 * they would let an abort-semantics regression pass.
 */
describe("CirronApi requestRaw", () => {
  const config: CirronConfig = {
    apiUrl: "https://example.test",
    defaultEnv: "production",
    timeout: 100,
    retries: 1,
  };

  let api: CirronApi;

  /** Header bag matching what node-fetch hands back. */
  const noHeaders = { get: () => null };

  /** A minimal successful JSON response. */
  function okResponse() {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: noHeaders,
      json: async () => ({ valid: true }),
    };
  }

  /** A minimal error response with the given status. */
  function errorResponse(status: number, statusText: string) {
    return {
      ok: false,
      status,
      statusText,
      headers: noHeaders,
      json: async () => ({}),
    };
  }

  beforeEach(() => {
    fetchMock.mockReset();
    api = new CirronApi(config);
  });

  it("retries a 500 and resolves on the second attempt", async () => {
    fetchMock
      .mockResolvedValueOnce(
        errorResponse(500, "Internal Server Error") as never
      )
      .mockResolvedValueOnce(okResponse() as never);

    await expect(api.verifyAuth()).resolves.toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives each attempt a fresh, un-aborted signal", async () => {
    // The regression: one AbortController shared across attempts latches
    // aborted after the first timeout, so every later retry rejects instantly
    // with an abort error — retries become no-ops exactly when the network is
    // flaky.
    const signals: AbortSignal[] = [];
    const abortedOnEntry: boolean[] = [];

    fetchMock.mockImplementation(((
      _url: string,
      init: { signal: AbortSignal }
    ) => {
      const { signal } = init;
      signals.push(signal);
      abortedOnEntry.push(signal.aborted);

      if (signals.length === 1) {
        // Never settles on its own; only this attempt's timeout can end it.
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        });
      }

      return Promise.resolve(okResponse());
    }) as never);

    await expect(api.verifyAuth()).resolves.toBeDefined();

    expect(signals).toHaveLength(2);
    expect(abortedOnEntry).toEqual([false, false]);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("does not retry a 400", async () => {
    fetchMock.mockResolvedValue(errorResponse(400, "Bad Request") as never);

    await expect(api.verifyAuth()).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry the refresh endpoint", async () => {
    fetchMock.mockResolvedValue(
      errorResponse(500, "Internal Server Error") as never
    );

    await expect(api.refreshToken("rt")).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["7", 7],
    // "retry immediately" is a real instruction, not a missing header.
    ["0", 0],
    ["", undefined],
    ["later", undefined],
  ])("surfaces Retry-After %j on a 429 as %j", async (header, expected) => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      statusText: "Too Many Requests",
      headers: { get: () => (header === "" ? null : header) },
      json: async () => ({ error: "Rate limit exceeded" }),
    } as never);

    const caught = await api.verifyAuth().catch((err: unknown) => err);

    expect(caught).toBeInstanceOf(PlatformRateLimitError);
    expect((caught as PlatformRateLimitError).retryAfterSeconds).toBe(expected);
    // 429 is never retried by the transport; the caller decides.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/** A 200 JSON response carrying `body`. */
function jsonOk(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: headerBag(),
    json: async () => body,
  };
}

/** A non-2xx response carrying `body`. */
function jsonError(status: number, body: unknown = {}) {
  return {
    ok: false,
    status,
    statusText: "Error",
    headers: headerBag(),
    json: async () => body,
  };
}

const BASE_CONFIG = {
  apiUrl: "https://example.test",
  defaultEnv: "production",
  timeout: 1000,
  retries: 0,
};

describe("CirronApi auth header precedence", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(jsonOk({ valid: true }) as never);
  });

  it("prefers the device-flow JWT over a legacy token", async () => {
    const api = new CirronApi({
      ...BASE_CONFIG,
      token: "sk-legacy",
      auth: { accessToken: "jwt-access", refreshToken: "jwt-refresh" },
    });

    await api.verifyAuth();

    expect(authHeaderOnCall(0)).toBe("Bearer jwt-access");
  });

  it("falls back to the legacy token", async () => {
    const api = new CirronApi({ ...BASE_CONFIG, token: "sk-legacy" });

    await api.verifyAuth();

    expect(authHeaderOnCall(0)).toBe("Bearer sk-legacy");
  });

  it("sends no Authorization header without credentials", async () => {
    const api = new CirronApi({ ...BASE_CONFIG });

    await api.verifyAuth();

    expect(authHeaderOnCall(0)).toBeUndefined();
  });
});

/**
 * The reactive path: no proactive refresh on plain requests, but a 401 with a
 * stored refresh token triggers exactly one refresh and one retry, and the
 * rotated tokens must reach disk.
 */
describe("CirronApi 401 refresh and retry", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  const REFRESH_BODY = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  };

  function authedConfig(overrides: Partial<CirronConfig> = {}): CirronConfig {
    return {
      ...BASE_CONFIG,
      auth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-api-refresh-");
    // ConfigManager persistence inside api.ts is real, but sandboxed here.
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    new ConfigManager().save(authedConfig());
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("refreshes once, retries once, and persists the new tokens", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonError(401) as never)
      .mockResolvedValueOnce(jsonOk(REFRESH_BODY) as never)
      .mockResolvedValueOnce(jsonOk({ valid: true }) as never);

    const api = new CirronApi(authedConfig());
    await expect(api.verifyAuth()).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(urlOnCall(1)).toContain("/api/cli/auth/refresh");
    expect(authHeaderOnCall(2)).toBe("Bearer new-access");

    const stored = new ConfigManager().load();
    expect(stored.auth?.accessToken).toBe("new-access");
    expect(stored.auth?.refreshToken).toBe("new-refresh");
  });

  it("rethrows the original auth error when the refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonError(401, { error: "token expired" }) as never
      )
      .mockResolvedValueOnce(
        jsonError(500, { error: "refresh boom" }) as never
      );

    const api = new CirronApi(authedConfig());
    await expect(api.verifyAuth()).rejects.toThrow(/token expired/);

    // The stored tokens are untouched by a failed refresh.
    const stored = new ConfigManager().load();
    expect(stored.auth?.accessToken).toBe("old-access");
  });

  it("does not attempt a refresh without a stored refresh token", async () => {
    fetchMock.mockResolvedValue(jsonError(401) as never);

    const api = new CirronApi({
      ...BASE_CONFIG,
      auth: { accessToken: "old-access" } as CirronConfig["auth"],
    });
    await expect(api.verifyAuth()).rejects.toThrow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The proactive path: only the streaming methods call ensureValidToken, which
 * refreshes when the stored token expires within five minutes and swallows a
 * failed refresh so the transfer still gets its chance.
 */
describe("CirronApi ensureValidToken on downloads", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let destPath: string;

  const REFRESH_BODY = {
    access_token: "new-access",
    refresh_token: "new-refresh",
    expires_in: 3600,
    token_type: "Bearer",
  };

  /** A download response whose body is a Node readable, as node-fetch gives. */
  function downloadResponse(payload: string) {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: headerBag({ "content-length": String(payload.length) }),
      body: Readable.from(Buffer.from(payload)),
    };
  }

  function configExpiringIn(ms: number): CirronConfig {
    return {
      ...BASE_CONFIG,
      auth: {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date(Date.now() + ms).toISOString(),
      },
    };
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-api-download-");
    destPath = path.join(tmp.dir, "artifact.bin");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("refreshes first when the token expires within five minutes", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonOk(REFRESH_BODY) as never)
      .mockResolvedValueOnce(downloadResponse("payload") as never);

    const api = new CirronApi(configExpiringIn(60_000));
    await api.downloadFile("https://files.test/artifact", destPath);

    expect(urlOnCall(0)).toContain("/api/cli/auth/refresh");
    expect(fs.readFileSync(destPath, "utf8")).toBe("payload");
  });

  it("skips the refresh when the token is still fresh", async () => {
    fetchMock.mockResolvedValueOnce(downloadResponse("payload") as never);

    const api = new CirronApi(configExpiringIn(86_400_000));
    await api.downloadFile("https://files.test/artifact", destPath);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlOnCall(0)).toBe("https://files.test/artifact");
  });

  it("continues the download when the refresh fails", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonError(500) as never)
      .mockResolvedValueOnce(downloadResponse("payload") as never);

    const api = new CirronApi(configExpiringIn(60_000));
    await api.downloadFile("https://files.test/artifact", destPath);

    expect(fs.readFileSync(destPath, "utf8")).toBe("payload");
  });
});
