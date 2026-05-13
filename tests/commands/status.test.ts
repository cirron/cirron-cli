import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../../src/commands/status";
import { makeTmpDir } from "../helpers/tmpdir";

describe("statusCommand (local-only paths)", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-status-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    infoSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("warns and returns when no cirron config exists", async () => {
    await statusCommand({});
    const output = errorSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/No cirron config|cirron init/);
  });

  it("displays project status when a cirron.yaml exists", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await statusCommand({});
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toContain("demo");
    expect(output).toMatch(/Local Status/);
  });

  it("does not include remote section without --remote flag", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      "name: demo\nframework: custom\npythonVersion: '3.10'\ntype: model\nversion: 0.1.0\n"
    );
    await statusCommand({});
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).not.toMatch(/Remote Status/);
  });

  it("lists environments defined in cirron.yaml", async () => {
    fs.writeFileSync(
      path.join(tmp.dir, "cirron.yaml"),
      [
        "name: demo",
        "framework: custom",
        "pythonVersion: '3.10'",
        "type: model",
        "version: 0.1.0",
        "environments:",
        "  production:",
        "    url: https://prod.example",
        "  staging: {}",
      ].join("\n") + String.fromCharCode(10)
    );
    await statusCommand({});
    const output = infoSpy.mock.calls.flat().join(" ");
    expect(output).toMatch(/production/);
    expect(output).toMatch(/staging/);
  });
});
