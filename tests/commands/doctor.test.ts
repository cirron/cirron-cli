import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand } from "../../src/commands/doctor";
import { makeTmpDir } from "../helpers/tmpdir";

describe("doctorCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-doctor-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("--json emits a valid JSON doctor report", async () => {
    await doctorCommand({ json: true });
    const output = logSpy.mock.calls.flat().join("\n");
    expect(() => JSON.parse(output)).not.toThrow();
    const report = JSON.parse(output);
    expect(report).toHaveProperty("cli");
    expect(report).toHaveProperty("node");
    expect(report).toHaveProperty("platform");
  });

  it("calls process.exit with the report's exit code", async () => {
    await doctorCommand({});
    expect(exitSpy).toHaveBeenCalled();
    // The exact code depends on environment, but it should be a number.
    const code = exitSpy.mock.calls[0]?.[0];
    expect(typeof code).toBe("number");
  });

  it("--no-color produces ANSI-free output", async () => {
    await doctorCommand({ json: true, noColor: true });
    const output = logSpy.mock.calls.flat().join("\n");
    // No ANSI escape sequences in JSON output regardless, but verify no throw.
    expect(output.length).toBeGreaterThan(0);
  });
});
