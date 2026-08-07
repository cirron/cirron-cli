import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pushArtifact, pushCommand } from "../../src/commands/push";
import { CirronApi } from "../../src/utils/api";
import {
  exitCodeFromError,
  pushConfirmation,
  pushDedupe,
  pushMultipartComplete,
  pushMultipartInit,
  pushMultipartPartRecord,
  pushMultipartPartUrl,
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

    it("follows symlinked files and directories during the walk", async () => {
      createAuthenticatedSession(tmp.dir);
      writeFileAt(tmp.dir, "bundle/a.bin", "aaa");
      writeFileAt(tmp.dir, "outside/target.bin", "ttt");
      writeFileAt(tmp.dir, "outside-dir/nested.bin", "nnn");
      // A symlinked file and a symlinked directory. Dirents do not follow
      // symlinks, so `isDirectory()` is false for both. The symlinked FILE is
      // unaffected: it falls through to the file branch either way. The
      // symlinked DIRECTORY is the case that needs the explicit stat, and
      // without it the walk treats it as a file and the push fails when
      // hashing tries to read a directory (EISDIR) rather than skipping it.
      fs.symlinkSync(
        path.join(tmp.dir, "outside/target.bin"),
        path.join(tmp.dir, "bundle/link.bin")
      );
      fs.symlinkSync(
        path.join(tmp.dir, "outside-dir"),
        path.join(tmp.dir, "bundle/linked-dir")
      );
      stubUploadChain();

      await pushCommand("./bundle", undefined, {});

      // a.bin + link.bin + linked-dir/nested.bin
      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalledTimes(3);
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

  describe("multipart upload", () => {
    const THRESHOLD = 256 * 1024 * 1024;

    /**
     * Make a real (small) file report a huge size so the multipart path is
     * taken without writing hundreds of megabytes to disk. The checksum still
     * reads the real bytes; the part uploads are stubbed.
     */
    function stubHugeFile(name: string, size: number): string {
      const filePath = path.join(tmp.dir, name);
      fs.writeFileSync(filePath, "small-real-contents");
      const realStat = fs.stat.bind(fs);
      vi.spyOn(fs, "stat").mockImplementation((async (target: string) => {
        const stat = await realStat(target);
        if (String(target).endsWith(name)) {
          return Object.assign(stat, { size });
        }
        return stat;
      }) as never);
      return filePath;
    }

    function stubMultipartChain(init: { partCount: number; partSize: number }) {
      vi.spyOn(CirronApi.prototype, "checkDedupe").mockResolvedValue(
        pushDedupe()
      );
      vi.spyOn(CirronApi.prototype, "initMultipartUpload").mockResolvedValue(
        pushMultipartInit(init)
      );
      vi.spyOn(CirronApi.prototype, "getMultipartPartUrl").mockImplementation(
        (opts) =>
          Promise.resolve(
            pushMultipartPartUrl({
              partNumber: opts.partNumber,
              url: `https://example.invalid/part/${opts.partNumber}`,
            })
          )
      );
      vi.spyOn(CirronApi.prototype, "recordMultipartPart").mockResolvedValue(
        pushMultipartPartRecord()
      );
      vi.spyOn(
        CirronApi.prototype,
        "completeMultipartUpload"
      ).mockResolvedValue(pushMultipartComplete());
      vi.spyOn(CirronApi.prototype, "confirmUpload").mockResolvedValue(
        pushConfirmation()
      );
    }

    it("a 6 MB file still takes the single-PUT path", async () => {
      createAuthenticatedSession(tmp.dir);
      const big = path.join(tmp.dir, "big.bin");
      fs.writeFileSync(big, Buffer.alloc(6 * 1024 * 1024, 0));

      stubUploadChain();
      const initSpy = vi.spyOn(CirronApi.prototype, "initMultipartUpload");
      const uploadSpy = vi.spyOn(CirronApi.prototype, "uploadFile");

      await pushCommand("./big.bin", undefined, {});

      // The regression this plan fixes: >5 MB used to take the broken
      // chunked path. It is now a single PUT, and multipart is not involved
      // below the threshold.
      expect(uploadSpy).toHaveBeenCalledTimes(1);
      expect(initSpy).not.toHaveBeenCalled();
    });

    it("a file exactly at the threshold takes the single-PUT path", async () => {
      createAuthenticatedSession(tmp.dir);
      stubHugeFile("edge.bin", THRESHOLD);

      stubUploadChain();
      const initSpy = vi.spyOn(CirronApi.prototype, "initMultipartUpload");

      await pushCommand("./edge.bin", undefined, {});

      // The cutover is strictly greater-than, matching the server's "below
      // this, keep using the single bound PUT". A 256 MiB single PUT is well
      // inside S3's 5 GiB limit, so the boundary is safe either way.
      expect(initSpy).not.toHaveBeenCalled();
      expect(CirronApi.prototype.uploadFile).toHaveBeenCalledTimes(1);
    });

    it("uploads every part, records each etag, then completes", async () => {
      createAuthenticatedSession(tmp.dir);
      const partSize = 128 * 1024 * 1024;
      stubHugeFile("huge.bin", partSize * 3);
      stubMultipartChain({ partCount: 3, partSize });

      const partSpy = vi
        .spyOn(CirronApi.prototype, "uploadFilePart")
        .mockImplementation((_url, _fp, start) =>
          Promise.resolve(`"etag-${start}"`)
        );

      await pushCommand("./huge.bin", undefined, {});

      // Parts upload concurrently, so assert on the set, not the order.
      const requested = (
        CirronApi.prototype.getMultipartPartUrl as unknown as {
          mock: { calls: [{ partNumber: number }][] };
        }
      ).mock.calls
        .map((call) => call[0].partNumber)
        .sort((a, b) => a - b);
      expect(requested).toEqual([1, 2, 3]);
      expect(partSpy).toHaveBeenCalledTimes(3);

      const recorded = (
        CirronApi.prototype.recordMultipartPart as unknown as {
          mock: { calls: [{ partNumber: number; etag: string }][] };
        }
      ).mock.calls
        .map((call) => [call[0].partNumber, call[0].etag] as const)
        .sort((a, b) => a[0] - b[0]);
      expect(recorded).toEqual([
        [1, '"etag-0"'],
        [2, `"etag-${partSize}"`],
        [3, `"etag-${partSize * 2}"`],
      ]);

      expect(CirronApi.prototype.completeMultipartUpload).toHaveBeenCalledWith({
        sessionId: "sess-1",
      });
    });

    it("confirms with the session id, not the provider upload id", async () => {
      createAuthenticatedSession(tmp.dir);
      stubHugeFile("huge.bin", THRESHOLD * 2);
      stubMultipartChain({ partCount: 1, partSize: THRESHOLD * 2 });
      vi.spyOn(CirronApi.prototype, "uploadFilePart").mockResolvedValue(
        '"etag-1"'
      );

      await pushCommand("./huge.bin", undefined, {});

      expect(CirronApi.prototype.confirmUpload).toHaveBeenCalledWith(
        expect.objectContaining({ uploadId: "sess-1" })
      );
    });

    it("does not consult prior session progress, because init is not resumable", async () => {
      createAuthenticatedSession(tmp.dir);
      const partSize = 128 * 1024 * 1024;
      stubHugeFile("huge.bin", partSize * 3);
      stubMultipartChain({ partCount: 3, partSize });

      const sessionSpy = vi.spyOn(CirronApi.prototype, "getUploadSession");
      const partSpy = vi
        .spyOn(CirronApi.prototype, "uploadFilePart")
        .mockResolvedValue('"etag-x"');

      await pushCommand("./huge.bin", undefined, {});

      // `init` opens a fresh provider-side multipart upload every call, so a
      // prior run's parts can never be adopted. Reading session progress
      // would be a wasted round trip that always returns nothing.
      expect(sessionSpy).not.toHaveBeenCalled();
      expect(partSpy).toHaveBeenCalledTimes(3);
    });

    it("aborts the upload when a part fails", async () => {
      createAuthenticatedSession(tmp.dir);
      const partSize = 200 * 1024 * 1024;
      stubHugeFile("huge.bin", partSize * 2);
      stubMultipartChain({ partCount: 2, partSize });
      vi.spyOn(CirronApi.prototype, "uploadFilePart").mockRejectedValue(
        new Error("Part upload failed: HTTP 500 Internal Server Error")
      );
      const abortSpy = vi
        .spyOn(CirronApi.prototype, "abortMultipartUpload")
        .mockResolvedValue({ sessionId: "sess-1", aborted: true });

      let caught: unknown;
      try {
        await pushCommand("./huge.bin", undefined, {});
      } catch (err) {
        caught = err;
      }

      expect(abortSpy).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(
        CirronApi.prototype.completeMultipartUpload
      ).not.toHaveBeenCalled();
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Part upload failed/
      );
    });

    it("aborts rather than recording an empty etag", async () => {
      createAuthenticatedSession(tmp.dir);
      const partSize = 200 * 1024 * 1024;
      stubHugeFile("huge.bin", partSize * 2);
      stubMultipartChain({ partCount: 2, partSize });
      // A provider that answers 200 with no ETag header. Recording "" would
      // fail later at part-complete, whose schema requires a non-empty
      // string, surfacing as "Invalid request body" instead of the cause.
      vi.spyOn(CirronApi.prototype, "uploadFilePart").mockRejectedValue(
        new Error(
          "Part upload succeeded but the storage provider returned no ETag (part at byte 0). Multipart completion cannot proceed without it."
        )
      );
      const recordSpy = vi.spyOn(CirronApi.prototype, "recordMultipartPart");
      const abortSpy = vi
        .spyOn(CirronApi.prototype, "abortMultipartUpload")
        .mockResolvedValue({ sessionId: "sess-1", aborted: true });

      let caught: unknown;
      try {
        await pushCommand("./huge.bin", undefined, {});
      } catch (err) {
        caught = err;
      }

      expect(recordSpy).not.toHaveBeenCalled();
      expect(abortSpy).toHaveBeenCalled();
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/no ETag/);
    });

    it("surfaces the missing parts when complete reports a gap", async () => {
      createAuthenticatedSession(tmp.dir);
      const partSize = 200 * 1024 * 1024;
      stubHugeFile("huge.bin", partSize * 2);
      stubMultipartChain({ partCount: 2, partSize });
      vi.spyOn(CirronApi.prototype, "uploadFilePart").mockResolvedValue(
        '"etag-x"'
      );
      vi.spyOn(
        CirronApi.prototype,
        "completeMultipartUpload"
      ).mockRejectedValue(new Error("Upload is missing parts: 2"));
      const abortSpy = vi
        .spyOn(CirronApi.prototype, "abortMultipartUpload")
        .mockResolvedValue({ sessionId: "sess-1", aborted: true });

      let caught: unknown;
      try {
        await pushCommand("./huge.bin", undefined, {});
      } catch (err) {
        caught = err;
      }

      expect(exitCodeFromError(caught)).toBe(1);
      expect(abortSpy).toHaveBeenCalled();
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /missing parts.*2|Upload is missing parts/
      );
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
