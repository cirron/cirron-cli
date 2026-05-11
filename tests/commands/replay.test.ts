import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayCommand } from "../../src/commands/replay";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

describe("replayCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-replay-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitStub = stubProcessExit();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits with non-zero when the plan file does not exist", async () => {
    let caught: unknown;
    try {
      await replayCommand({ plan: "/nonexistent/plan.json" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).not.toBe(0);
    expect(exitCodeFromError(caught)).not.toBeNull();
  });

  it("exits with 1 when the plan file is malformed JSON", async () => {
    const planPath = path.join(tmp.dir, "bad.json");
    fs.writeFileSync(planPath, "{ not valid json");
    let caught: unknown;
    try {
      await replayCommand({ plan: planPath });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).not.toBe(0);
  });
});
