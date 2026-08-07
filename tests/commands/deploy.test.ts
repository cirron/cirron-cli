import child_process from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Namespace import required so vi.spyOn can stub buildCommand.
// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn on named export
import * as buildModule from "../../src/commands/build";
import { deployCommand } from "../../src/commands/deploy";
import { CirronApi } from "../../src/utils/api";
import {
  deployment,
  exitCodeFromError,
  stubProcessExit,
} from "../helpers/mock-api";
import { writeProjectConfig } from "../helpers/project-fixture";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * Verifies the deployCommand flow end-to-end with mocked CirronApi:
 * gates (no config / no auth / unknown env), production confirmation,
 * build sub-call, pre/post-deploy hooks, polling loop, success/failed
 * branches, and the rollback path.
 */
describe("deployCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-deploy-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    // Redirect HOME so the auth gate reads the tmp config, never the
    // developer's real ~/.cirron/config.json.
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(buildModule, "buildCommand").mockResolvedValue(undefined as never);
    vi.spyOn(child_process, "execSync").mockReturnValue(Buffer.from(""));
    // Speed up polling
    vi.spyOn(global, "setTimeout").mockImplementation(((cb: () => void) => {
      cb();
      return 0 as unknown as NodeJS.Timeout;
    }) as never);
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("exits 1 when no project config exists", async () => {
    let caught: unknown;
    try {
      await deployCommand({ env: "production" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/cirron init/);
  });

  it("exits 1 when not authenticated", async () => {
    writeProjectConfig(tmp.dir);
    let caught: unknown;
    try {
      await deployCommand({ env: "production" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/auth login/);
  });

  it("exits 1 when target environment is not declared", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
    });

    let caught: unknown;
    try {
      await deployCommand({ env: "production" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Available environments.*staging/
    );
  });

  it("aborts cleanly when production confirmation is declined", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { production: { region: "us-east-1" } },
    });
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      confirm: false,
    } as never);

    await deployCommand({ env: "production" });

    expect(exitStub.spy).not.toHaveBeenCalled();
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/cancelled/i);
  });

  it("runs build, hooks, polls to success, prints URL", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { production: { region: "us-east-1" } },
      build: { outputDir: "build-output" },
      deploy: {
        beforeDeploy: ["echo before"],
        afterDeploy: ["echo after"],
      },
    });
    fs.ensureDirSync(path.join(tmp.dir, "build-output"));

    const create = vi
      .spyOn(CirronApi.prototype, "createDeployment")
      .mockResolvedValue(deployment({ id: "dep-42", status: "pending" }));
    const get = vi
      .spyOn(CirronApi.prototype, "getDeployment")
      .mockResolvedValueOnce(deployment({ id: "dep-42", status: "building" }))
      .mockResolvedValueOnce(deployment({ id: "dep-42", status: "deploying" }))
      .mockResolvedValueOnce(
        deployment({
          id: "dep-42",
          status: "success",
          completedAt: new Date(Date.now() + 30_000).toISOString(),
          url: "https://demo.cirron.dev",
        })
      );

    await deployCommand({ env: "production", force: true });

    expect(create).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledTimes(3);
    expect(buildModule.buildCommand).toHaveBeenCalledWith({
      env: "production",
      clean: true,
    });
    const stdout = infoSpy.mock.calls.flat().join(" ");
    expect(stdout).toMatch(/https:\/\/demo\.cirron\.dev/);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("exits 1 when build output directory is missing after build", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
      build: { outputDir: "missing-dir" },
    });

    let caught: unknown;
    try {
      await deployCommand({ env: "staging" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Build output not found|missing-dir/
    );
  });

  it("propagates build failure and exits", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
    });
    vi.spyOn(buildModule, "buildCommand").mockRejectedValue(
      new Error("build broke")
    );

    let caught: unknown;
    try {
      await deployCommand({ env: "staging" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/build broke/);
  });

  it("propagates pre-deploy hook failure", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
      deploy: { beforeDeploy: ["fail-cmd"] },
    });
    vi.spyOn(child_process, "execSync").mockImplementation(() => {
      throw new Error("hook failed");
    });

    let caught: unknown;
    try {
      await deployCommand({ env: "staging" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(
      /Command failed|fail-cmd/
    );
  });

  it("treats post-deploy hook failure as non-fatal warning", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
      deploy: { afterDeploy: ["fail-cmd"] },
    });
    vi.spyOn(CirronApi.prototype, "createDeployment").mockResolvedValue(
      deployment({ id: "dep-42", status: "pending" })
    );
    vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
      deployment({ id: "dep-42", status: "success" })
    );
    vi.spyOn(child_process, "execSync").mockImplementation(() => {
      throw new Error("post-hook failed");
    });

    await deployCommand({ env: "staging" });

    const warns = warnSpy.mock.calls.flat().join(" ");
    const errors = errorSpy.mock.calls.flat().join(" ");
    expect(warns + errors).toMatch(/Post-deploy command failed/);
    expect(exitStub.spy).not.toHaveBeenCalled();
  });

  it("exits 1 when deployment ends in failed state and prints recent logs", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
    });
    vi.spyOn(CirronApi.prototype, "createDeployment").mockResolvedValue(
      deployment({ id: "dep-42", status: "pending" })
    );
    vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
      deployment({
        id: "dep-42",
        status: "failed",
        logs: ["build failed at step 2", "see ya"],
      })
    );

    let caught: unknown;
    try {
      await deployCommand({ env: "staging" });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
      /build failed at step 2/
    );
  });

  it("times out after exhausting polling attempts", async () => {
    createAuthenticatedSession(tmp.dir);
    writeProjectConfig(tmp.dir, {
      environments: { staging: { region: "us-east-1" } },
    });
    vi.spyOn(CirronApi.prototype, "createDeployment").mockResolvedValue(
      deployment({ id: "dep-42", status: "pending" })
    );
    vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
      deployment({ id: "dep-42", status: "building" })
    );

    let caught: unknown;
    try {
      await deployCommand({ env: "staging", noBuild: true });
    } catch (err) {
      caught = err;
    }
    expect(exitCodeFromError(caught)).toBe(1);
    expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/timed out/);
  });

  describe("rollback", () => {
    it("aborts when fewer than 2 successful deployments exist", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir, {
        environments: { staging: { region: "us-east-1" } },
      });
      vi.spyOn(CirronApi.prototype, "getDeployments").mockResolvedValue([
        deployment({ id: "dep-current" }),
      ]);

      await deployCommand({ env: "staging", rollback: true, force: true });

      expect(errorSpy.mock.calls.flat().join(" ")).toMatch(/Cannot rollback/);
      expect(exitStub.spy).not.toHaveBeenCalled();
    });

    it("aborts when user declines the prompt", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir, {
        environments: { staging: { region: "us-east-1" } },
      });
      vi.spyOn(CirronApi.prototype, "getDeployments").mockResolvedValue([
        deployment({ id: "dep-current" }),
        deployment({ id: "dep-prev", message: "previous good build" }),
      ]);
      vi.spyOn(inquirer, "prompt").mockResolvedValue({
        confirm: false,
      } as never);

      await deployCommand({ env: "staging", rollback: true });

      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(/Rollback cancelled/);
    });

    it("rolls back successfully and prints rollback URL", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir, {
        environments: { staging: { region: "us-east-1" } },
      });
      vi.spyOn(CirronApi.prototype, "getDeployments").mockResolvedValue([
        deployment({ id: "dep-current" }),
        deployment({ id: "dep-prev" }),
      ]);
      const rollbackSpy = vi
        .spyOn(CirronApi.prototype, "rollbackDeployment")
        .mockResolvedValue(
          deployment({ id: "dep-rollback", status: "pending" })
        );
      vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
        deployment({
          id: "dep-rollback",
          status: "success",
          url: "https://prev.demo.cirron.dev",
        })
      );

      await deployCommand({ env: "staging", rollback: true, force: true });

      expect(rollbackSpy).toHaveBeenCalledWith("demo", "staging", "dep-prev");
      expect(infoSpy.mock.calls.flat().join(" ")).toMatch(
        /prev\.demo\.cirron\.dev/
      );
    });

    it("exits 1 when rollback ends in failed state", async () => {
      createAuthenticatedSession(tmp.dir);
      writeProjectConfig(tmp.dir, {
        environments: { staging: { region: "us-east-1" } },
      });
      vi.spyOn(CirronApi.prototype, "getDeployments").mockResolvedValue([
        deployment({ id: "dep-current" }),
        deployment({ id: "dep-prev" }),
      ]);
      vi.spyOn(CirronApi.prototype, "rollbackDeployment").mockResolvedValue(
        deployment({ id: "dep-rollback", status: "pending" })
      );
      vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
        deployment({ id: "dep-rollback", status: "failed" })
      );

      let caught: unknown;
      try {
        await deployCommand({ env: "staging", rollback: true, force: true });
      } catch (err) {
        caught = err;
      }
      expect(exitCodeFromError(caught)).toBe(1);
    });
  });
});
