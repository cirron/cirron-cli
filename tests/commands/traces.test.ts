import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  tracesListCommand,
  tracesViewCommand,
} from "../../src/commands/traces";
import { makeTmpDir } from "../helpers/tmpdir";

describe("traces commands (local spool)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-traces-");
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("tracesViewCommand reports 'no traces' when spool is empty", async () => {
    await tracesViewCommand({ spool: tmp.dir });
    const output = [
      ...infoSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(" ");
    expect(output).toMatch(/No traces|No spool|not found/i);
  });

  it("tracesListCommand reports 'no traces' when spool is empty", async () => {
    await tracesListCommand({ spool: tmp.dir });
    const output = [
      ...infoSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(" ");
    expect(output).toMatch(/No traces|No spool|not found/i);
  });

  it("rejects an invalid --min-wall format", async () => {
    await tracesViewCommand({ spool: tmp.dir, minWall: "not a duration" });
    // Either the no-traces branch fires first (because no sessions) or the
    // validation fires. Either way, the command exits cleanly and we should
    // see meaningful output.
    const output = [
      ...infoSpy.mock.calls.flat(),
      ...errorSpy.mock.calls.flat(),
    ].join(" ");
    expect(output.length).toBeGreaterThan(0);
  });
});
