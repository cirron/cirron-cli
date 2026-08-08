import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  planBuildCommand,
  planCompareCommand,
  planCompileCommand,
  planDiffCommand,
  planLintCommand,
  planSaveCommand,
  planTestCommand,
} from "../../src/commands/plan";
import { PlanGenerator } from "../../src/utils/plan";
import { PlanDiffAnalyzer } from "../../src/utils/plan-diff";
import { PlanFormatter } from "../../src/utils/plan-formatter";
import { PlanStorage } from "../../src/utils/plan-storage";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { writeFileAt, writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * plan.ts subcommands. PlanGenerator / PlanStorage / formatters are stubbed so
 * we drive the command-level branches (gates, --save, --json, dry-run output)
 * without running the python-backed analysis.
 */
describe("plan commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  function fakePlan(command: "compile" | "build" = "compile") {
    return {
      command,
      architecture: "cpu",
      framework: "custom",
      projectName: "demo",
      pythonVersion: "3.10",
      timestamp: new Date().toISOString(),
      artifacts: [],
      buildSteps: ["init", command],
      dependencies: [],
      resources: { memoryMb: 512, diskMb: 100, estimatedSeconds: 30 },
      warnings: [],
    } as never;
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-plan-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Skip simulateCompilation / simulateBuild delays
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
    // Stub the formatters so we don't need a perfectly-shaped PlanFile
    vi.spyOn(PlanFormatter, "formatConsole").mockReturnValue("PLAN CONSOLE");
    vi.spyOn(PlanFormatter, "formatJSON").mockReturnValue('{"plan":true}');
    vi.spyOn(PlanGenerator.prototype, "generatePlan").mockResolvedValue(
      fakePlan()
    );
    vi.spyOn(PlanStorage, "savePlan").mockResolvedValue(
      "/tmp/plans/p.json" as never
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("planCompileCommand", () => {
    it("exits when no project config", async () => {
      let caught: unknown;
      try {
        await planCompileCommand({});
      } catch (err) {
        caught = err;
      }
      // PROJECT_NOT_FOUND code (non-zero)
      expect(typeof exitCodeFromError(caught)).toBe("number");
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/cirron init/);
    });

    it("generates and prints a console plan", async () => {
      writeProjectConfig(tmp.dir);
      await planCompileCommand({ arch: "cpu" });
      expect(PlanGenerator.prototype.generatePlan).toHaveBeenCalledWith(
        "compile",
        "cpu",
        null
      );
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/PLAN CONSOLE/);
    });

    it("--json prints JSON", async () => {
      writeProjectConfig(tmp.dir);
      await planCompileCommand({ arch: "cpu", json: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/"plan":true/);
    });

    it("--save persists the plan", async () => {
      writeProjectConfig(tmp.dir);
      await planCompileCommand({ arch: "cpu", save: "myplan.json" });
      expect(PlanStorage.savePlan).toHaveBeenCalled();
    });

    it("exits when --index file is missing", async () => {
      writeProjectConfig(tmp.dir);
      let caught: unknown;
      try {
        await planCompileCommand({ arch: "cpu", index: "nope.json" });
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });

    it("exits when plan generation throws", async () => {
      writeProjectConfig(tmp.dir);
      vi.spyOn(PlanGenerator.prototype, "generatePlan").mockRejectedValue(
        new Error("analysis failed")
      );
      let caught: unknown;
      try {
        await planCompileCommand({ arch: "cpu" });
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });
  });

  describe("planBuildCommand", () => {
    it("exits when no project config", async () => {
      let caught: unknown;
      try {
        await planBuildCommand({});
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });

    it("rejects non-ML projects", async () => {
      writeProjectConfig(tmp.dir, { framework: "custom" });
      let caught: unknown;
      try {
        await planBuildCommand({ arch: "cpu" });
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Specify a framework/
      );
    });

    it("generates and prints a build plan for an ML project", async () => {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      vi.spyOn(PlanGenerator.prototype, "generatePlan").mockResolvedValue(
        fakePlan("build")
      );
      await planBuildCommand({ arch: "cpu" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/PLAN CONSOLE/);
    });

    it("--json + --save", async () => {
      writeProjectConfig(tmp.dir, { framework: "pytorch" });
      vi.spyOn(PlanGenerator.prototype, "generatePlan").mockResolvedValue(
        fakePlan("build")
      );
      await planBuildCommand({ arch: "cpu", json: true, save: true });
      expect(PlanStorage.savePlan).toHaveBeenCalled();
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/"plan":true/);
    });
  });

  describe("planLintCommand", () => {
    it("exits 1 when no project config", async () => {
      let caught: unknown;
      try {
        await planLintCommand({});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });

    it("generates a lint plan and prints it", async () => {
      writeProjectConfig(tmp.dir);
      writeFileAt(tmp.dir, "src/model.py", "x = 1\n");
      await planLintCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toBeTruthy();
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("--json output", async () => {
      writeProjectConfig(tmp.dir);
      await planLintCommand({ json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.trim().startsWith("{")
        );
      expect(jsonArg).toBeTruthy();
    });

    it("--save writes a lint plan file", async () => {
      writeProjectConfig(tmp.dir);
      await planLintCommand({ save: "lint.json" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Lint plan saved/);
    });
  });

  describe("planTestCommand", () => {
    it("exits 1 when no project config", async () => {
      let caught: unknown;
      try {
        await planTestCommand({});
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });

    it("generates a test plan and prints it", async () => {
      writeProjectConfig(tmp.dir);
      await planTestCommand({});
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("--json + --save", async () => {
      writeProjectConfig(tmp.dir);
      await planTestCommand({ json: true, save: "test-plan.json" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Test plan saved/);
    });
  });

  describe("planDiffCommand", () => {
    function savedPlan() {
      return {
        plan: fakePlan(),
        metadata: { savedAt: new Date().toISOString() },
      } as never;
    }

    it("compares two valid plans (console output)", async () => {
      vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(savedPlan());
      vi.spyOn(PlanStorage, "validatePlan").mockReturnValue({
        valid: true,
        errors: [],
      });
      vi.spyOn(PlanDiffAnalyzer, "comparePlans").mockReturnValue({
        identical: false,
        changes: [],
      } as never);
      vi.spyOn(PlanDiffAnalyzer, "formatComparison").mockReturnValue("DIFF");

      await planDiffCommand("a.json", "b.json", {});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/DIFF/);
    });

    it("exits when a plan fails validation", async () => {
      vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue(savedPlan());
      vi.spyOn(PlanStorage, "validatePlan").mockReturnValue({
        valid: false,
        errors: ["bad plan"],
      });

      let caught: unknown;
      try {
        await planDiffCommand("a.json", "b.json", {});
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });

    it("exits when loadPlan throws", async () => {
      vi.spyOn(PlanStorage, "loadPlan").mockRejectedValue(
        new Error("file missing")
      );
      let caught: unknown;
      try {
        await planDiffCommand("a.json", "b.json", {});
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });
  });

  describe("planCompareCommand", () => {
    it("exits when fewer than two saved plans exist", async () => {
      vi.spyOn(PlanStorage, "listPlans").mockResolvedValue([
        { plan: fakePlan(), metadata: { savedAt: new Date().toISOString() } },
      ] as never);

      let caught: unknown;
      try {
        await planCompareCommand(undefined, undefined, {});
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/--save/);
    });

    it("with two args delegates to planDiffCommand", async () => {
      vi.spyOn(PlanStorage, "loadPlan").mockResolvedValue({
        plan: fakePlan(),
        metadata: { savedAt: new Date().toISOString() },
      } as never);
      vi.spyOn(PlanStorage, "validatePlan").mockReturnValue({
        valid: true,
        errors: [],
      });
      vi.spyOn(PlanDiffAnalyzer, "comparePlans").mockReturnValue({
        identical: true,
        changes: [],
      } as never);
      vi.spyOn(PlanDiffAnalyzer, "formatComparison").mockReturnValue("DIFF");

      await planCompareCommand("a.json", "b.json", {});

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/DIFF/);
    });
  });

  describe("planSaveCommand", () => {
    it("saves a compile plan", async () => {
      writeProjectConfig(tmp.dir);
      await planSaveCommand("compile", { arch: "cpu" });
      expect(PlanStorage.savePlan).toHaveBeenCalled();
    });

    it("exits when no project config", async () => {
      let caught: unknown;
      try {
        await planSaveCommand("compile", {});
      } catch (err) {
        caught = err;
      }
      expect(typeof exitCodeFromError(caught)).toBe("number");
    });

    it("--all creates the plans directory when it does not exist yet", async () => {
      writeProjectConfig(tmp.dir);
      // os.homedir() reads $HOME on POSIX, so this points the save path at a
      // home with no ~/.cirron/plans — the fresh-machine case. The --all branch
      // wrote lint/test plans without ensureDir, so writeJson threw here.
      const origHome = process.env.HOME;
      process.env.HOME = tmp.dir;

      try {
        await planSaveCommand("all", { all: true });

        const plansDir = path.join(tmp.dir, ".cirron", "plans");
        expect(fs.existsSync(plansDir)).toBe(true);
        const written = fs.readdirSync(plansDir);
        expect(written.some((f: string) => f.startsWith("lint-plan-"))).toBe(
          true
        );
        expect(written.some((f: string) => f.startsWith("test-plan-"))).toBe(
          true
        );
      } finally {
        process.env.HOME = origHome;
      }
    });
  });
});
