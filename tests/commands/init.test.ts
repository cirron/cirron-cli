import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import inquirer from "inquirer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initCommand } from "../../src/commands/init";
import { loadProjectConfig } from "../../src/utils/project-config";
import { writeProjectConfig } from "../helpers/project-fixture";
import { makeTmpDir } from "../helpers/tmpdir";

vi.mock("../../src/utils/execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/utils/execution")>();
  return {
    ...actual,
    executeScript: vi.fn((command: string) =>
      Promise.resolve({
        command,
        success: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        duration: 0,
      })
    ),
  };
});

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

  it("cancels when an existing cirron config is in the cwd and user picks 'cancel'", async () => {
    writeProjectConfig(tmp.dir);
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      action: "cancel",
    } as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand("demo", { template: "custom", install: false });

    expect(logSpy.mock.calls.flat().join(" ")).toMatch(/cancelled/i);
  });

  it("overwrites when an existing cwd config is present and user picks 'overwrite'", async () => {
    writeProjectConfig(tmp.dir, { name: "old-name" });
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      action: "overwrite",
    } as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand("fresh", { template: "custom", install: false });

    const loaded = loadProjectConfig(path.join(tmp.dir, "fresh"));
    expect(loaded?.config.name).toBe("fresh");
  });

  it("prompts for a project name when none is given", async () => {
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      name: "prompted-name",
    } as never);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand(undefined, { template: "custom", install: false });

    const loaded = loadProjectConfig(path.join(tmp.dir, "prompted-name"));
    expect(loaded?.config.name).toBe("prompted-name");
  });

  it("cancels when target dir has files and user declines the overwrite warning", async () => {
    const target = path.join(tmp.dir, "occupied");
    fs.ensureDirSync(target);
    fs.writeFileSync(path.join(target, "leftover.txt"), "stuff");
    vi.spyOn(inquirer, "prompt").mockResolvedValue({
      proceed: false,
    } as never);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await initCommand("occupied", { template: "custom", install: false });

    expect(logSpy.mock.calls.flat().join(" ")).toMatch(/cancelled/i);
    // The leftover file should still be there since we cancelled.
    expect(fs.existsSync(path.join(target, "leftover.txt"))).toBe(true);
  });

  it("--git initializes a repo (best-effort, no throw)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initCommand("with-git", {
      template: "custom",
      install: false,
      git: true,
    });

    expect(loadProjectConfig(path.join(tmp.dir, "with-git"))).not.toBeNull();
  });

  it("--install runs postInstall best-effort (no throw on failure)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await initCommand("with-install", {
      template: "pytorch",
      install: true,
    });

    expect(
      loadProjectConfig(path.join(tmp.dir, "with-install"))
    ).not.toBeNull();
  });
});
