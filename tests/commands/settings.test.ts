import os from "node:os";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsCommand } from "../../src/commands/settings";
import { settingsManager } from "../../src/utils/settings";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * settingsCommand routes by flag; settingsManager is stubbed so we exercise
 * each route (list/get/set/delete/export/import/template/explain/reset) plus
 * the interactive dispatcher.
 */
describe("settingsCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  function globalSettings() {
    return {
      general: { theme: "dark", telemetry: false },
      ui: { color: true },
      development: { verbose: false },
      cloud: { region: "us-east-1" },
      api: { token: "sk-abcdef1234567890" },
    };
  }

  function projectSettings() {
    return {
      general: { name: "demo" },
      build: { parallel: true },
      test: { coverage: false },
      deployment: { strategy: "rolling" },
    };
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-settings-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Default to "not in a project" — individual tests override.
    vi.spyOn(settingsManager, "findProjectRoot").mockReturnValue(null);
    vi.spyOn(settingsManager, "loadGlobalSettings").mockReturnValue(
      globalSettings() as never
    );
    vi.spyOn(settingsManager, "loadProjectSettings").mockReturnValue(
      null as never
    );
    vi.spyOn(settingsManager, "saveGlobalSettings").mockImplementation(
      () => undefined
    );
    vi.spyOn(settingsManager, "saveProjectSettings").mockImplementation(
      () => undefined
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("--list", () => {
    it("renders global settings sections", async () => {
      await settingsCommand({ list: true });
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Global Settings|General:|API:/);
    });

    it("--json dumps the global settings object", async () => {
      await settingsCommand({ list: true, json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes('"general"')
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
      expect(JSON.parse(jsonArg ?? "{}").general.theme).toBe("dark");
    });

    it("also lists project settings when present", async () => {
      vi.spyOn(settingsManager, "loadProjectSettings").mockReturnValue(
        projectSettings() as never
      );
      await settingsCommand({ list: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Project Settings/);
    });
  });

  describe("--get", () => {
    it("prints a global value", async () => {
      await settingsCommand({ get: "general.theme" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/dark/);
    });

    it("--json wraps the value", async () => {
      await settingsCommand({ get: "general.theme", json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find(
          (s: unknown) => typeof s === "string" && s.includes("general.theme")
        ) as string | undefined;
      expect(jsonArg).toBeTruthy();
    });

    it("reports not-found for unknown key", async () => {
      await settingsCommand({ get: "general.nope" });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/not found/);
    });
  });

  describe("--set", () => {
    it("saves a global setting", async () => {
      await settingsCommand({ set: "general.theme=light" });
      expect(settingsManager.saveGlobalSettings).toHaveBeenCalled();
    });
  });

  describe("--delete", () => {
    it("removes a global setting", async () => {
      await settingsCommand({ delete: "general.telemetry" });
      expect(settingsManager.saveGlobalSettings).toHaveBeenCalled();
    });
  });

  describe("--export / --import", () => {
    it("delegates export to settingsManager", async () => {
      const spy = vi
        .spyOn(settingsManager, "exportSettings")
        .mockImplementation(() => undefined);
      await settingsCommand({ export: "out.json" });
      expect(spy).toHaveBeenCalled();
    });

    it("delegates import to settingsManager", async () => {
      const spy = vi
        .spyOn(settingsManager, "importSettings")
        .mockImplementation(() => undefined);
      await settingsCommand({ import: "in.json" });
      expect(spy).toHaveBeenCalled();
    });

    it("import error is reported, not thrown", async () => {
      vi.spyOn(settingsManager, "importSettings").mockImplementation(() => {
        throw new Error("bad file");
      });
      await settingsCommand({ import: "in.json" });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Failed to import/);
    });
  });

  describe("--template", () => {
    it("applies a known template after confirmation", async () => {
      vi.spyOn(settingsManager, "listTemplates").mockReturnValue([
        { name: "ml-research", description: "ML research preset" },
      ] as never);
      const applySpy = vi
        .spyOn(settingsManager, "applyTemplate")
        .mockImplementation(() => undefined);
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ apply: true } as never);

      await settingsCommand({ template: "ml-research" });

      expect(applySpy).toHaveBeenCalledWith("ml-research");
    });

    it("reports unknown template", async () => {
      vi.spyOn(settingsManager, "listTemplates").mockReturnValue([
        { name: "ml-research", description: "ML research preset" },
      ] as never);
      await settingsCommand({ template: "no-such" });
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
        /Template not found/
      );
    });

    it("cancellation skips applyTemplate", async () => {
      vi.spyOn(settingsManager, "listTemplates").mockReturnValue([
        { name: "ml-research", description: "ML research preset" },
      ] as never);
      const applySpy = vi.spyOn(settingsManager, "applyTemplate");
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ apply: false } as never);

      await settingsCommand({ template: "ml-research" });

      expect(applySpy).not.toHaveBeenCalled();
    });
  });

  describe("--explain", () => {
    it("shows resolution chain", async () => {
      vi.spyOn(settingsManager, "resolveSettings").mockReturnValue({
        value: "dark",
        source: { type: "global", file: "/home/u/.cirron/settings.json" },
        overriddenBy: [{ type: "default", value: "light" }],
      } as never);

      await settingsCommand({ explain: "general.theme" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Setting Resolution|Resolution Chain/
      );
    });

    it("--json dumps the resolution object", async () => {
      vi.spyOn(settingsManager, "resolveSettings").mockReturnValue({
        value: "dark",
        source: { type: "global" },
      } as never);
      await settingsCommand({ explain: "general.theme", json: true });
      const jsonArg = infoSpy.mock.calls
        .flat()
        .find((s: unknown) => typeof s === "string" && s.includes('"value"')) as
        | string
        | undefined;
      expect(jsonArg).toBeTruthy();
    });
  });

  describe("--reset", () => {
    it("resets global settings on confirmation", async () => {
      vi.spyOn(settingsManager, "getDefaultGlobalSettings").mockReturnValue(
        globalSettings() as never
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ reset: true } as never);

      await settingsCommand({ reset: true, global: true });
      expect(settingsManager.saveGlobalSettings).toHaveBeenCalled();
    });

    it("cancellation skips the save", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ reset: false } as never);
      await settingsCommand({ reset: true, global: true });
      expect(settingsManager.saveGlobalSettings).not.toHaveBeenCalled();
    });

    it("resets project settings", async () => {
      vi.spyOn(settingsManager, "getDefaultProjectSettings").mockReturnValue(
        projectSettings() as never
      );
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ reset: true } as never);

      await settingsCommand({ reset: true, project: true });
      expect(settingsManager.saveProjectSettings).toHaveBeenCalled();
    });
  });

  describe("interactive (no flags)", () => {
    it("'list' action lists settings", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        action: "list",
      } as never);
      await settingsCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Global Settings/);
    });

    it("'reset' action triggers reset flow", async () => {
      vi.spyOn(settingsManager, "getDefaultGlobalSettings").mockReturnValue(
        globalSettings() as never
      );
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "reset" } as never)
        .mockResolvedValueOnce({ reset: true } as never);
      await settingsCommand({});
      expect(settingsManager.saveGlobalSettings).toHaveBeenCalled();
    });

    it("'export' action prompts for a path then exports", async () => {
      const spy = vi
        .spyOn(settingsManager, "exportSettings")
        .mockImplementation(() => undefined);
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "export" } as never)
        .mockResolvedValueOnce({ file: "x.json" } as never);
      await settingsCommand({});
      expect(spy).toHaveBeenCalled();
    });
  });

  it("exits 1 when an unexpected error escapes", async () => {
    vi.spyOn(settingsManager, "findProjectRoot").mockImplementation(() => {
      throw new Error("fs blew up");
    });

    let caught: unknown;
    try {
      await settingsCommand({ list: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
  });
});
