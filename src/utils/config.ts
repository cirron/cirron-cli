import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import type { CirronConfig } from "../types";

export class ConfigManager {
  private readonly configPath: string;
  private readonly defaultConfig: CirronConfig;

  constructor() {
    this.configPath = path.join(os.homedir(), ".cirron", "config.json");
    this.defaultConfig = {
      apiUrl: "https://app.cirron.com",
      defaultEnv: "production",
      timeout: 30_000,
      retries: 3,
    };
  }

  load(): CirronConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const configData = fs.readFileSync(this.configPath, "utf8");
        const config = JSON.parse(configData);

        // Merge with defaults to ensure all properties exist
        return {
          ...this.defaultConfig,
          ...config,
        };
      }
    } catch {
      // If config is corrupted, fall back to defaults
      console.warn("Warning: Could not load config file, using defaults");
    }

    return { ...this.defaultConfig };
  }

  save(config: CirronConfig): void {
    try {
      const configDir = path.dirname(this.configPath);
      fs.ensureDirSync(configDir);
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2));
    } catch (error) {
      throw new Error(`Failed to save config: ${error}`);
    }
  }

  reset(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        fs.removeSync(this.configPath);
      }
    } catch (error) {
      throw new Error(`Failed to reset config: ${error}`);
    }
  }

  getConfigPath(): string {
    return this.configPath;
  }

  exists(): boolean {
    return fs.existsSync(this.configPath);
  }
}
