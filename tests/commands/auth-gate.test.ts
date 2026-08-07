import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return { ...actual, execSync: vi.fn().mockReturnValue(""), spawn: vi.fn() };
});

vi.mock("../../src/utils/execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/utils/execution")>();
  return {
    ...actual,
    executeScript: vi.fn((command: string) =>
      Promise.resolve({
        command,
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 0,
      })
    ),
  };
});

import { execSync, spawn } from "node:child_process";
import fs from "fs-extra";
import { buildCommand } from "../../src/commands/build";
import { deployCommand } from "../../src/commands/deploy";
import { envListCommand } from "../../src/commands/env";
import { initCommand } from "../../src/commands/init";
import { logsCommand } from "../../src/commands/logs";
import { statusCommand } from "../../src/commands/status";
import { CirronApi } from "../../src/utils/api";
import { isAuthenticated } from "../../src/utils/auth-guard";
import { ConfigManager } from "../../src/utils/config";
import {
  deployment,
  exitCodeFromError,
  stubProcessExit,
} from "../helpers/mock-api";
import { writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * `cirron auth login` (device flow, the default path) stores its JWT at
 * config.auth.accessToken and never sets config.token. Six commands used to
 * gate on config.token alone, so they rejected the primary login: deploy, logs
 * and env hard-failed, while status --remote, build and init failed silently.
 *
 * These tests pin all three credential states for each of the six commands.
 * The three silent ones get positive assertions — proving the platform call
 * actually happens — because "it didn't crash" proves nothing there.
 */

const execSyncMock = vi.mocked(execSync);
const spawnMock = vi.mocked(spawn);

/** A child process that immediately emits output and closes with `code`. */
function fakeChild(code = 0) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    child.stdout.emit("data", Buffer.from("building\n"));
    child.emit("close", code);
  });
  return child as never;
}

type Credential = "device-flow" | "legacy-token" | "none";

const BASE_CONFIG = {
  apiUrl: "http://localhost:1",
  defaultEnv: "production",
  timeout: 1000,
  retries: 0,
};

