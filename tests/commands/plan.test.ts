import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  planBuildCommand,
  planCompileCommand,
  planLintCommand,
  planTestCommand,
} from "../../src/commands/plan";
import { makeTmpDir } from "../helpers/tmpdir";

describe("plan subcommands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-plan-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it.each([
    ["planCompileCommand", planCompileCommand],
    ["planBuildCommand", planBuildCommand],
    ["planLintCommand", planLintCommand],
    ["planTestCommand", planTestCommand],
  ])(
    "%s exits when no cirron config exists",
    async (_name, fn) => {
      await fn({});
      expect(exitSpy).toHaveBeenCalled();
      // First exit indicates the missing-config branch
      const firstCall = exitSpy.mock.calls[0]?.[0];
      expect(firstCall).not.toBe(0);
    }
  );

  it("planCompileCommand progresses past config check when cirron.yaml exists", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await planCompileCommand({ arch: "cpu" });
    // First exit (if any) is not the PROJECT_NOT_FOUND code 31
    const firstCall = exitSpy.mock.calls[0]?.[0];
    expect(firstCall).not.toBe(31);
  });
});
