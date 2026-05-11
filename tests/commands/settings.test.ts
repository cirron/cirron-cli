import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settingsCommand } from "../../src/commands/settings";
import { makeTmpDir } from "../helpers/tmpdir";

describe("settingsCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-settings-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("--list --global --json emits valid JSON for global settings", async () => {
    await settingsCommand({ list: true, global: true, json: true });
    const output = logSpy.mock.calls.flat().join("\n");
    // Should be parseable JSON (at least one object)
    const match = output.match(/\{[\s\S]*\}/);
    expect(match).not.toBeNull();
    expect(() => JSON.parse(match![0])).not.toThrow();
  });

  it("--list --global produces human-readable section headers", async () => {
    await settingsCommand({ list: true, global: true });
    const output = logSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Global Settings/);
  });

  it("--get on a missing key does not throw uncaught", async () => {
    // The handler should either exit, return a falsy value, or print a
    // "not found" message; none of these should crash the runner.
    await expect(
      settingsCommand({ get: "nonexistent.key", global: true })
    ).resolves.toBeUndefined();
    void exitSpy;
  });
});
