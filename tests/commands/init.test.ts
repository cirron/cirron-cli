import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../../src/commands/init";
import { loadProjectConfig } from "../../src/utils/project-config";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * These tests exercise the real initCommand against a tmp directory.
 * inquirer is never prompted because we provide projectName + a valid
 * template, and run in an empty cwd. We also stub os.homedir so the
 * "register with Cirron" branch never fires (no auth token in tmp config).
 */
describe("initCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-init-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("creates a project directory with a cirron config file", async () => {
    await initCommand("demo", {
      template: "custom",
      install: false,
    });

    const projectPath = path.join(tmp.dir, "demo");
    expect(fs.existsSync(projectPath)).toBe(true);

    const loaded = loadProjectConfig(projectPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.config.name).toBe("demo");
  });

  it.each([
    "pytorch",
    "tensorflow",
    "sklearn",
    "pytorch-train",
    "tensorflow-train",
    "sklearn-pipeline",
    "custom",
  ])("template '%s' generates a valid project", async (template) => {
    await initCommand(`demo-${template}`, {
      template,
      install: false,
    });

    const projectPath = path.join(tmp.dir, `demo-${template}`);
    const loaded = loadProjectConfig(projectPath);
    expect(loaded).not.toBeNull();
    expect(loaded?.config.name).toBe(`demo-${template}`);
  });

  it("creates the artifacts/ directory with .gitkeep", async () => {
    await initCommand("demo", {
      template: "custom",
      install: false,
    });

    const artifactsDir = path.join(tmp.dir, "demo", "artifacts");
    expect(fs.existsSync(artifactsDir)).toBe(true);
    expect(fs.existsSync(path.join(artifactsDir, ".gitkeep"))).toBe(true);
  });

  it("uses the last path segment as the project name when given a path", async () => {
    await initCommand("./projects/nested", {
      template: "custom",
      install: false,
    });

    const projectPath = path.join(tmp.dir, "projects", "nested");
    const loaded = loadProjectConfig(projectPath);
    expect(loaded?.config.name).toBe("nested");
  });

  it("does not register with Cirron when no auth token is configured", async () => {
    // No token in our tmp ~/.cirron/config.json → register branch is skipped.
    // We verify that init completes successfully and does not throw.
    await expect(
      initCommand("demo", {
        template: "custom",
        install: false,
      })
    ).resolves.toBeUndefined();
  });
});
