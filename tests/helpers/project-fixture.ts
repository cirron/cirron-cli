import path from "node:path";
import fs from "fs-extra";

interface ProjectConfigOverrides {
  artifacts?: { checkpointPath?: string; modelPath?: string };
  build?: { outputDir?: string };
  deploy?: { afterDeploy?: string[]; beforeDeploy?: string[] };
  environments?: Record<string, Record<string, unknown>>;
  framework?: string;
  name?: string;
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
  };
  fs.writeFileSync(
    path.join(dir, "cirron.json"),
    JSON.stringify(config, null, 2)
  );
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
