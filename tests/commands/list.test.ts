import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listCommand } from "../../src/commands/list";
import { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("listCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let infoSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-list-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("input validation", () => {
    it("prints help when no resource is provided", async () => {
      await listCommand("", {});
      const output = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(output).toMatch(/Available resources/);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("rejects unknown resource", async () => {
      await listCommand("widgets", {});
      const output = errorSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/Unknown resource/);
    });
  });

  describe("auth gating", () => {
    it("prompts to authenticate when no token is configured", async () => {
      await listCommand("deployments", {});
      const output = [
        ...errorSpy.mock.calls.flat(),
        ...infoSpy.mock.calls.flat(),
      ].join(" ");
      expect(output).toMatch(/cirron auth login/);
      // Returns early — no API call, no exit
      expect(exitSpy).not.toHaveBeenCalled();
    });
  });

  describe("happy paths (mocked API)", () => {
    beforeEach(() => {
      new ConfigManager().save({
        apiUrl: "http://localhost:1",
        defaultEnv: "production",
        timeout: 1000,
        retries: 0,
        token: "fake-token",
      });
    });

    it("deployments: --json emits JSON array of deployments", async () => {
      vi.spyOn(
        CirronApi.prototype,
        "getDeploymentExecutions"
      ).mockResolvedValue([
        {
          id: "deploy-id-very-long-string",
          status: "COMPLETED",
          environment: "production",
          createdAt: new Date().toISOString(),
        },
      ] as never);

      await listCommand("deployments", { json: true });
      const output = infoSpy.mock.calls.flat().join("\n");
      const match = output.match(/\[[\s\S]*\]/);
      expect(match).not.toBeNull();
      const parsed = JSON.parse(match![0]);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].status).toBe("COMPLETED");
    });

    it("deployments: prints 'No deployments found' on empty result", async () => {
      vi.spyOn(
        CirronApi.prototype,
        "getDeploymentExecutions"
      ).mockResolvedValue([] as never);

      await listCommand("deployments", {});
      const output = infoSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/No deployments found/);
    });

    it("builds: returns 'No builds found' on empty result", async () => {
      vi.spyOn(CirronApi.prototype, "getBuilds").mockResolvedValue([] as never);
      await listCommand("builds", {});
      const output = infoSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/No builds found/);
    });

    it("models: returns 'No models found' on empty result", async () => {
      vi.spyOn(
        CirronApi.prototype,
        "getModelInstances"
      ).mockResolvedValue([] as never);
      await listCommand("models", {});
      const output = infoSpy.mock.calls.flat().join(" ");
      expect(output).toMatch(/No models found/);
    });
  });

  describe("graceful platform errors", () => {
    beforeEach(() => {
      new ConfigManager().save({
        apiUrl: "http://localhost:1",
        defaultEnv: "production",
        timeout: 1000,
        retries: 0,
        token: "fake-token",
      });
    });

    it.each([
      ["deployments", "getDeploymentExecutions"],
      ["builds", "getBuilds"],
      ["models", "getModelInstances"],
      ["images", "getModelImages"],
      ["registry", "getRegistryArtifacts"],
    ])(
      "%s exits with code 3 when platform is unreachable",
      async (resource, methodName) => {
        vi.spyOn(
          CirronApi.prototype,
          methodName as keyof CirronApi
        ).mockRejectedValue(new PlatformUnavailableError("offline"));

        await listCommand(resource, {});

        expect(exitSpy).toHaveBeenCalledWith(3);
        const stderr = errorSpy.mock.calls.flat().join(" ");
        expect(stderr).toMatch(/private preview/i);
      }
    );
  });
});
