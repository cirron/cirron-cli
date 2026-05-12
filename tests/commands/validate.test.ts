import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateCommand } from "../../src/commands/validate";
import { exitCodeFromError, stubProcessExit } from "../helpers/mock-api";
import { makeTmpDir } from "../helpers/tmpdir";

function writeConfig(dir: string, name: string, obj: unknown): void {
  fs.ensureDirSync(dir);
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

function model(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name: "demo",
    framework: "custom",
    type: "model",
    version: "1.0.0",
    ...overrides,
  };
}

describe("validateCommand", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitStub: ReturnType<typeof stubProcessExit>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-validate-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    exitStub = stubProcessExit();
  });

  afterEach(() => {
    process.chdir(origCwd);
    exitStub.restore();
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  const out = () => logSpy.mock.calls.flat().join("\n");
  const err = () => errorSpy.mock.calls.flat().join("\n");

  it("fails when there is no cirron config", async () => {
    await expect(validateCommand({})).rejects.toThrow();
    expect(err()).toMatch(/No cirron config/);
  });

  it("validates a single-model config and passes", async () => {
    writeConfig(tmp.dir, "cirron.json", model({ name: "solo" }));
    await validateCommand({});
    expect(out()).toMatch(/PASS solo/);
    expect(out()).toMatch(/valid/i);
  });

  it("warns (does not fail) on a non-built-in framework", async () => {
    writeConfig(tmp.dir, "cirron.json", model({ framework: "mxnet" }));
    await validateCommand({});
    expect(out()).toMatch(/PASS/);
    expect(out()).toMatch(/not one of the built-in frameworks/);
  });

  it("fails a single-model config that is missing a required field", async () => {
    const cfg = model({ name: "solo" });
    delete cfg.version;
    writeConfig(tmp.dir, "cirron.json", cfg);
    let code: number | null = null;
    try {
      await validateCommand({});
    } catch (e) {
      code = exitCodeFromError(e as Error);
    }
    expect(code).toBe(1);
    expect(out()).toMatch(/missing required field: version/);
  });

  it("errors when --model does not match the single project", async () => {
    writeConfig(tmp.dir, "cirron.json", model({ name: "solo" }));
    let code: number | null = null;
    try {
      await validateCommand({ model: ["other"] });
    } catch (e) {
      code = exitCodeFromError(e as Error);
    }
    expect(code).toBe(1);
    expect(err()).toMatch(/did not match this project/);
  });

  it("validates every model in a workspace", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: {
        name: "ml-models",
        models: [{ path: "models/*" }],
        defaults: { env: { ENVIRONMENT: "production" } },
      },
    });
    writeConfig(
      path.join(tmp.dir, "models/a"),
      "cirron.json",
      model({ name: "model-a" })
    );
    writeConfig(
      path.join(tmp.dir, "models/b"),
      "cirron.json",
      model({ name: "model-b" })
    );
    await validateCommand({});
    expect(out()).toMatch(/Workspace: ml-models/);
    expect(out()).toMatch(/PASS model-a/);
    expect(out()).toMatch(/PASS model-b/);
    expect(out()).toMatch(/All 2 model\(s\) valid/);
  });

  it("fails the workspace when a model path is missing", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: {
        name: "ws",
        models: [{ path: "models/a" }, { path: "models/gone" }],
      },
    });
    writeConfig(
      path.join(tmp.dir, "models/a"),
      "cirron.json",
      model({ name: "model-a" })
    );
    let code: number | null = null;
    try {
      await validateCommand({});
    } catch (e) {
      code = exitCodeFromError(e as Error);
    }
    expect(code).toBe(1);
    expect(out()).toMatch(/models\/gone/);
  });

  it("validates only the named model with --model", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: { name: "ws", models: [{ path: "models/*" }] },
    });
    writeConfig(
      path.join(tmp.dir, "models/a"),
      "cirron.json",
      model({ name: "model-a" })
    );
    writeConfig(
      path.join(tmp.dir, "models/b"),
      "cirron.json",
      model({ name: "model-b" })
    );
    await validateCommand({ model: ["model-a"] });
    expect(out()).toMatch(/PASS model-a/);
    expect(out()).not.toMatch(/model-b/);
  });

  it("fails when --model matches nothing in the workspace", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: { name: "ws", models: [{ path: "models/a" }] },
    });
    writeConfig(
      path.join(tmp.dir, "models/a"),
      "cirron.json",
      model({ name: "model-a" })
    );
    let code: number | null = null;
    try {
      await validateCommand({ model: ["bogus"] });
    } catch (e) {
      code = exitCodeFromError(e as Error);
    }
    expect(code).toBe(1);
    expect(out()).toMatch(/did not match any model/);
  });

  it("fails the workspace when the root config is malformed", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: { name: "", models: [] },
    });
    let code: number | null = null;
    try {
      await validateCommand({});
    } catch (e) {
      code = exitCodeFromError(e as Error);
    }
    expect(code).toBe(1);
    expect(out()).toMatch(/workspace\.name/);
    expect(out()).toMatch(/workspace\.models/);
  });

  it("emits JSON for a workspace when --json is set", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: { name: "ws", models: [{ path: "models/a" }] },
    });
    writeConfig(
      path.join(tmp.dir, "models/a"),
      "cirron.json",
      model({ name: "model-a" })
    );
    await validateCommand({ json: true });
    const parsed = JSON.parse(out());
    expect(parsed.workspace).toBe("ws");
    expect(parsed.ok).toBe(true);
    expect(parsed.models[0].name).toBe("model-a");
  });

  it("emits JSON for a single model when --json is set", async () => {
    writeConfig(tmp.dir, "cirron.json", model({ name: "solo" }));
    await validateCommand({ json: true });
    const parsed = JSON.parse(out());
    expect(parsed).toEqual({
      name: "solo",
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  it("operates in single-model mode inside a model subdir of a monorepo", async () => {
    writeConfig(tmp.dir, "cirron.json", {
      workspace: { name: "ws", models: [{ path: "models/a" }] },
    });
    const modelDir = path.join(tmp.dir, "models/a");
    writeConfig(modelDir, "cirron.json", model({ name: "model-a" }));
    process.chdir(modelDir);
    await validateCommand({});
    expect(out()).toMatch(/PASS model-a/);
    expect(out()).not.toMatch(/Workspace:/);
  });
});
