import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pullCommand } from "../../src/commands/pull";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("pullCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-pull-");
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

  it("returns early with auth prompt when no token is configured", async () => {
    await pullCommand("model", "demo", {});
    const output = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(output).toMatch(/Not authenticated|cirron auth login/);
  });

  it("--interactive prints not-yet-implemented stub", async () => {
    await pullCommand("model", "demo", { interactive: true });
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/not yet fully implemented|future release/i);
  });

  it("returns usage when no resource provided and not --all", async () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
    await pullCommand(undefined, undefined, {});
    const output = [
      ...errorSpy.mock.calls.flat(),
      ...infoSpy.mock.calls.flat(),
    ].join(" ");
    expect(output).toMatch(/Resource type or path is required|Usage:/);
  });
});
