import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runCancelCommand,
  runInferenceCommand,
  runJobCommand,
  runListCommand,
  runLogsCommand,
  runPipelineCommand,
  runStatusCommand,
  runSweepCommand,
} from "../../src/commands/run";
import { CirronApi } from "../../src/utils/api";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Cover the run subcommand tree with mocked CirronApi:
 * pipeline trigger (dry-run, happy, watch, error), list, status (with watch),
 * cancel, logs (with follow setup), and the not-implemented stubs.
 */
describe("run commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  function runInfo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "run-1",
      type: "pipeline",
      status: "PENDING",
      pipeline: { id: "p-1", name: "demo-pipeline" },
      gpu: undefined,
      priority: undefined,
      tags: undefined,
      duration: undefined,
      createdAt: new Date().toISOString(),
      ...overrides,
    } as never;
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-run-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Speed up monitorRun polling
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

  describe("runPipelineCommand", () => {
    it("prints usage when no name is given", async () => {
      await runPipelineCommand(undefined, {});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /name or ID is required/
      );
    });

    it("returns early without auth", async () => {
      await runPipelineCommand("demo", {});
      const out = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(out).toMatch(/Not authenticated|auth login/);
    });

    it("dry-run prints plan and skips API call", async () => {
      createAuthenticatedSession(tmp.dir);
      const triggerSpy = vi.spyOn(CirronApi.prototype, "triggerPipelineRun");

      await runPipelineCommand("demo", {
        dryRun: true,
        gpu: "a100",
        priority: "high",
        tag: "exp,baseline",
      });

      expect(triggerSpy).not.toHaveBeenCalled();
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Dry run/);
      expect(out).toMatch(/a100/);
    });

    it("dry-run with --config loads pipeline file (yaml)", async () => {
      createAuthenticatedSession(tmp.dir);
      fs.writeFileSync(
        path.join(tmp.dir, "pipeline.yaml"),
        "steps:\n  - name: train\n    command: python train.py\n    resources:\n      gpu: a100\nparameters:\n  epochs: 10\n"
      );

      await runPipelineCommand("demo", {
        dryRun: true,
        config: "pipeline.yaml",
      });

      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Steps:/);
      expect(out).toMatch(/train/);
      expect(out).toMatch(/Parameters:/);
    });

    it("returns when --config file does not exist", async () => {
      createAuthenticatedSession(tmp.dir);
      await runPipelineCommand("demo", { config: "missing.yaml" });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Failed to load config/
      );
    });

    it("happy path triggers run without watch", async () => {
      createAuthenticatedSession(tmp.dir);
      const triggerSpy = vi
        .spyOn(CirronApi.prototype, "triggerPipelineRun")
        .mockResolvedValue(
          runInfo({ id: "run-42", status: "PENDING", gpu: "a100" })
        );

      await runPipelineCommand("demo", { gpu: "a100", priority: "high" });

      expect(triggerSpy).toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/run-42/);
    });

    it("watch mode reaches COMPLETED and prints duration", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "triggerPipelineRun").mockResolvedValue(
        runInfo({ id: "run-42", status: "PENDING" })
      );
      vi.spyOn(CirronApi.prototype, "getRun")
        .mockResolvedValueOnce(runInfo({ id: "run-42", status: "RUNNING" }))
        .mockResolvedValueOnce(
          runInfo({ id: "run-42", status: "COMPLETED", duration: 65 })
        );

      await runPipelineCommand("demo", { watch: true });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /completed successfully|Duration:/
      );
    });

    it("watch mode FAILED logs the run error", async () => {
      // Note: the inner watch try/catch swallows the synthetic process.exit
      // throw, so we assert on the logged error rather than the exit code.
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "triggerPipelineRun").mockResolvedValue(
        runInfo({ id: "run-42", status: "PENDING" })
      );
      vi.spyOn(CirronApi.prototype, "getRun").mockResolvedValue(
        runInfo({ id: "run-42", status: "FAILED", error: "boom" })
      );

      await runPipelineCommand("demo", { watch: true });

      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/boom/);
    });

    it("trigger failure exits 1", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "triggerPipelineRun").mockRejectedValue(
        new Error("upstream rejected")
      );

      let caught: unknown;
      try {
        await runPipelineCommand("demo", {});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/upstream rejected/);
    });
  });

  describe("runListCommand", () => {
    it("returns early without auth", async () => {
      await runListCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Not authenticated/);
    });

    it("rejects invalid --last", async () => {
      createAuthenticatedSession(tmp.dir);
      await runListCommand({ last: "not-a-number" });
      // spinner.fail goes via ora, but no exit
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("--json emits the runs array", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRuns").mockResolvedValue([
        runInfo({ id: "r1" }),
        runInfo({ id: "r2", status: "COMPLETED", duration: 30 }),
      ] as never);

      await runListCommand({ json: true });

      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.trim().startsWith("[")
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "[]")).toHaveLength(2);
    });

    it("renders table when runs are returned", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRuns").mockResolvedValue([
        runInfo({
          id: "run-very-long-identifier-1234",
          status: "COMPLETED",
          duration: 7200,
        }),
      ] as never);

      await runListCommand({
        status: "COMPLETED",
        pipeline: "demo",
        last: "1",
      });

      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Run ID|run-very-lon/);
    });

    it("reports 'no runs found' on empty list", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRuns").mockResolvedValue([] as never);

      await runListCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No runs found/);
    });

    it("logs error on getRuns failure (no exit)", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRuns").mockRejectedValue(
        new Error("api down")
      );

      await runListCommand({});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/api down/);
      expect(exitStub.spy).not.toHaveBeenCalled();
    });
  });

  describe("runStatusCommand", () => {
    it("returns early without auth", async () => {
      await runStatusCommand("run-1", {});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Not authenticated/);
    });

    it("--json emits the run", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRun").mockResolvedValue(
        runInfo({ id: "run-1", status: "COMPLETED" })
      );

      await runStatusCommand("run-1", { json: true });

      const jsonArg = infoSpy.mock.calls
        .flat()
        .find((s: unknown) => typeof s === "string" && s.includes('"run-1"')) as
        | string
        | undefined;
      expect(jsonArg).toBeTruthy();
    });

    it("renders fields including completedAt + error", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRun").mockResolvedValue(
        runInfo({
          id: "run-1",
          status: "FAILED",
          gpu: "a100",
          priority: "high",
          tags: ["exp"],
          startedAt: new Date().toISOString(),
          completedAt: new Date(Date.now() + 60_000).toISOString(),
          error: "out of memory",
        })
      );

      await runStatusCommand("run-1", {});

      const all = [
        ...infoSpy.mock.calls.flat(),
        ...errorSpy.mock.calls.flat(),
      ].join(" ");
      expect(all).toMatch(/out of memory/);
      expect(all).toMatch(/a100/);
    });

    it("watch mode polls until COMPLETED", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRun")
        .mockResolvedValueOnce(runInfo({ id: "run-1", status: "PENDING" }))
        .mockResolvedValueOnce(runInfo({ id: "run-1", status: "RUNNING" }))
        .mockResolvedValueOnce(
          runInfo({ id: "run-1", status: "COMPLETED", duration: 5 })
        );

      await runStatusCommand("run-1", { watch: true });

      // The "completed successfully" line is on the spinner; the duration is
      // logged via logger.info, which is what console.log captures.
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Duration: 5s/);
    });

    it("exits 1 on getRun failure", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRun").mockRejectedValue(
        new Error("404 not found")
      );

      let caught: unknown;
      try {
        await runStatusCommand("run-1", {});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });

  describe("runCancelCommand", () => {
    it("returns early without auth", async () => {
      await runCancelCommand("run-1", {});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Not authenticated/);
    });

    it("cancels successfully", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "cancelRun").mockResolvedValue(
        runInfo({ id: "run-1", status: "CANCELLED" })
      );

      await runCancelCommand("run-1", { force: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/CANCELLED/);
    });

    it("exits 1 on cancel failure", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "cancelRun").mockRejectedValue(
        new Error("cancel rejected")
      );

      let caught: unknown;
      try {
        await runCancelCommand("run-1", {});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });

  describe("runLogsCommand", () => {
    it("returns early without auth", async () => {
      await runLogsCommand("run-1", {});
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Not authenticated/);
    });

    it("rejects invalid --lines value", async () => {
      createAuthenticatedSession(tmp.dir);
      await runLogsCommand("run-1", { lines: "abc" });
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("renders log entries", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRunLogs").mockResolvedValue([
        {
          timestamp: new Date().toISOString(),
          level: "info",
          source: "trainer",
          message: "epoch 1 complete",
        },
      ] as never);

      await runLogsCommand("run-1", { lines: "10" });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/epoch 1 complete/);
    });

    it("reports 'no logs' on empty list", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRunLogs").mockResolvedValue(
        [] as never
      );

      await runLogsCommand("run-1", {});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/No logs available/);
    });

    it("exits 1 on logs fetch failure", async () => {
      createAuthenticatedSession(tmp.dir);
      vi.spyOn(CirronApi.prototype, "getRunLogs").mockRejectedValue(
        new Error("forbidden")
      );

      let caught: unknown;
      try {
        await runLogsCommand("run-1", {});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });

  describe("not-yet-implemented stubs", () => {
    it("runJobCommand prints stub message", async () => {
      await runJobCommand({ config: "x.yaml" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /not yet implemented/
      );
    });

    it("runInferenceCommand prints stub message", async () => {
      await runInferenceCommand("dep-1", { input: "data.json" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /not yet implemented/
      );
    });

    it("runSweepCommand prints stub message", async () => {
      await runSweepCommand({ strategy: "grid" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /not yet implemented/
      );
    });
  });
});
