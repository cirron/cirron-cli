import { vi } from "vitest";
import type { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";

/**
 * Build a mock CirronApi where every method rejects with the given error
 * (defaults to PlatformUnavailableError). Useful for testing graceful-error
 * paths without actually hitting the network.
 *
 * The returned object is `as unknown as CirronApi` so it can be passed where a
 * real CirronApi is expected. Override individual methods on the returned
 * object to script specific test behaviors:
 *
 *   const api = mockApi();
 *   (api.verifyAuth as Mock).mockResolvedValueOnce({ valid: true, user: { ... } });
 */
export function mockApi(rejectWith: Error = new PlatformUnavailableError("offline")): CirronApi {
  const handler: ProxyHandler<object> = {
    get(_target, prop) {
      if (prop === "then" || typeof prop === "symbol") {
        return undefined;
      }
      return vi.fn().mockRejectedValue(rejectWith);
    },
  };
  return new Proxy({}, handler) as unknown as CirronApi;
}

/**
 * Stub process.exit so tests can assert on the exit code without actually
 * tearing down the test runner. Returns the spy plus a restore function.
 */
export function stubProcessExit(): {
  spy: ReturnType<typeof vi.spyOn>;
  restore: () => void;
} {
  const spy = vi
    .spyOn(process, "exit")
    .mockImplementation((code?: number | string | null) => {
      throw new Error(`__process.exit(${code ?? 0})__`);
    });
  return {
    spy,
    restore: () => spy.mockRestore(),
  };
}

/**
 * Parse the synthetic error thrown by stubProcessExit back into a numeric exit
 * code. Returns null if the error doesn't match the sentinel format.
 */
export function exitCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  const match = error.message.match(/^__process\.exit\((\d+)\)__$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}
