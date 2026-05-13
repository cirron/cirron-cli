import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncCommand } from "../../src/commands/sync";
import { CirronApi } from "../../src/utils/api";
import {
  exitCodeFromError,
  pullDownload,
  pushConfirmation,
  pushDedupe,
  pushUploadUrl,
  stubProcessExit,
  syncDiff,
} from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Test syncCommand with mocked CirronApi.getSyncDiff:
 * option validation, gates, dry-run, the four conflict strategies,
 * path-traversal guard, multi-file partial-failure rollup, and metadata sync.
 */
describe("syncCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  // sha256 of "hello world"
  const HELLO_CHECKSUM =
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

  beforeEach(() => {
    tmp = makeTmpDir("cirron-sync-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  /** Stub the push chain so any push from sync succeeds. */
  function stubPushChain(): void {
    vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
      pushDedupe()
    );
    vi.spyOn(CirronApi.prototype, "getUploadUrl").mockResolvedValue(
      pushUploadUrl()
    );
    vi.spyOn(CirronApi.prototype, "uploadFile").mockResolvedValue(
      undefined as never
    );
    vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
      pushConfirmation()
    );
  }

  /** Stub the pull chain — writes "hello world" so checksum verifies. */
  function stubPullChain(): void {
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    vi.spyOn(CirronApi.prototype, "downloadFile").mockImplementation(
      async (_url: string, dest: string) => {
        await fs.writeFile(dest, "hello world");
      }
    );
  }

  describe("option validation", () => {
    it("exits 1 when --push-only and --pull-only are combined", async () => {
      let caught: unknown;
      try {
        await syncCommand(undefined, { pushOnly: true, pullOnly: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /push-only and --pull-only/
      );
    });

    it("exits 1 when --force is used without push-only or pull-only", async () => {
      let caught: unknown;
      try {
        await syncCommand(undefined, { force: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/force/);
    });

    it("exits 1 on invalid conflict strategy", async () => {
      let caught: unknown;
      try {
        await syncCommand(undefined, { conflicts: "bogus" });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Invalid conflict/);
    });
  });

  it("returns early when not authenticated", async () => {
    await syncCommand(undefined, {});
    const out = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(out).toMatch(/Not authenticated|auth login/);
  });

  it("returns early when project config is missing", async () => {
    createAuthenticatedSession(tmp.dir);
    await syncCommand(undefined, {});
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/No cirron config/);
  });

  it("reports 'no local artifact files' when project has none", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    await syncCommand(undefined, {});
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("reports 'already in sync' when diff is empty and manifest non-empty", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        unchanged: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );

    await syncCommand(undefined, {});

    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Already in sync/);
  });

  it("dry-run prints diff summary and skips execution", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );
    const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

    await syncCommand(undefined, { dryRun: true });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /Sync dry run|Summary:/
    );
  });

  it("dry-run JSON emits structured output", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );

    await syncCommand(undefined, { dryRun: true, json: true });

    const jsonArg = infoSpy.mock.calls
      .flat()
      .find((s) => typeof s === "string" && s.includes('"localOnly"')) as
      | string
      | undefined;
    expect(jsonArg).toBeTruthy();
    expect(JSON.parse(jsonArg ?? "{}").summary.toPush).toBe(1);
  });

  it("exits 1 when getSyncDiff fails", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockRejectedValue(
      new Error("server boom")
    );

    let caught: unknown;
    try {
      await syncCommand(undefined, {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  it("exits 1 when buildLocalManifest fails (sync path missing)", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    let caught: unknown;
    try {
      await syncCommand("./missing-path", {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  it("happy path: pushes localOnly + pulls remoteOnly", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
        remoteOnly: [
          {
            path: "models/m2.pth",
            checksum: HELLO_CHECKSUM,
            size: 11,
            artifactId: "art-2",
            artifactName: "m2",
            type: "model",
            tag: "latest",
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    stubPushChain();
    stubPullChain();

    await syncCommand(undefined, {});

    expect(fs.existsSync(path.join(tmp.dir, "models/m2.pth"))).toBe(true);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Sync summary|Pushed/);
  });

  it("warns (non-fatal) when completeSyncMetadata fails", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );
    stubPushChain();
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockRejectedValue(
      new Error("metadata service down")
    );

    await syncCommand(undefined, {});

    expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/sync metadata/i);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("exits 1 when partial sync failure occurs", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
      pushDedupe()
    );
    vi.spyOn(CirronApi.prototype, "getUploadUrl").mockRejectedValue(
      new Error("upload denied")
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );

    let caught: unknown;
    try {
      await syncCommand(undefined, {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });

  describe("conflict strategies", () => {
    function diffWithConflict() {
      return syncDiff({
        conflicts: [
          {
            path: "models/m1.pth",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-1",
            artifactName: "m1",
            type: "model",
            tag: "latest",
          },
        ],
      });
    }

    it("local-wins pushes the local copy", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "hello world");
      vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
        diffWithConflict()
      );
      vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
        undefined as never
      );
      stubPushChain();

      await syncCommand(undefined, { conflicts: "local-wins" });

      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
    });

    it("remote-wins pulls the remote copy", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "hello world");
      vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
        syncDiff({
          conflicts: [
            {
              path: "models/m1.pth",
              localChecksum: HELLO_CHECKSUM,
              remoteChecksum: HELLO_CHECKSUM,
              localSize: 11,
              remoteSize: 11,
              artifactId: "art-1",
              artifactName: "m1",
              type: "model",
              tag: "latest",
            },
          ],
        })
      );
      vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
        undefined as never
      );
      stubPullChain();

      await syncCommand(undefined, { conflicts: "remote-wins" });

      expect(CirronApi.prototype.downloadFile).toHaveBeenCalled();
    });

    it("keep-both creates .local and .remote copies", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "hello world");
      vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
        syncDiff({
          conflicts: [
            {
              path: "models/m1.pth",
              localChecksum: HELLO_CHECKSUM,
              remoteChecksum: HELLO_CHECKSUM,
              localSize: 11,
              remoteSize: 11,
              artifactId: "art-1",
              artifactName: "m1",
              type: "model",
              tag: "latest",
            },
          ],
        })
      );
      vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
        undefined as never
      );
      stubPullChain();

      await syncCommand(undefined, { conflicts: "keep-both" });

      expect(fs.existsSync(path.join(tmp.dir, "models/m1.local.pth"))).toBe(
        true
      );
      expect(fs.existsSync(path.join(tmp.dir, "models/m1.remote.pth"))).toBe(
        true
      );
    });

    it("interactive prompt: skip leaves files alone", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "hello world");
      vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
        diffWithConflict()
      );
      vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
        undefined as never
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        resolution: "skip",
      } as never);
      const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

      await syncCommand(undefined, {});

      expect(uploadSpy).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Skipped/);
    });

    it("interactive prompt: overwrite-remote pushes local", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "hello world");
      vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
        diffWithConflict()
      );
      vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
        undefined as never
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        resolution: "overwrite-remote",
      } as never);
      stubPushChain();

      await syncCommand(undefined, {});

      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
    });
  });

  it("--push-only filters out remoteOnly + changedRemotely", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/m1.pth", checksum: HELLO_CHECKSUM, size: 11 },
        ],
        remoteOnly: [
          {
            path: "remote.pth",
            checksum: HELLO_CHECKSUM,
            size: 11,
            artifactId: "art-r",
            artifactName: "r",
            type: "model",
            tag: "latest",
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    const downloadSpy = vi.spyOn(CirronApi.prototype, "downloadFile");
    stubPushChain();

    await syncCommand(undefined, { pushOnly: true });

    expect(downloadSpy).not.toHaveBeenCalled();
    expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
  });

  it("--exclude filters paths by glob", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/skip.txt", "hello world");
    writeFileAt(tmp.dir, "models/keep.bin", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [
          { path: "models/skip.txt", checksum: HELLO_CHECKSUM, size: 11 },
          { path: "models/keep.bin", checksum: HELLO_CHECKSUM, size: 11 },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    stubPushChain();

    await syncCommand(undefined, { exclude: "*.txt" });

    // Only keep.bin should be pushed
    expect(CirronApi.prototype.confirmUpload).toHaveBeenCalledTimes(1);
  });

  it("dry-run text mode renders all diff sections (verbose)", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        localOnly: [{ path: "a.bin", checksum: HELLO_CHECKSUM, size: 11 }],
        remoteOnly: [
          {
            path: "b.bin",
            checksum: HELLO_CHECKSUM,
            size: 11,
            artifactId: "art-r",
            artifactName: "r",
            type: "model",
            tag: "latest",
            createdAt: new Date().toISOString(),
          },
        ],
        changedLocally: [
          {
            path: "c.bin",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-c",
            artifactName: "c",
            type: "model",
            tag: "latest",
          },
        ],
        changedRemotely: [
          {
            path: "d.bin",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-d",
            artifactName: "d",
            type: "model",
            tag: "latest",
          },
        ],
        conflicts: [
          {
            path: "e.bin",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-e",
            artifactName: "e",
            type: "model",
            tag: "latest",
          },
        ],
        unchanged: [{ path: "u.bin", checksum: HELLO_CHECKSUM, size: 11 }],
      })
    );

    await syncCommand(undefined, { dryRun: true, verbose: true });

    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toMatch(/Push \(local only\):/);
    expect(out).toMatch(/Pull \(remote only\):/);
    expect(out).toMatch(/Push \(changed locally\):/);
    expect(out).toMatch(/Pull \(changed remotely\):/);
    expect(out).toMatch(/Conflicts:/);
    expect(out).toMatch(/Unchanged:/);
  });

  it("executes changedLocally pushes + changedRemotely pulls", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    writeFileAt(tmp.dir, "models/m2.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        changedLocally: [
          {
            path: "models/m1.pth",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-1",
            artifactName: "m1",
            type: "model",
            tag: "latest",
          },
        ],
        changedRemotely: [
          {
            path: "models/m2.pth",
            localChecksum: "b".repeat(64),
            remoteChecksum: HELLO_CHECKSUM,
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-2",
            artifactName: "m2",
            type: "model",
            tag: "latest",
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    stubPushChain();
    stubPullChain();

    await syncCommand(undefined, {});

    expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
    expect(CirronApi.prototype.downloadFile).toHaveBeenCalled();
  });

  it("--pull-only --force converts conflicts into remote-wins pulls", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        conflicts: [
          {
            path: "models/m1.pth",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: HELLO_CHECKSUM,
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-1",
            artifactName: "m1",
            type: "model",
            tag: "latest",
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    stubPullChain();

    await syncCommand(undefined, { pullOnly: true, force: true });

    expect(CirronApi.prototype.downloadFile).toHaveBeenCalled();
  });

  it("--push-only --force converts conflicts into local-wins pushes", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        conflicts: [
          {
            path: "models/m1.pth",
            localChecksum: HELLO_CHECKSUM,
            remoteChecksum: "b".repeat(64),
            localSize: 11,
            remoteSize: 11,
            artifactId: "art-1",
            artifactName: "m1",
            type: "model",
            tag: "latest",
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    stubPushChain();

    await syncCommand(undefined, { pushOnly: true, force: true });

    expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
  });

  it("rejects path traversal in remote file path", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir);
    writeFileAt(tmp.dir, "models/m1.pth", "hello world");
    vi.spyOn(CirronApi.prototype, "getSyncDiff").mockResolvedValue(
      syncDiff({
        remoteOnly: [
          {
            path: "../escape/me.bin",
            checksum: HELLO_CHECKSUM,
            size: 11,
            artifactId: "art-evil",
            artifactName: "evil",
            type: "model",
            tag: "latest",
            createdAt: new Date().toISOString(),
          },
        ],
      })
    );
    vi.spyOn(CirronApi.prototype, "completeSyncMetadata").mockResolvedValue(
      undefined as never
    );
    const downloadSpy = vi.spyOn(CirronApi.prototype, "downloadFile");

    let caught: unknown;
    try {
      await syncCommand(undefined, {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});