/** Persist a config holding exactly one credential shape (or none). */
function saveConfig(kind: Credential): void {
  const manager = new ConfigManager();

  if (kind === "device-flow") {
    manager.save({
      ...BASE_CONFIG,
      auth: {
        accessToken: "jwt-access",
        refreshToken: "jwt-refresh",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    return;
  }

  if (kind === "legacy-token") {
    manager.save({ ...BASE_CONFIG, token: "sk-legacy" });
    return;
  }

  manager.save({ ...BASE_CONFIG });
}

describe("auth gate", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let exitStub: ReturnType<typeof stubProcessExit>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-auth-gate-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitStub = stubProcessExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    execSyncMock.mockReset();
    execSyncMock.mockReturnValue("");
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => fakeChild(0));
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  const errors = () => errorSpy.mock.calls.flat().join(" ");
  const output = () => infoSpy.mock.calls.flat().join(" ");

  describe("isAuthenticated", () => {
    it("accepts the device-flow JWT", () => {
      expect(
        isAuthenticated({
          ...BASE_CONFIG,
          auth: { accessToken: "jwt-access", refreshToken: "jwt-refresh" },
        })
      ).toBe(true);
    });

    it("accepts a legacy sk-* token", () => {
      expect(isAuthenticated({ ...BASE_CONFIG, token: "sk-legacy" })).toBe(
        true
      );
    });

    it("rejects a config with neither", () => {
      expect(isAuthenticated({ ...BASE_CONFIG })).toBe(false);
    });
  });

  describe("deploy", () => {
    function project(): void {
      writeProjectConfig(tmp.dir, { environments: { staging: {} } });
    }

    function stubDeploy() {
      vi.spyOn(CirronApi.prototype, "getDeployment").mockResolvedValue(
        deployment({ status: "success" }) as never
      );
      return vi
        .spyOn(CirronApi.prototype, "createDeployment")
        .mockResolvedValue(deployment({ status: "success" }) as never);
    }

    it("proceeds with a device-flow config", async () => {
      project();
      saveConfig("device-flow");
      const create = stubDeploy();

      await deployCommand({ env: "staging", noBuild: true });

      expect(create).toHaveBeenCalled();
      expect(errors()).not.toMatch(/auth login/);
    });

    it("proceeds with a legacy token", async () => {
      project();
      saveConfig("legacy-token");
      const create = stubDeploy();

      await deployCommand({ env: "staging", noBuild: true });

      expect(create).toHaveBeenCalled();
    });

    it("still exits 1 with no credentials", async () => {
      project();
      saveConfig("none");
      const create = stubDeploy();

      let caught: unknown;
      try {
        await deployCommand({ env: "staging", noBuild: true });
      } catch (err) {
        caught = err;
      }

      expect(exitCodeFromError(caught)).toBe(1);
      expect(errors()).toMatch(/auth login/);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("logs", () => {
    function stubLogs() {
      return vi
        .spyOn(CirronApi.prototype, "getLogs")
        .mockResolvedValue([] as never);
    }

    it("proceeds with a device-flow config", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("device-flow");
      const getLogs = stubLogs();

      await logsCommand({});

      expect(getLogs).toHaveBeenCalled();
      expect(errors()).not.toMatch(/auth login/);
    });

    it("proceeds with a legacy token", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("legacy-token");
      const getLogs = stubLogs();

      await logsCommand({});

      expect(getLogs).toHaveBeenCalled();
    });

    it("still refuses with no credentials", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("none");
      const getLogs = stubLogs();

      await logsCommand({});

      expect(errors()).toMatch(/auth login/);
      expect(getLogs).not.toHaveBeenCalled();
    });
  });

  describe("env", () => {
    function stubEnv() {
      return vi
        .spyOn(CirronApi.prototype, "getEnvironmentVariables")
        .mockResolvedValue({} as never);
    }

    it("proceeds with a device-flow config", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("device-flow");
      const getVars = stubEnv();

      await envListCommand({});

      expect(getVars).toHaveBeenCalled();
      expect(errors()).not.toMatch(/auth login/);
    });

    it("proceeds with a legacy token", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("legacy-token");
      const getVars = stubEnv();

      await envListCommand({});

      expect(getVars).toHaveBeenCalled();
    });

    it("still refuses with no credentials", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("none");
      const getVars = stubEnv();

      await envListCommand({});

      expect(errors()).toMatch(/auth login/);
      expect(getVars).not.toHaveBeenCalled();
    });
  });

  // status --remote used to return null silently: the user saw no remote
  // section and concluded nothing was deployed.
  describe("status --remote", () => {
    function stubDeployments() {
      return vi
        .spyOn(CirronApi.prototype, "getDeployments")
        .mockResolvedValue([deployment()] as never);
    }

    it("queries deployments with a device-flow config", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("device-flow");
      const getDeployments = stubDeployments();

      await statusCommand({ remote: true });

      expect(getDeployments).toHaveBeenCalled();
      expect(output()).toMatch(/Remote Status/);
    });

    it("queries deployments with a legacy token", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("legacy-token");
      const getDeployments = stubDeployments();

      await statusCommand({ remote: true });

      expect(getDeployments).toHaveBeenCalled();
    });

    it("skips the remote query with no credentials", async () => {
      writeProjectConfig(tmp.dir);
      saveConfig("none");
      const getDeployments = stubDeployments();

      await statusCommand({ remote: true });

      expect(getDeployments).not.toHaveBeenCalled();
    });
  });

  // build used to skip reporting entirely: silent data loss, no warning.
  describe("build report", () => {
    function buildableProject(): void {
      writeProjectConfig(tmp.dir, { framework: "custom" });
      const configPath = path.join(tmp.dir, "cirron.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      config.build = { outputDir: "dist", command: "echo build" };
      config.environments = { production: {} };
      fs.writeFileSync(configPath, JSON.stringify(config));
    }

    function stubReport() {
      return vi
        .spyOn(CirronApi.prototype, "reportBuild")
        .mockResolvedValue(undefined as never);
    }

    it("reports the build with a device-flow config", async () => {
      buildableProject();
      saveConfig("device-flow");
      const reportBuild = stubReport();

      await buildCommand({ env: "production" });

      expect(reportBuild).toHaveBeenCalled();
    });

    it("reports the build with a legacy token", async () => {
      buildableProject();
      saveConfig("legacy-token");
      const reportBuild = stubReport();

      await buildCommand({ env: "production" });

      expect(reportBuild).toHaveBeenCalled();
    });

    it("skips reporting with no credentials", async () => {
      buildableProject();
      saveConfig("none");
      const reportBuild = stubReport();

      await buildCommand({ env: "production" });

      expect(reportBuild).not.toHaveBeenCalled();
    });
  });

  // init used to skip registration silently AND then tell an already-logged-in
  // user to log in.
  describe("init registration", () => {
    function stubCreateProject() {
      return vi
        .spyOn(CirronApi.prototype, "createProject")
        .mockResolvedValue({ id: "model-1", name: "demo" } as never);
    }

    it("registers the project with a device-flow config", async () => {
      saveConfig("device-flow");
      const createProject = stubCreateProject();

      await initCommand("demo", { template: "custom", install: false });

      expect(createProject).toHaveBeenCalled();
    });

    it("does not tell a device-flow user to log in", async () => {
      saveConfig("device-flow");
      stubCreateProject();

      await initCommand("demo", { template: "custom", install: false });

      expect(output()).not.toMatch(/to connect to Cirron/);
    });

    it("registers the project with a legacy token", async () => {
      saveConfig("legacy-token");
      const createProject = stubCreateProject();

      await initCommand("demo", { template: "custom", install: false });

      expect(createProject).toHaveBeenCalled();
    });

    it("skips registration and shows the login tip with no credentials", async () => {
      saveConfig("none");
      const createProject = stubCreateProject();

      await initCommand("demo", { template: "custom", install: false });

      expect(createProject).not.toHaveBeenCalled();
      expect(output()).toMatch(/to connect to Cirron/);
    });
  });
});
