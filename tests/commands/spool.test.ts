import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import {
  spoolClearCommand,
  spoolFlushCommand,
  spoolInspectCommand,
} from "../../src/commands/spool";
import { CirronApi } from "../../src/utils/api";
import { stubProcessExit } from "../helpers/mock-api";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Verify spool inspect/flush/clear with stubbed fetch + spool dir on tmp.
 */
describe("spool commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let spoolDir: string;

  /** Write a fake spool batch file matching `<ns>-<hex>.json`. */
  function writeSpoolFile(ns: bigint, contents: string): string {
    const name = `${ns}-${"a".repeat(8)}.json`;
    const fp = path.join(spoolDir, name);
    fs.writeFileSync(fp, contents);
    return fp;
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-spool-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    spoolDir = path.join(tmp.dir, ".cirron", "spool");
    fs.ensureDirSync(spoolDir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    fetchMock.mockReset();
    // Skip backoff sleeps by default
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("spoolInspectCommand", () => {
    it("prints empty notice when spool dir has no batches", async () => {
      await spoolInspectCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No spool files/);
    });

    it("emits empty JSON when --json and no files", async () => {
      await spoolInspectCommand({ json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find((s: unknown) => typeof s === "string" && s.includes('"files"')) as
        | string
        | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "{}").files).toBe(0);
    });

    it("lists files with table format", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      writeSpoolFile(1_700_000_000_000_000_001n, "data");
      await spoolInspectCommand({});
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Spool:/);
      expect(out).toMatch(/Oldest:/);
    });

    it("emits JSON with file entries when --json", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      await spoolInspectCommand({ json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"entries"')
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      const parsed = JSON.parse(jsonArg ?? "{}");
      expect(parsed.files).toBe(1);
      expect(parsed.entries).toHaveLength(1);
    });
  });

  describe("spoolFlushCommand", () => {
    it("returns early when no spool files", async () => {
      await spoolFlushCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No spool files/);
    });

    it("returns early without auth", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      await spoolFlushCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Not authenticated/);
    });

    it("uploads each batch and removes the local file on 200", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, '{"a":1}');
      writeSpoolFile(1_700_000_000_000_000_001n, '{"b":2}');
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
        user: { email: "x" },
      } as never);

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
      } as never);

      await spoolFlushCommand({});

      expect(fs.readdirSync(spoolDir)).toHaveLength(0);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Uploaded: 2/);
    });

    it("stops on fatal 401 and reports remaining as skipped", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      writeSpoolFile(1_700_000_000_000_000_001n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      fetchMock.mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => "",
      } as never);

      await spoolFlushCommand({});

      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Auth rejected/);
      // Both files should remain since first batch failed fatally
      expect(fs.readdirSync(spoolDir)).toHaveLength(2);
    });

    it("treats 404 as fatal", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      fetchMock.mockResolvedValue({
        ok: false,
        status: 404,
        statusText: "Not Found",
        text: async () => "",
      } as never);

      await spoolFlushCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Ingest route.*not available/
      );
    });

    it("treats 400 as fatal (unrecoverable per-batch)", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        text: async () => "",
      } as never);

      await spoolFlushCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Rejected/);
    });

    it("treats unexpected non-2xx as fatal", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      fetchMock.mockResolvedValue({
        ok: false,
        status: 418,
        statusText: "I'm a teapot",
        text: async () => "",
        headers: new Map() as never,
      } as never);

      await spoolFlushCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Unexpected HTTP/);
    });

    it("counts retryable failure and continues to next batch on network error", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      writeSpoolFile(1_700_000_000_000_000_001n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      // First file: fail all 3 attempts (retryable). Second: succeed.
      const fetchSpy = fetchMock;
      fetchSpy
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => "",
        } as never);
      await spoolFlushCommand({});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Failed: 1/);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Uploaded: 1/);
    });

    it("warns when verifyAuth fails with a non-auth error and proceeds", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
        new Error("ECONNREFUSED")
      );

      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
      } as never);

      await spoolFlushCommand({});
      expect(warnSpy.mock.calls.flat().join(" ")).toMatch(/Could not verify/);
    });

    it("aborts when verifyAuth returns 401", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockRejectedValue(
        new Error("HTTP 401 unauthorized")
      );

      await spoolFlushCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Authentication invalid/
      );
    });

    it("gzips payloads above 1KB threshold", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "x".repeat(2048));
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "verifyAuth").mockResolvedValue({
        valid: true,
      } as never);

      const fetchSpy = fetchMock;
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => "",
      } as never);

      await spoolFlushCommand({});

      const headers = (
        fetchSpy.mock.calls[0]?.[1] as { headers?: Record<string, string> }
      )?.headers;
      expect(headers?.["Content-Encoding"]).toBe("gzip");
    });
  });

  describe("spoolClearCommand", () => {
    it("returns early when no spool files", async () => {
      await spoolClearCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No spool files/);
    });

    it("aborts when user declines confirmation", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        confirm: false,
      } as never);

      await spoolClearCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Cancelled/);
      expect(fs.readdirSync(spoolDir)).toHaveLength(1);
    });

    it("deletes all spool files on confirm", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      writeSpoolFile(1_700_000_000_000_000_001n, "{}");
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        confirm: true,
      } as never);

      await spoolClearCommand({});
      expect(fs.readdirSync(spoolDir)).toHaveLength(0);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Deleted 2/);
    });

    it("--force skips the confirmation prompt", async () => {
      writeSpoolFile(1_700_000_000_000_000_000n, "{}");
      const promptSpy = vi.spyOn(inquirer, "prompt");

      await spoolClearCommand({ force: true });
      expect(promptSpy).not.toHaveBeenCalled();
      expect(fs.readdirSync(spoolDir)).toHaveLength(0);
    });
  });
});
