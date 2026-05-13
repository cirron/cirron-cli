import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../../../src/utils/config";
import { makeTmpDir } from "../../helpers/tmpdir";

describe("ConfigManager", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-config-");
    // Redirect ~/.cirron/config.json to the tmp dir so tests don't touch the
    // user's real config.
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  describe("load()", () => {
    it("returns defaults when no config file exists", () => {
      const config = new ConfigManager().load();
      expect(config.apiUrl).toBe("https://app.cirron.com");
      expect(config.defaultEnv).toBe("production");
      expect(config.timeout).toBe(30_000);
      expect(config.retries).toBe(3);
    });

    it("merges saved values over defaults", () => {
      const cm = new ConfigManager();
      cm.save({
        apiUrl: "http://localhost:3000",
        defaultEnv: "production",
        timeout: 30_000,
        retries: 3,
      });

      const loaded = new ConfigManager().load();
      expect(loaded.apiUrl).toBe("http://localhost:3000");
      // Defaults survive for unspecified keys
      expect(loaded.defaultEnv).toBe("production");
    });

    it("falls back to defaults when the config file is corrupted JSON", () => {
      const configDir = path.join(tmp.dir, ".cirron");
      fs.ensureDirSync(configDir);
      fs.writeFileSync(path.join(configDir, "config.json"), "{not valid json");

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {
        /* swallow */
      });

      const config = new ConfigManager().load();
      expect(config.apiUrl).toBe("https://app.cirron.com");
      expect(warnSpy).toHaveBeenCalled();
    });
  });

  describe("save()", () => {
    it("creates the .cirron directory if it doesn't exist", () => {
      const cm = new ConfigManager();
      cm.save({
        apiUrl: "http://test",
        defaultEnv: "staging",
        timeout: 1000,
        retries: 1,
      });

      const expectedPath = path.join(tmp.dir, ".cirron", "config.json");
      expect(fs.existsSync(expectedPath)).toBe(true);
    });

    it("writes pretty-printed JSON for human editability", () => {
      const cm = new ConfigManager();
      cm.save({
        apiUrl: "http://x",
        defaultEnv: "dev",
        timeout: 1,
        retries: 0,
      });

      const raw = fs.readFileSync(cm.getConfigPath(), "utf8");
      // Pretty-printed = has newlines and indentation
      expect(raw).toContain("\n");
      expect(raw).toContain("  ");
    });
  });

  describe("reset()", () => {
    it("removes the config file", () => {
      const cm = new ConfigManager();
      cm.save({
        apiUrl: "http://x",
        defaultEnv: "dev",
        timeout: 1,
        retries: 0,
      });
      expect(cm.exists()).toBe(true);

      cm.reset();
      expect(cm.exists()).toBe(false);
    });

    it("is a no-op when no config exists", () => {
      const cm = new ConfigManager();
      expect(() => cm.reset()).not.toThrow();
    });
  });

  describe("exists()", () => {
    it("returns false before any save", () => {
      expect(new ConfigManager().exists()).toBe(false);
    });

    it("returns true after save", () => {
      const cm = new ConfigManager();
      cm.save({
        apiUrl: "http://x",
        defaultEnv: "dev",
        timeout: 1,
        retries: 0,
      });
      expect(cm.exists()).toBe(true);
    });
  });
});
