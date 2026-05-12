import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/types";
import {
  detectMode,
  discoverModels,
  filterModels,
  isWorkspaceConfig,
  loadWorkspaceConfig,
  mergeWorkspaceDefaults,
} from "../../../src/utils/workspace";
import { makeTmpDir } from "../../helpers/tmpdir";

function modelConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    name: "demo",
    framework: "custom",
    type: "model",
    version: "1.0.0",
    ...overrides,
  } as ProjectConfig;
}

function writeYaml(file: string, obj: unknown): void {
  fs.ensureDirSync(path.dirname(file));
  // Minimal YAML via JSON (valid YAML subset) keeps the test dependency-free.
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

describe("mergeWorkspaceDefaults", () => {
  it("returns a copy when there are no defaults", () => {
    const model = modelConfig();
    const merged = mergeWorkspaceDefaults(undefined, model);
    expect(merged).toEqual(model);
    expect(merged).not.toBe(model);
  });

  it("shallow-merges env with the model winning on conflicts", () => {
    const merged = mergeWorkspaceDefaults(
      { env: { ENVIRONMENT: "production", REGION: "us" } },
      modelConfig({ env: { ENVIRONMENT: "staging", THRESHOLD: "0.5" } })
    );
    expect(merged.env).toEqual({
      ENVIRONMENT: "staging",
      REGION: "us",
      THRESHOLD: "0.5",
    });
  });

  it("adds env from defaults when the model has none", () => {
    const merged = mergeWorkspaceDefaults(
      { env: { ENVIRONMENT: "production" } },
      modelConfig()
    );
    expect(merged.env).toEqual({ ENVIRONMENT: "production" });
  });

  it("replaces profiling wholesale when the model defines its own", () => {
    const merged = mergeWorkspaceDefaults(
      { profiling: { snapshots: "stats", flush_interval: 1.0 } },
      modelConfig({ profiling: { snapshots: "sampled" } })
    );
    expect(merged.profiling).toEqual({ snapshots: "sampled" });
  });

  it("uses default profiling when the model has none", () => {
    const merged = mergeWorkspaceDefaults(
      { profiling: { snapshots: "stats" } },
      modelConfig()
    );
    expect(merged.profiling).toEqual({ snapshots: "stats" });
  });

  it("only fills other default keys the model does not set", () => {
    const merged = mergeWorkspaceDefaults(
      { description: "shared", type: "from-default" } as never,
      modelConfig({ description: "model-own" })
    );
    expect(merged.description).toBe("model-own");
    expect(merged.type).toBe("model");
  });
});

describe("isWorkspaceConfig", () => {
  it("detects a workspace key", () => {
    expect(isWorkspaceConfig({ workspace: { name: "x", models: [] } })).toBe(
      true
    );
  });
  it("rejects a plain model config", () => {
    expect(isWorkspaceConfig({ name: "demo", framework: "custom" })).toBe(
      false
    );
  });
  it("rejects non-objects and a non-object workspace value", () => {
    expect(isWorkspaceConfig(null)).toBe(false);
    expect(isWorkspaceConfig("workspace")).toBe(false);
    expect(isWorkspaceConfig({ workspace: "nope" })).toBe(false);
  });
});

describe("loadWorkspaceConfig / detectMode", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-ws-");
  });
  afterEach(() => tmp.cleanup());

  it("returns null when there is no cirron config", () => {
    expect(loadWorkspaceConfig(tmp.dir)).toBeNull();
    expect(detectMode(tmp.dir)).toEqual({ mode: "none" });
  });

  it("returns null when the cirron config has no workspace key", () => {
    writeYaml(path.join(tmp.dir, "cirron.json"), modelConfig());
    expect(loadWorkspaceConfig(tmp.dir)).toBeNull();
    const detected = detectMode(tmp.dir);
    expect(detected.mode).toBe("single");
  });

  it("loads a workspace config and reports monorepo mode", () => {
    writeYaml(path.join(tmp.dir, "cirron.json"), {
      workspace: { name: "ml-models", models: [{ path: "models/a" }] },
    });
    const ws = loadWorkspaceConfig(tmp.dir);
    expect(ws?.config.workspace.name).toBe("ml-models");
    const detected = detectMode(tmp.dir);
    expect(detected.mode).toBe("monorepo");
  });
});

describe("discoverModels", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-discover-");
  });
  afterEach(() => tmp.cleanup());

  it("resolves literal paths and applies workspace defaults", () => {
    writeYaml(
      path.join(tmp.dir, "models/a/cirron.json"),
      modelConfig({ name: "model-a" })
    );
    const { resolved, missing } = discoverModels(
      {
        workspace: {
          name: "ws",
          models: [{ path: "models/a" }],
          defaults: { env: { ENVIRONMENT: "production" } },
        },
      },
      tmp.dir
    );
    expect(missing).toEqual([]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.name).toBe("model-a");
    expect(resolved[0]?.path).toBe("models/a");
    expect(resolved[0]?.config.env).toEqual({ ENVIRONMENT: "production" });
  });

  it("expands a glob entry to subdirectories that contain a cirron config", () => {
    writeYaml(
      path.join(tmp.dir, "models/a/cirron.json"),
      modelConfig({ name: "model-a" })
    );
    writeYaml(
      path.join(tmp.dir, "models/b/cirron.json"),
      modelConfig({ name: "model-b" })
    );
    fs.ensureDirSync(path.join(tmp.dir, "models/not-a-model"));
    const { resolved, missing } = discoverModels(
      { workspace: { name: "ws", models: [{ path: "models/*" }] } },
      tmp.dir
    );
    expect(missing).toEqual([]);
    expect(resolved.map((m) => m.name).sort()).toEqual(["model-a", "model-b"]);
  });

  it("reports literal paths that are missing or have no cirron config", () => {
    fs.ensureDirSync(path.join(tmp.dir, "models/empty"));
    const { resolved, missing } = discoverModels(
      {
        workspace: {
          name: "ws",
          models: [{ path: "models/empty" }, { path: "models/gone" }],
        },
      },
      tmp.dir
    );
    expect(resolved).toEqual([]);
    expect(missing).toEqual(["models/empty", "models/gone"]);
  });

  it("de-duplicates models referenced more than once", () => {
    writeYaml(
      path.join(tmp.dir, "models/a/cirron.json"),
      modelConfig({ name: "model-a" })
    );
    const { resolved } = discoverModels(
      {
        workspace: {
          name: "ws",
          models: [
            { path: "models/a" },
            { path: "models/a/" },
            { path: "models/*" },
          ],
        },
      },
      tmp.dir
    );
    expect(resolved).toHaveLength(1);
  });
});

describe("filterModels", () => {
  const models = [
    {
      name: "model-a",
      path: "models/a",
      configPath: "",
      config: modelConfig(),
    },
    {
      name: "model-b",
      path: "models/b",
      configPath: "",
      config: modelConfig(),
    },
  ];

  it("matches by name", () => {
    const { matched, unmatched } = filterModels(models, ["model-a"]);
    expect(matched.map((m) => m.name)).toEqual(["model-a"]);
    expect(unmatched).toEqual([]);
  });

  it("matches by path", () => {
    const { matched } = filterModels(models, ["models/b"]);
    expect(matched.map((m) => m.name)).toEqual(["model-b"]);
  });

  it("reports identifiers that match nothing", () => {
    const { matched, unmatched } = filterModels(models, ["model-a", "bogus"]);
    expect(matched.map((m) => m.name)).toEqual(["model-a"]);
    expect(unmatched).toEqual(["bogus"]);
  });
});
