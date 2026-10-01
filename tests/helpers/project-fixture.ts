import path from "node:path";
import fs from "fs-extra";

interface ProjectConfigOverrides {
  artifacts?: { checkpointPath?: string; modelPath?: string };
  build?: { outputDir?: string };
  deploy?: { afterDeploy?: string[]; beforeDeploy?: string[] };
  environments?: Record<string, Record<string, unknown>>;
  framework?: string;
  hardware?: Record<string, unknown>;
  name?: string;
  platform?: string;
  pythonVersion?: string;
  type?: string;
  version?: string;
}

/**
 * Drop a minimal valid cirron.json into `dir`. Commands that read project
 * config (via loadProjectConfig) will pick this up.
 */
export function writeProjectConfig(
  dir: string,
  overrides: ProjectConfigOverrides = {}
): void {
  const config = {
    name: overrides.name ?? "demo",
    framework: overrides.framework ?? "custom",
    pythonVersion: overrides.pythonVersion ?? "3.10",
    type: overrides.type ?? "model",
    version: overrides.version ?? "0.1.0",
    ...(overrides.artifacts ? { artifacts: overrides.artifacts } : {}),
    ...(overrides.environments ? { environments: overrides.environments } : {}),
    ...(overrides.build ? { build: overrides.build } : {}),
    ...(overrides.deploy ? { deploy: overrides.deploy } : {}),
    ...(overrides.platform ? { platform: overrides.platform } : {}),
    ...(overrides.hardware ? { hardware: overrides.hardware } : {}),
  };
  fs.writeFileSync(
    path.join(dir, "cirron.json"),
    JSON.stringify(config, null, 2)
  );
}

/** The hardware block the "Apple Silicon" preset in `cirron hardware` writes. */
export function appleSiliconHardware(): Record<string, unknown> {
  return {
    type: "gpu",
    architecture: "arm64",
    specifications: {
      cpu: { cores: 8, model: "Apple Silicon", architecture: "arm64" },
      gpu: { model: "Apple GPU", memory: "Unified Memory", drivers: "Metal" },
    },
    compatibility: { pytorch: true, tensorflow: true, sklearn: true },
  };
}

/** Create a real on-disk file with the given contents (for checksum tests). */
export function writeFileAt(
  dir: string,
  relPath: string,
  contents: string
): string {
  const full = path.join(dir, relPath);
  fs.ensureDirSync(path.dirname(full));
  fs.writeFileSync(full, contents);
  return full;
}
