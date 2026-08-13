import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from "inquirer";
import { accessGetCommand, accessSetCommand } from "../../src/commands/access";
import { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

const promptMock = vi.mocked(inquirer.prompt);

const stubApi = <K extends keyof CirronApi>(method: K, value: unknown) =>
  vi.spyOn(CirronApi.prototype, method).mockResolvedValue(value as never);

const stubApiReject = <K extends keyof CirronApi>(method: K, error: Error) =>
  vi.spyOn(CirronApi.prototype, method).mockRejectedValue(error as never);

describe("access commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const output = () =>
    [...errorSpy.mock.calls.flat(), ...logSpy.mock.calls.flat()].join(" ");

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = makeTmpDir("cirron-access-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  const authenticate = () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
  };

  describe("auth gating", () => {
    it("prompts to authenticate when no token is configured", async () => {
      await accessGetCommand("dep-1");
      expect(output()).toMatch(/cirron auth login/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("get", () => {
    beforeEach(authenticate);

    it("reports the private (default) posture", async () => {
      stubApi("getDeploymentAccess", false);
      await accessGetCommand("dep-1");
      expect(output()).toMatch(/private/);
      expect(output()).toMatch(/inference key/);
    });

    it("reports the public posture", async () => {
      stubApi("getDeploymentAccess", true);
      await accessGetCommand("dep-1");
      expect(output()).toMatch(/public/);
    });
  });

  describe("set", () => {
    beforeEach(authenticate);

    it("requires exactly one of --public / --private", async () => {
      const spy = stubApi("setDeploymentAccess", true);
      exitSpy.mockImplementation(() => {
        throw new Error("__exit__");
      });
      await expect(accessSetCommand("dep-1", {})).rejects.toThrow("__exit__");
      await expect(
        accessSetCommand("dep-1", { public: true, private: true })
      ).rejects.toThrow("__exit__");
      expect(spy).not.toHaveBeenCalled();
    });

    it("goes private without a confirmation prompt", async () => {
      const spy = stubApi("setDeploymentAccess", false);
      await accessSetCommand("dep-1", { private: true });
      expect(spy).toHaveBeenCalledWith("dep-1", false);
      expect(promptMock).not.toHaveBeenCalled();
    });

    it("confirms before making a deployment public", async () => {
      const spy = stubApi("setDeploymentAccess", true);
      promptMock.mockResolvedValue({ confirm: false });
      await accessSetCommand("dep-1", { public: true });
      expect(spy).not.toHaveBeenCalled();
      expect(output()).toMatch(/cancelled/i);
    });

    it("skips the confirmation with --yes", async () => {
      const spy = stubApi("setDeploymentAccess", true);
      await accessSetCommand("dep-1", { public: true, yes: true });
      expect(spy).toHaveBeenCalledWith("dep-1", true);
      expect(promptMock).not.toHaveBeenCalled();
    });

    it("exits 1 when the platform rejects the change", async () => {
      stubApiReject(
        "setDeploymentAccess",
        new PlatformUnavailableError("offline")
      );
      await accessSetCommand("dep-1", { private: true });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
