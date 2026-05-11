import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  envDeleteCommand,
  envListCommand,
  envSetCommand,
} from "../../src/commands/env";
import { CirronApi } from "../../src/utils/api";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

describe("env commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-env-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // Seed a valid project + token for the happy path; tests that exercise
    // missing-config/no-auth override these.
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("envListCommand", () => {
    it("displays variables returned by the API", async () => {
      vi.spyOn(CirronApi.prototype, "getEnvironmentVariables").mockResolvedValue(
        {
          DATABASE_URL: "postgres://example",
          API_KEY: "should-be-masked",
        }
      );
      await envListCommand({});
      // No error logged on the happy path
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("reports empty when API returns no variables", async () => {
      vi.spyOn(CirronApi.prototype, "getEnvironmentVariables").mockResolvedValue(
        {}
      );
      await envListCommand({ env: "staging" });
      expect(errorSpy).not.toHaveBeenCalled();
    });

    it("handles API failure gracefully (logs error, no throw)", async () => {
      vi.spyOn(CirronApi.prototype, "getEnvironmentVariables").mockRejectedValue(
        new Error("server down")
      );
      await expect(envListCommand({})).resolves.toBeUndefined();
    });
  });

  describe("envSetCommand", () => {
    it("calls the API with key/value/environment", async () => {
      const setSpy = vi
        .spyOn(CirronApi.prototype, "setEnvironmentVariable")
        .mockResolvedValue(undefined);
      await envSetCommand("MY_KEY", "my-value", { env: "production" });
      expect(setSpy).toHaveBeenCalledWith(
        "demo",
        "production",
        "MY_KEY",
        "my-value"
      );
    });
  });

  describe("envDeleteCommand", () => {
    it("does not delete when user declines confirmation", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ confirm: false } as never);
      const deleteSpy = vi
        .spyOn(CirronApi.prototype, "deleteEnvironmentVariable")
        .mockResolvedValue(undefined);
      await envDeleteCommand("MY_KEY", {});
      expect(deleteSpy).not.toHaveBeenCalled();
    });

    it("deletes when user confirms", async () => {
      vi.spyOn(inquirer, "prompt").mockResolvedValue({ confirm: true } as never);
      const deleteSpy = vi
        .spyOn(CirronApi.prototype, "deleteEnvironmentVariable")
        .mockResolvedValue(undefined);
      await envDeleteCommand("MY_KEY", { env: "staging" });
      expect(deleteSpy).toHaveBeenCalledWith("demo", "staging", "MY_KEY");
    });
  });
});
