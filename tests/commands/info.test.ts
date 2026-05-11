import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { infoCommand } from "../../src/commands/info";
import { makeTmpDir } from "../helpers/tmpdir";

describe("infoCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-info-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits with code 1 when not in a Cirron project", async () => {
    await infoCommand();
    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/Not a Cirron project/);
  });

  it("loads project config when a cirron.yaml exists (does not error on missing config)", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await infoCommand();
    // The "Not a Cirron project" branch should not have fired. infoCommand may
    // still exit 1 later (e.g. due to ModelConfigManager errors in an empty
    // project), but the first error path is the one we're guarding here.
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).not.toMatch(/Not a Cirron project/);
  });

  it("exits with code 1 on unknown --update target", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await infoCommand({ update: "bogus" });
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
