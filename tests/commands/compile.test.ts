import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compileCommand } from "../../src/commands/compile";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * compileCommand has a top-level catch that converts unknown errors into
 * "recoverable" CLI errors, so a throwing process.exit stub gets swallowed.
 * Instead, we spy on process.exit as a no-op and record all codes it was
 * called with — then assert the first call matches our expectation.
 */
describe("compileCommand entry-point error paths", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-compile-");
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

  it("calls process.exit with PROJECT_NOT_FOUND (31) when no cirron config exists in cwd", async () => {
    await compileCommand({});
    // First exit call should be the project-not-found path. CLIErrorCode.PROJECT_NOT_FOUND = 31.
    expect(exitSpy).toHaveBeenCalled();
    const firstCallArg = exitSpy.mock.calls[0]?.[0];
    expect(firstCallArg).toBe(31);
  });

  it("does not trigger the project-not-found exit when a cirron.yaml exists", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );

    await compileCommand({ arch: "cpu" });

    // The first exit call (if any) should not be code 31 (PROJECT_NOT_FOUND).
    // It may exit later with a different code due to no Python files, but
    // the missing-config branch should not have been the cause.
    const firstCallArg = exitSpy.mock.calls[0]?.[0];
    expect(firstCallArg).not.toBe(31);
  });
});
