import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullCommand } from "../../src/commands/pull";
import { CirronApi } from "../../src/utils/api";
import {
  exitCodeFromError,
  pullArtifact,
  pullDownload,
  stubProcessExit,
} from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Test the pullCommand flow with mocked CirronApi:
 * auth gate, interactive stub, resource-typed pull, path-based pull,
 * conflict prompts, dry-run, --all with ignore filtering, multi-artifact rollup.
 */
describe("pullCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  // SHA-256 of the literal string "hello world"
  const HELLO_CHECKSUM =
    "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9";

  beforeEach(() => {
    tmp = makeTmpDir("cirron-pull-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    // Always redirect HOME to tmp so unauth tests don't pick up the user's real config
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

  /**
   * Stub api.downloadFile to write the literal "hello world" to the temp path
   * so the checksum verification step passes.
   */
  function stubDownload(): void {
    vi.spyOn(CirronApi.prototype, "downloadFile").mockImplementation(
      async (_url: string, dest: string) => {
        await fs.writeFile(dest, "hello world");
      }
    );
  }

  it("returns interactive stub message without API call", async () => {
    await pullCommand("model", "demo", { interactive: true } as never);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /not yet fully implemented/
    );
  });

  it("returns early when not authenticated", async () => {
    await pullCommand("model", "demo", {});
    const out = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(out).toMatch(/Not authenticated|auth login/);
  });

  it("prints usage when no resource and no --all", async () => {
    createAuthenticatedSession(tmp.dir);
    await pullCommand(undefined, undefined, {});
    const out = [
      ...infoSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(" ");
    expect(out).toMatch(/Usage|Resource type|--all/);
  });

  it("requires a name when pulling a resource type", async () => {
    createAuthenticatedSession(tmp.dir);
    await pullCommand("model", undefined, {});
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Usage:.*pull model/);
  });

  it("happy path: resource-typed pull writes the file", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "demo.pth",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    stubDownload();

    await pullCommand("model", "demo", {});

    expect(fs.existsSync(path.join(tmp.dir, "demo.pth"))).toBe(true);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("reports 'no artifact found' on empty list", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([]);
    await pullCommand("model", "demo", {});
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("dry-run prints summary and writes nothing", async () => {
    createAuthenticatedSession(tmp.dir);
    const downloadSpy = vi
      .spyOn(CirronApi.prototype, "downloadFile")
      .mockResolvedValue(undefined as never);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({ filename: "demo.pth", size: 1024 }),
    ]);

    await pullCommand("model", "demo", { dryRun: true });

    expect(downloadSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp.dir, "demo.pth"))).toBe(false);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Dry run|Total:/);
  });

  it("dry-run JSON output emits a valid JSON array", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({ filename: "demo.pth", size: 1024 }),
    ]);

    await pullCommand("model", "demo", { dryRun: true, json: true });

    // The full JSON output is passed as a single console.log argument
    const jsonArg = infoSpy.mock.calls
      .flat()
      .find((s) => typeof s === "string" && s.trim().startsWith("[")) as
      | string
      | undefined;
    expect(jsonArg).toBeTruthy();
    const parsed = JSON.parse(jsonArg ?? "[]");
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "demo-model",
      filename: "demo.pth",
    });
  });

  it("skips when destination exists and user declines overwrite", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "demo.pth", "existing content");
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "demo.pth",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    const downloadSpy = vi
      .spyOn(CirronApi.prototype, "downloadFile")
      .mockResolvedValue(undefined as never);
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      overwrite: false,
    } as never);

    await pullCommand("model", "demo", {});

    expect(downloadSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmp.dir, "demo.pth"), "utf-8")).toBe(
      "existing content"
    );
  });

  it("--force overwrites without prompting", async () => {
    createAuthenticatedSession(tmp.dir);
    writeFileAt(tmp.dir, "demo.pth", "old");
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "demo.pth",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    stubDownload();
    const promptSpy = vi.spyOn(inquirer, "prompt");

    await pullCommand("model", "demo", { force: true });

    expect(promptSpy).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmp.dir, "demo.pth"), "utf-8")).toBe(
      "hello world"
    );
  });

  it("exits 1 on checksum mismatch and removes the temp file", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({ filename: "demo.pth", checksum: "deadbeef", size: 11 }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    stubDownload();

    let caught: unknown;
    try {
      await pullCommand("model", "demo", {});
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Checksum mismatch/);
    expect(fs.existsSync(path.join(tmp.dir, "demo.pth.tmp"))).toBe(false);
  });

  it("path-based pull writes the file", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "weights.bin",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    stubDownload();

    await pullCommand("artifacts/weights.bin", undefined, {});

    expect(fs.existsSync(path.join(tmp.dir, "weights.bin"))).toBe(true);
  });

  it("rejects a server-supplied filename that escapes the output directory", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "../escape.txt",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    const downloadSpy = vi.spyOn(CirronApi.prototype, "downloadFile");

    let caught: unknown;
    try {
      await pullCommand("model", "evil", {});
    } catch (err) {
      caught = err;
    }

    expect(exitCodeFromError(caught)).toBe(1);
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmp.dir, "..", "escape.txt"))).toBe(false);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/unsafe filename/);
  });

  it("path-based pull surfaces 'no artifact found'", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([]);
    await pullCommand("missing/path.bin", undefined, {});
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("--json emits PullResult after success", async () => {
    createAuthenticatedSession(tmp.dir);
    vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
      pullArtifact({
        filename: "demo.pth",
        checksum: HELLO_CHECKSUM,
        size: 11,
      }),
    ]);
    vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
      pullDownload()
    );
    stubDownload();

    await pullCommand("model", "demo", { json: true });

    const jsonLine = infoSpy.mock.calls
      .flat()
      .find((s) => typeof s === "string" && s.includes('"verified"')) as
      | string
      | undefined;
    expect(jsonLine).toBeTruthy();
    expect(JSON.parse(jsonLine ?? "{}").verified).toBe(true);
  });

  describe("--all", () => {
    it("requires a project config", async () => {
      createAuthenticatedSession(tmp.dir);
      await pullCommand(undefined, undefined, { all: true });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/No cirron config/);
    });

    it("reports 'no artifacts found' on empty result", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([]);
      await pullCommand(undefined, undefined, { all: true });
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("counts an unsafe filename as one failure and still pulls the rest", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({
          id: "evil",
          name: "evil",
          filename: "../escape.txt",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
        pullArtifact({
          id: "good",
          name: "good",
          filename: "good.pth",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
      ]);
      vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
        pullDownload()
      );
      stubDownload();

      let caught: unknown;
      try {
        await pullCommand(undefined, undefined, { all: true });
      } catch (err) {
        caught = err;
      }

      // The safe artifact still lands; the hostile one is counted failed.
      expect(fs.existsSync(path.join(tmp.dir, "good.pth"))).toBe(true);
      expect(fs.existsSync(path.join(tmp.dir, "..", "escape.txt"))).toBe(false);
      expect(exitCodeFromError(caught)).toBe(1);
    });

    it("filters artifacts by --ignore patterns", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({ id: "a1", filename: "skip-me.txt" }),
        pullArtifact({ id: "a2", filename: "skip-me-too.log" }),
      ]);

      await pullCommand(undefined, undefined, {
        all: true,
        ignore: "*.txt,*.log",
      });

      // All artifacts excluded; no exit
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("dry-run lists all matching artifacts", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({ id: "a1", filename: "weights.bin", size: 100 }),
        pullArtifact({ id: "a2", filename: "labels.json", size: 50 }),
      ]);

      await pullCommand(undefined, undefined, { all: true, dryRun: true });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Total: 2/);
    });

    it("pulls all artifacts successfully and prints summary", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({
          id: "a1",
          filename: "one.bin",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
        pullArtifact({
          id: "a2",
          filename: "two.bin",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
      ]);
      vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
        pullDownload()
      );
      stubDownload();

      await pullCommand(undefined, undefined, { all: true, force: true });

      expect(fs.existsSync(path.join(tmp.dir, "one.bin"))).toBe(true);
      expect(fs.existsSync(path.join(tmp.dir, "two.bin"))).toBe(true);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Pull summary/);
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("exits 1 when at least one artifact fails", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({
          id: "good",
          filename: "good.bin",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
        pullArtifact({
          id: "bad",
          filename: "bad.bin",
          checksum: "wrong-checksum",
          size: 11,
        }),
      ]);
      vi.spyOn(CirronApi.prototype, "getPullDownloadUrl").mockResolvedValue(
        pullDownload()
      );
      stubDownload();

      let caught: unknown;
      try {
        await pullCommand(undefined, undefined, { all: true, force: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Failed:/);
    });

    it("exits 1 when project artifact fetch itself fails", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockRejectedValue(
        new Error("server exploded")
      );

      let caught: unknown;
      try {
        await pullCommand(undefined, undefined, { all: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });

    it("--all skips files when destination exists and overwrite declined", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "one.bin", "exists");
      vi.spyOn(CirronApi.prototype, "getPullArtifacts").mockResolvedValue([
        pullArtifact({
          id: "a1",
          filename: "one.bin",
          checksum: HELLO_CHECKSUM,
          size: 11,
        }),
      ]);
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        overwrite: false,
      } as never);
      const downloadSpy = vi
        .spyOn(CirronApi.prototype, "downloadFile")
        .mockResolvedValue(undefined as never);

      await pullCommand(undefined, undefined, { all: true });

      expect(downloadSpy).not.toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Skipped:/);
    });
  });
});
