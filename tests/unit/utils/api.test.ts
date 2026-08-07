import fetch from "node-fetch";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
const fetchMock = vi.mocked(fetch);

import type { CirronConfig } from "../../../src/types";
import { CirronApi } from "../../../src/utils/api";

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
});
