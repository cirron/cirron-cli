import os from "node:os";
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

  it("--reset removes the config file", async () => {
    const cm = new ConfigManager();
    cm.save({
      apiUrl: "http://x",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
    });
    expect(cm.exists()).toBe(true);

    await configCommand({ scope: "cli", reset: true });
    expect(new ConfigManager().exists()).toBe(false);
  });
});
