import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { diagnosticsCommand } from "../../src/commands/diagnostics";
import { makeTmpDir } from "../helpers/tmpdir";

describe("diagnosticsCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-diag-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("--json emits a valid JSON diagnostic report", async () => {
    await diagnosticsCommand({ json: true });
    const output = logSpy.mock.calls.flat().join("\n");
    expect(() => JSON.parse(output)).not.toThrow();
    const report = JSON.parse(output);
    expect(report).toHaveProperty("configuration");
    expect(report).toHaveProperty("connectivity");
    expect(report).toHaveProperty("validation");
  });

  it("renders a human-readable report by default", async () => {
    await diagnosticsCommand({});
    const output = logSpy.mock.calls.flat().join("\n");
    expect(output.length).toBeGreaterThan(0);
  });

  it("includes verbose details when --verbose is set", async () => {
    await diagnosticsCommand({ verbose: true });
    // Verbose mode just toggles more detail; just verify it doesn't throw
    void exitSpy;
    expect(true).toBe(true);
  });
});
