import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runListCommand,
  runPipelineCommand,
} from "../../src/commands/run";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("run commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-run-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("runPipelineCommand", () => {
    it("returns usage error when no pipeline name provided", async () => {
      await runPipelineCommand(undefined, {});
      const output = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(output).toMatch(/Pipeline name or ID is required|Usage:/);
    });

    it("returns early when no token is configured", async () => {
      await runPipelineCommand("my-pipeline", {});
      const output = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(output).toMatch(/Not authenticated|cirron auth login/);
    });

    it("--dry-run prints execution plan without auth", async () => {
      new ConfigManager().save({
        apiUrl: "http://localhost:1",
        defaultEnv: "production",
        timeout: 1000,
        retries: 0,
        token: "fake-token",
      });
      await runPipelineCommand("my-pipeline", { dryRun: true });
      const output = infoSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/Dry run/i);
      expect(output).toContain("my-pipeline");
    });
  });

  describe("runListCommand", () => {
    it("returns early when no token is configured", async () => {
      await runListCommand({});
      const output = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(output).toMatch(/Not authenticated|cirron auth login/);
    });
  });
});
