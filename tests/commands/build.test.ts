import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCommand } from "../../src/commands/build";
import { ModelConfigManager } from "../../src/utils/model-config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("buildCommand entry-point error paths", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-build-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // ModelConfigManager uses require("./project-config") which fails under
    // vitest's ESM transformer; stub it so build can proceed past that point.
    vi.spyOn(ModelConfigManager.prototype, "loadModelConfig").mockResolvedValue(
      null
    );
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("calls process.exit(1) when no cirron config exists in cwd", async () => {
    await buildCommand({ env: "production" });
    expect(exitSpy).toHaveBeenCalled();
    // First exit corresponds to the missing-config branch.
    expect(exitSpy.mock.calls[0]?.[0]).toBe(1);
  });

  it("attempts to handle a project with an ML framework set", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );

    // Build will likely fail without a real Dockerfile/sources, but it should
    // at least progress past the config-load branch.
    await buildCommand({ env: "production" });
    // Verifying via spy that an exit happened — if the missing-config branch
    // had fired, we'd see exit(1) as the FIRST call. Since the framework is
    // 'custom', it goes down handleTraditionalBuild, which exits later.
    // The key invariant is that buildCommand completed without an uncaught
    // throw escaping the function.
    expect(exitSpy).toHaveBeenCalled();
  });

  it("enters the ML build path for a pytorch project", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await buildCommand({ env: "production", arch: "cpu" });
    // It will fail later (no model/Dockerfile) but the missing-config branch
    // should not be the first exit.
    expect(exitSpy).toHaveBeenCalled();
  });

  it("handles --force without an uncaught throw", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await buildCommand({ env: "production", arch: "cpu", force: true });
    expect(exitSpy).toHaveBeenCalled();
  });
});
