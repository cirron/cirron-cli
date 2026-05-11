import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectConfig } from "../../../src/types";
import {
  findProjectConfigPath,
  loadProjectConfig,
  saveProjectConfig,
} from "../../../src/utils/project-config";
import { makeTmpDir } from "../../helpers/tmpdir";

const baseConfig: ProjectConfig = {
  name: "demo",
  framework: "pytorch",
  pythonVersion: "3.10",
  type: "model",
  version: "0.1.0",
};

describe("loadProjectConfig", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-pconfig-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns null when no config file exists", () => {
    expect(loadProjectConfig(tmp.dir)).toBeNull();
  });

  it("loads a cirron.json file", () => {
    fs.writeJSONSync(path.join(tmp.dir, "cirron.json"), baseConfig);
    const result = loadProjectConfig(tmp.dir);
    expect(result).not.toBeNull();
    expect(result?.filename).toBe("cirron.json");
    expect(result?.config.name).toBe("demo");
  });

  it("loads a cirron.yaml file", () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: pytorch\npythonVersion: '3.10'\nmodelType: custom\n"
    );
    const result = loadProjectConfig(tmp.dir);
    expect(result?.filename).toBe("cirron.yaml");
    expect(result?.config.framework).toBe("pytorch");
  });

  it("loads a cirron.yml file", () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yml"),
      "name: demo\nframework: tensorflow\n"
    );
    const result = loadProjectConfig(tmp.dir);
    expect(result?.filename).toBe("cirron.yml");
    expect(result?.config.framework).toBe("tensorflow");
  });

  it("prefers yaml over yml over json when multiple exist", () => {
    fs.writeJSONSync(path.join(tmp.dir, "cirron.json"), {
      ...baseConfig,
      framework: "from-json",
    });
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: from-yaml\n"
    );
    const result = loadProjectConfig(tmp.dir);
    expect(result?.config.framework).toBe("from-yaml");
  });

  it("throws a useful error on malformed JSON", () => {
    fs.writeFileSync(path.join(tmp.dir, "cirron.json"), "{ not json");
    expect(() => loadProjectConfig(tmp.dir)).toThrow(
      /Failed to parse cirron\.json/
    );
  });

  it("throws a useful error on malformed YAML", () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\n  bad: indentation: here:\n"
    );
    expect(() => loadProjectConfig(tmp.dir)).toThrow(
      /Failed to parse cirron\.yaml/
    );
  });
});

describe("findProjectConfigPath", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-find-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("returns null when no config exists", () => {
    expect(findProjectConfigPath(tmp.dir)).toBeNull();
  });

  it("returns the absolute path when config exists", () => {
    fs.writeJSONSync(path.join(tmp.dir, "cirron.json"), baseConfig);
    const result = findProjectConfigPath(tmp.dir);
    expect(result).toBe(path.join(tmp.dir, "cirron.json"));
  });
});

describe("saveProjectConfig", () => {
  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-save-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("writes JSON pretty-printed when path ends in .json", () => {
    const dest = path.join(tmp.dir, "cirron.json");
    saveProjectConfig(dest, { ...baseConfig, framework: "sklearn" });
    const raw = fs.readFileSync(dest, "utf8");
    expect(raw).toContain("\n");
    expect(JSON.parse(raw).framework).toBe("sklearn");
  });

  it("writes YAML when path ends in .yaml", () => {
    const dest = path.join(tmp.dir, "cirron.yaml");
    saveProjectConfig(dest, baseConfig);
    const raw = fs.readFileSync(dest, "utf8");
    expect(raw).toMatch(/^name: demo/m);
    expect(raw).toMatch(/framework: pytorch/);
  });

  it("round-trips through load", () => {
    const dest = path.join(tmp.dir, "cirron.yaml");
    const original = { ...baseConfig, pythonVersion: "3.11" };
    saveProjectConfig(dest, original);
    const loaded = loadProjectConfig(tmp.dir);
    expect(loaded?.config.pythonVersion).toBe("3.11");
  });
});
