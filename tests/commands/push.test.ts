import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeFileChecksum,
  formatSize,
  pushArtifact,
  pushCommand,
} from "../../src/commands/push";
import { CirronApi } from "../../src/utils/api";
import {
  exitCodeFromError,
  pushConfirmation,
  pushDedupe,
  pushUploadUrl,
  stubProcessExit,
} from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Test pushCommand end-to-end with mocked CirronApi:
 * auth gate, usage prompts, resource-typed push, path-based push (single +
 * multi-file), --all with project config, dry-run, dedupe skip, version
 * creation, and multi-file failure rollup.
 */
describe("pushCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-push-");
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

  /** Stub the upload chain so single-file push succeeds end-to-end. */
  function stubUploadChain(opts?: {
    confirm?: Partial<{ artifactId: string }>;
  }) {
    vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
      pushDedupe({ exists: false })
    );
    vi.spyOn(CirronApi.prototype, "getUploadUrl").mockResolvedValue(
      pushUploadUrl()
    );
    vi.spyOn(CirronApi.prototype, "uploadFile").mockResolvedValue(
      undefined as never
    );
    vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
      pushConfirmation(opts?.confirm)
    );
  }

  it("returns early when not authenticated", async () => {
    await pushCommand("model", "demo", {});
    const out = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(out).toMatch(/Not authenticated|auth login/);
  });

  it("prints usage when no resource and no --all", async () => {
    createAuthenticatedSession(tmp.dir);
    await pushCommand(undefined, undefined, {});
    const out = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(out).toMatch(/Usage|Resource type/);
  });

  it("requires a name for resource-typed push", async () => {
    createAuthenticatedSession(tmp.dir);
    await pushCommand("model", undefined, {});
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Usage:.*push model/);
  });

  it("reports 'could not locate' when resource file is missing", async () => {
    createAuthenticatedSession(tmp.dir);
    await pushCommand("model", "missing-name", {});
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Could not locate/);
  });

  it("happy path: resource-typed push uploads and confirms", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    stubUploadChain();

    await pushCommand("model", "demo.pth", {});

    expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("dry-run prints summary and skips upload", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

    await pushCommand("model", "demo.pth", { dryRun: true });

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Dry run|Total:/);
  });

  it("dedupe-hit skips the upload phase", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
      pushDedupe({
        exists: true,
        artifactId: "art-existing",
        artifactName: "demo",
        tag: "v1",
      })
    );
    const uploadSpy = vi
      .spyOn(CirronApi.prototype, "uploadFile")
      .mockResolvedValue(undefined as never);
    const confirmSpy = vi.spyOn(CirronApi.prototype, "confirmUpload");

    await pushCommand("model", "demo.pth", {});

    expect(uploadSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it("--force skips the dedupe check", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    const dedupeSpy = vi.spyOn(CirronApi.prototype, "checkDedupe");
    vi.spyOn(CirronApi.prototype, "getUploadUrl").mockResolvedValue(
      pushUploadUrl()
    );
    vi.spyOn(CirronApi.prototype, "uploadFile").mockResolvedValue(
      undefined as never
    );
    vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
      pushConfirmation()
    );

    await pushCommand("model", "demo.pth", { force: true });

    expect(dedupeSpy).not.toHaveBeenCalled();
  });

  it("--json emits PushResult after success", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    stubUploadChain();

    await pushCommand("model", "demo.pth", { json: true });

    const jsonArg = infoSpy.mock.calls
      .flat()
      .find((s) => typeof s === "string" && s.trim().startsWith("{")) as
      | string
      | undefined;
    expect(jsonArg).toBeTruthy();
    expect(JSON.parse(jsonArg ?? "{}").verified).toBe(true);
  });

  it("exits 1 on resource-typed upload failure with 404 hint", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
      pushDedupe()
    );
    vi.spyOn(CirronApi.prototype, "getUploadUrl").mockRejectedValue(
      new Error("project not found 404")
    );

    let caught: unknown;
    try {
      await pushCommand("model", "demo.pth", {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/cirron register/);
  });

  describe("path-based push", () => {
    it("reports 'path not found' for missing path", async () => {
      createAuthenticatedSession(tmp.dir);
      await pushCommand("./missing-dir", undefined, {});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Path not found/);
    });

    it("path to single file uploads it", async () => {
      createAuthenticatedSession(tmp.dir);
      writeFileAt(tmp.dir, "data/blob.bin", "blob");
      stubUploadChain();

      await pushCommand("./data/blob.bin", undefined, {});

      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalled();
    });

    it("multi-file directory push uploads all and prints summary", async () => {
      createAuthenticatedSession(tmp.dir);
      writeFileAt(tmp.dir, "bundle/a.bin", "aaa");
      writeFileAt(tmp.dir, "bundle/b.bin", "bbb");
      stubUploadChain();

      await pushCommand("./bundle", undefined, {});

      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalledTimes(2);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Push summary/);
    });

    it("path-based dry-run skips upload", async () => {
      createAuthenticatedSession(tmp.dir);
      writeFileAt(tmp.dir, "bundle/a.bin", "aaa");
      const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

      await pushCommand("./bundle", undefined, { dryRun: true });

      expect(uploadSpy).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Dry run|Total:/);
    });

    it("multi-file: exits 1 when at least one upload fails", async () => {
      createAuthenticatedSession(tmp.dir);
      writeFileAt(tmp.dir, "bundle/a.bin", "aaa");
      writeFileAt(tmp.dir, "bundle/b.bin", "bbb");
      vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
        pushDedupe()
      );
      vi.spyOn(CirronApi.prototype, "getUploadUrl").mockResolvedValue(
        pushUploadUrl()
      );
      vi.spyOn(CirronApi.prototype, "uploadFile")
        .mockResolvedValueOnce(undefined as never)
        .mockRejectedValueOnce(new Error("upload broke"));
      vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
        pushConfirmation()
      );

      let caught: unknown;
      try {
        await pushCommand("./bundle", undefined, {});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Failed:/);
    });
  });

  describe("--all", () => {
    it("requires a project config", async () => {
      createAuthenticatedSession(tmp.dir);
      await pushCommand(undefined, undefined, { all: true });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/No cirron config/);
    });

    it("reports 'no artifact files found' when project has no artifacts", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      await pushCommand(undefined, undefined, { all: true });
      // No exit, just info message
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("uploads project artifacts and creates a version entry", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "111");
      writeFileAt(tmp.dir, "artifacts/a.bin", "222");
      stubUploadChain({ confirm: { artifactId: "art-new" } });
      const versionSpy = vi
        .spyOn(CirronApi.prototype, "createVersion")
        .mockResolvedValue({
          versionId: "v-1",
          tag: "latest",
          createdAt: new Date().toISOString(),
        } as never);

      await pushCommand(undefined, undefined, { all: true, tag: "v1" });

      expect(versionSpy).toHaveBeenCalled();
      const versionArg = versionSpy.mock.calls[0]?.[0] as
        | { tag?: string; artifacts?: unknown[] }
        | undefined;
      expect(versionArg?.tag).toBe("v1");
      expect(versionArg?.artifacts?.length).toBeGreaterThan(0);
    });

    it("--all dry-run skips upload entirely", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "111");
      const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

      await pushCommand(undefined, undefined, { all: true, dryRun: true });

      expect(uploadSpy).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Dry run|Total:/);
    });

    it("warns (non-fatal) when version creation fails after artifacts uploaded", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "models/m1.pth", "111");
      stubUploadChain({ confirm: { artifactId: "art-new" } });
      vi.spyOn(CirronApi.prototype, "createVersion").mockRejectedValue(
        new Error("version service down")
      );

      await pushCommand(undefined, undefined, { all: true });

      expect(exitStub.spy).not.toHaveBeenCalled();
    });
  });

  it("path-based: reports 'no files found' for empty directory", async () => {
    createAuthenticatedSession(tmp.dir);
    fs.ensureDirSync(path.join(tmp.dir, "empty-dir"));
    await pushCommand("./empty-dir", undefined, {});
    // No exit - just spinner.fail message
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("resource-typed: tag from name (demo:v1) is used in confirmation", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "models/demo.pth", "model bytes");
    stubUploadChain();
    const getUrlSpy = vi.spyOn(CirronApi.prototype, "getUploadUrl");

    await pushCommand("model", "demo.pth:v9", { message: "release" });

    const arg = getUrlSpy.mock.calls[0]?.[0] as { tag?: string } | undefined;
    expect(arg?.tag).toBe("v9");
  });

  it("multi-file --json emits PushSummary at the end", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "bundle/a.bin", "aaa");
    writeFileAt(tmp.dir, "bundle/b.bin", "bbb");
    stubUploadChain();

    await pushCommand("./bundle", undefined, { json: true });

    const jsonArg = infoSpy.mock.calls
      .flat()
      .find(
        (s) =>
          typeof s === "string" &&
          s.includes('"totalFiles"') &&
          s.includes('"results"')
      ) as string | undefined;
    expect(jsonArg).toBeTruthy();
    const parsed = JSON.parse(jsonArg ?? "{}");
    expect(parsed.totalFiles).toBe(2);
    expect(parsed.uploaded).toBe(2);
  });

  describe("formatSize", () => {
    it("formats bytes/KB/MB/GB correctly", () => {
      expect(formatSize(0)).toBe("0 B");
      expect(formatSize(512)).toBe("512 B");
      expect(formatSize(2048)).toBe("2.0 KB");
      expect(formatSize(2 * 1024 * 1024)).toBe("2.00 MB");
      expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
    });
  });

  describe("computeFileChecksum", () => {
    it("returns sha256 hex for file content", async () => {
      const fp = writeFileAt(tmp.dir, "x.bin", "hello world");
      const checksum = await computeFileChecksum(fp);
      expect(checksum).toBe(
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
      );
    });
  });

  describe("chunked upload (>5MB)", () => {
    it("calls createUploadSession + uploadFileChunk for each chunk", async () => {
      createAuthenticatedSession(tmp.dir);
      // 6 MB file -> 2 chunks at 5 MB chunkSize
      const big = path.join(tmp.dir, "big.bin");
      fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0));

      vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
        pushDedupe()
      );
      vi.spyOn(CirronApi.prototype, "getUploadUrl").mockResolvedValue(
        pushUploadUrl({ chunkSize: 5 * 1024 * 1024, maxChunks: 2 })
      );
      vi.spyOn(CirronApi.prototype, "createUploadSession").mockResolvedValue({
        sessionId: "sess-1",
      } as never);
      const chunkSpy = vi
        .spyOn(CirronApi.prototype, "uploadFileChunk")
        .mockResolvedValue("etag-x" as never);
      vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
        pushConfirmation({ size: 6 * 1024 * 1024 })
      );

      await pushCommand("./big.bin", undefined, {});

      expect(chunkSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("pushArtifact (programmatic)", () => {
    it("throws when not authenticated", async () => {
      const filePath = writeFileAt(tmp.dir, "demo.bin", "data");
      await expect(pushArtifact(filePath, {})).rejects.toThrow(
        /Not authenticated/
      );
    });

    it("returns a successful PushResult on happy path", async () => {
      createAuthenticatedSession(tmp.dir);
      const filePath = writeFileAt(tmp.dir, "demo.bin", "data");
      stubUploadChain();

      const result = await pushArtifact(filePath, {
        resource: "model",
        name: "demo",
        tag: "v1",
        message: "first push",
        registry: "main",
        force: true,
      });

      expect(result.skipped).toBe(false);
      expect(result.verified).toBe(true);
    });

    it("reports skipped result when dedupe matches", async () => {
      createAuthenticatedSession(tmp.dir);
      const filePath = writeFileAt(tmp.dir, "demo.bin", "data");
      vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
        pushDedupe({
          exists: true,
          artifactId: "art-existing",
          artifactName: "demo",
          tag: "v1",
        })
      );

      const result = await pushArtifact(filePath, { resource: "model" });

      expect(result.skipped).toBe(true);
      expect(result.skipReason).toBe("deduplicated");
    });
  });
});
