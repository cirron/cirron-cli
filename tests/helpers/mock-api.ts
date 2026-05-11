import { vi, type Mock } from "vitest";
import type { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import type {
  DeploymentInfo,
  PullArtifactInfo,
  PullDownloadInfo,
  PushConfirmation,
  PushDedupeResult,
  PushUploadUrl,
  SyncDiffResult,
} from "../../src/types";

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
        return;
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
/**
 * Stub a single CirronApi prototype method with a resolved value. Returns the
 * spy so callers can chain `.mockResolvedValueOnce(...)`/`.mockRejectedValueOnce(...)`.
 */
export function stubApi<K extends keyof CirronApi>(
  method: K,
  value: Awaited<ReturnType<Extract<CirronApi[K], (...args: never[]) => unknown>>>
): Mock {
  return vi
    .spyOn(
      require("../../src/utils/api").CirronApi.prototype,
      method as string
    )
    .mockResolvedValue(value as never) as unknown as Mock;
}

export function stubApiReject<K extends keyof CirronApi>(
  method: K,
  error: Error
): Mock {
  return vi
    .spyOn(
      require("../../src/utils/api").CirronApi.prototype,
      method as string
    )
    .mockRejectedValue(error) as unknown as Mock;
}

// --- Typed payload factories ---

export function pullArtifact(
  overrides: Partial<PullArtifactInfo> = {}
): PullArtifactInfo {
  return {
    id: "art-1",
    name: "demo-model",
    type: "model",
    tag: "latest",
    filename: "demo-model.pth",
    size: 1024,
    checksum: "a".repeat(64),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function pullDownload(
  overrides: Partial<PullDownloadInfo> = {}
): PullDownloadInfo {
  return {
    artifactId: "art-1",
    downloadUrl: "https://example.invalid/download/art-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

export function pushDedupe(
  overrides: Partial<PushDedupeResult> = {}
): PushDedupeResult {
  return { exists: false, ...overrides };
}

export function pushUploadUrl(
  overrides: Partial<PushUploadUrl> = {}
): PushUploadUrl {
  return {
    uploadId: "upload-1",
    uploadUrl: "https://example.invalid/upload/upload-1",
    chunkSize: 5 * 1024 * 1024,
    maxChunks: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

export function pushConfirmation(
  overrides: Partial<PushConfirmation> = {}
): PushConfirmation {
  return {
    artifactId: "art-1",
    versionId: "ver-1",
    name: "demo-model",
    type: "model",
    tag: "latest",
    size: 1024,
    checksum: "a".repeat(64),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function syncDiff(overrides: Partial<SyncDiffResult> = {}): SyncDiffResult {
  return {
    localOnly: [],
    remoteOnly: [],
    changedLocally: [],
    changedRemotely: [],
    conflicts: [],
    unchanged: [],
    ...overrides,
  };
}

export function deployment(
  overrides: Partial<DeploymentInfo> = {}
): DeploymentInfo {
  return {
    id: "dep-1",
    environment: "production",
    status: "success",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

export function exitCodeFromError(error: unknown): number | null {
  if (!(error instanceof Error)) {
    return null;
  }
  const match = error.message.match(/^__process\.exit\((\d+)\)__$/);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}
