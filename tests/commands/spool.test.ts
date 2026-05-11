import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  spoolClearCommand,
  spoolFlushCommand,
  spoolInspectCommand,
} from "../../src/commands/spool";
import { makeTmpDir } from "../helpers/tmpdir";

describe("spool commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-spool-");
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    infoSpy = logSpy;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("spoolInspectCommand", () => {
    it("reports 'no spool files' when directory is empty", async () => {
      await spoolInspectCommand({ dir: tmp.dir });
      const output = infoSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/No spool files found/);
    });

    it("--json on empty directory emits valid JSON with zero counts", async () => {
      await spoolInspectCommand({ dir: tmp.dir, json: true });
      const output = logSpy.mock.calls.flat().join("\n");
      // Extract the JSON object substring (logger.json pretty-prints with indents)
      const match = output.match(/\{[\s\S]*\}/);
      expect(match).not.toBeNull();
      const parsed = JSON.parse(match![0]);
      expect(parsed.files).toBe(0);
      expect(parsed.totalBytes).toBe(0);
    });
  });

  describe("spoolFlushCommand", () => {
    it("completes without throwing on empty spool dir", async () => {
      await expect(
        spoolFlushCommand({ dir: tmp.dir })
      ).resolves.toBeUndefined();
    });
  });

  describe("spoolClearCommand", () => {
    it("completes without throwing on empty spool dir", async () => {
      await expect(
        spoolClearCommand({ dir: tmp.dir, yes: true })
      ).resolves.toBeUndefined();
    });
  });
});
