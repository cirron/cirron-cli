import os from "node:os";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configCommand } from "../../src/commands/config";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Tests for the `cirron config` CLI command (CLI scope).
 * The command writes to ~/.cirron/config.json; we redirect HOME to a tmp dir.
 */
describe("configCommand (cli scope)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-cmdconfig-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("--list shows current configuration including defaults", async () => {
    await configCommand({ scope: "cli", list: true });
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toContain("https://app.cirron.com");
    expect(output).toContain("production");
  });

  it("--set apiUrl=... persists the value", async () => {
    await configCommand({ scope: "cli", set: "apiUrl=http://localhost:3000" });
    expect(exitSpy).not.toHaveBeenCalled();
    const reloaded = new ConfigManager().load();
    expect(reloaded.apiUrl).toBe("http://localhost:3000");
  });

  it("--set rejects unknown keys with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "notARealKey=42" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--set rejects malformed apiUrl with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "apiUrl=not a url" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--set rejects out-of-range timeout with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "timeout=50" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--set rejects non-numeric timeout with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "timeout=abc" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--set rejects invalid defaultEnv with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "defaultEnv=banana" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--get returns the stored value", async () => {
    new ConfigManager().save({
      apiUrl: "http://staging.example",
      defaultEnv: "staging",
      timeout: 5000,
      retries: 2,
    });

    infoSpy.mockClear();
    await configCommand({ scope: "cli", get: "apiUrl" });
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toContain("http://staging.example");
  });

  it("--get on a missing key exits with 1", async () => {
    await configCommand({ scope: "cli", get: "nonexistent" });
    expect(exitSpy).toHaveBeenCalledWith(1);
    void errorSpy;
  });

  it("--reset removes the config file after user confirmation", async () => {
    const cm = new ConfigManager();
    cm.save({
      apiUrl: "http://x",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
    });
    expect(cm.exists()).toBe(true);

    vi.spyOn(inquirer, "prompt").mockResolvedValue({ confirm: true } as never);

    await configCommand({ scope: "cli", reset: true });
    expect(new ConfigManager().exists()).toBe(false);
  });

  it("--reset is cancelled when user does not confirm", async () => {
    const cm = new ConfigManager();
    cm.save({
      apiUrl: "http://x",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
    });

    vi.spyOn(inquirer, "prompt").mockResolvedValue({ confirm: false } as never);

    await configCommand({ scope: "cli", reset: true });
    expect(new ConfigManager().exists()).toBe(true);
  });

  it("--delete token clears the auth token", async () => {
    new ConfigManager().save({
      apiUrl: "http://x",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "sk-secret",
    });
    await configCommand({ scope: "cli", delete: "token" });
    expect(new ConfigManager().load().token).toBeUndefined();
  });

  it("--delete on a non-token key exits 1", async () => {
    await configCommand({ scope: "cli", delete: "apiUrl" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--get masks token values", async () => {
    new ConfigManager().save({
      apiUrl: "http://x",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "sk-supersecrettoken",
    });
    infoSpy.mockClear();
    await configCommand({ scope: "cli", get: "token" });
    const out = infoSpy.mock.calls.flat().join(" ");
    expect(out).toContain("sk-super");
    expect(out).toContain("*");
  });

  it("--set with bad format (no =) exits 1", async () => {
    await configCommand({ scope: "cli", set: "justakey" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--set rejects out-of-range retries with exit(1)", async () => {
    await configCommand({ scope: "cli", set: "retries=99" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  describe("interactive (cli scope, no operation)", () => {
    it("'list' action shows current config", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValueOnce({
        action: "list",
      } as never);
      await configCommand({ scope: "cli" });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Current Configuration/
      );
    });

    it("'apiUrl' action prompts then sets", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "apiUrl" } as never)
        .mockResolvedValueOnce({ value: "http://new.example" } as never);
      await configCommand({ scope: "cli" });
      expect(new ConfigManager().load().apiUrl).toBe("http://new.example");
    });

    it("'defaultEnv' action prompts then sets", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "defaultEnv" } as never)
        .mockResolvedValueOnce({ value: "staging" } as never);
      await configCommand({ scope: "cli" });
      expect(new ConfigManager().load().defaultEnv).toBe("staging");
    });

    it("'timeout' action prompts then sets", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "timeout" } as never)
        .mockResolvedValueOnce({ value: "20000" } as never);
      await configCommand({ scope: "cli" });
      expect(new ConfigManager().load().timeout).toBe(20_000);
    });

    it("'retries' action prompts then sets", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "retries" } as never)
        .mockResolvedValueOnce({ value: "5" } as never);
      await configCommand({ scope: "cli" });
      expect(new ConfigManager().load().retries).toBe(5);
    });

    it("'reset' action triggers the reset flow", async () => {
      new ConfigManager().save({
        apiUrl: "http://x",
        defaultEnv: "production",
        timeout: 1000,
        retries: 0,
      });
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ action: "reset" } as never)
        .mockResolvedValueOnce({ confirm: true } as never);
      await configCommand({ scope: "cli" });
      expect(new ConfigManager().exists()).toBe(false);
    });
  });

  describe("scope routing", () => {
    it("rejects an invalid --scope with exit(1)", async () => {
      // process.exit is stubbed as a no-op, so execution falls through to the
      // interactive selector — answer it so the test doesn't hang.
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        selectedScope: "cli",
        action: "list",
      } as never);
      await configCommand({ scope: "bogus" as never });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it("--scope global delegates to the settings handler (list)", async () => {
      await configCommand({ scope: "global", list: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Global Settings/);
    });

    it("--scope project delegates to the settings handler (list)", async () => {
      // Not in a project dir → warns rather than crashes.
      await configCommand({ scope: "project", list: true });
      // No exit expected.
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("no-scope --list shows both CLI and settings", async () => {
      await configCommand({ list: true });
      const out = infoSpy.mock.calls.flat().join(" ");
      expect(out).toMatch(/Current Configuration/);
      expect(out).toMatch(/Global Settings/);
    });

    it("no-scope --get walks the resolution chain via settings.explain", async () => {
      await configCommand({ get: "general.theme" });
      // settingsManager.resolveSettings runs for real; the command should
      // complete without an exit.
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("no-scope --set defaults to project scope", async () => {
      // Not in a project → settings reports "no project settings found".
      await configCommand({ set: "general.theme=light" });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("no-scope --explain delegates to settings", async () => {
      await configCommand({ explain: "general.theme" });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("no-scope --edit shows a scope selector then routes (cli)", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ selectedScope: "cli" } as never)
        .mockResolvedValueOnce({ action: "list" } as never);
      await configCommand({ edit: true });
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Current Configuration/
      );
    });

    it("no-scope --edit → global routes into the settings editor", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ selectedScope: "global" } as never)
        .mockResolvedValueOnce({ category: "general" } as never)
        .mockResolvedValueOnce({
          defaultTemplate: "custom",
          autoUpdate: true,
          telemetry: false,
          verboseLogging: false,
        } as never);
      await configCommand({ edit: true });
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("no-scope --reset (no scope) exits 1 with a hint", async () => {
      // process.exit is a no-op stub here, so execution falls through to the
      // interactive selector — answer it so the test doesn't hang.
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        selectedScope: "cli",
        action: "list",
      } as never);
      await configCommand({ reset: true });
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/require --scope/);
    });

    it("no-scope, no-operation shows the scope selector then routes", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ selectedScope: "cli" } as never)
        .mockResolvedValueOnce({ action: "list" } as never);
      await configCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /Current Configuration/
      );
    });

    it("no-scope, no-operation → global routes to settings (interactive)", async () => {
      vi.spyOn(inquirer, "prompt")
        .mockResolvedValueOnce({ selectedScope: "global" } as never)
        .mockResolvedValueOnce({ action: "list" } as never);
      await configCommand({});
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Global Settings/);
    });
  });
});
