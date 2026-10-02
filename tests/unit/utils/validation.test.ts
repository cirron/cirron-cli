import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    execSync: vi.fn().mockReturnValue("Python 3.10.0\n"),
  };
});

import { execSync } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import {
  checkIndexConfig,
  checkPythonVersion,
  checkRequiredFiles,
} from "../../../src/utils/validation";
import { makeTmpDir } from "../../helpers/tmpdir";

/**
 * The pure primitives only. The Python probes (checkCudaPytorch,
 * checkTensorflowGpu, checkModelCreation) shell out and are covered through
 * the build/compile/plan command suites.
 *
 * Every message string here is asserted verbatim: users see them, and the
 * three commands were unified on the promise that none of them changed.
 */
describe("checkRequiredFiles", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-validation-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
  });

  afterEach(() => {
    process.chdir(origCwd);
    tmp.cleanup();
  });

  it("reports each missing default file", () => {
    expect(checkRequiredFiles()).toEqual([
      "Required file missing: src/model.py",
      "Required file missing: requirements.txt",
    ]);
  });

  it("returns nothing when the defaults are present", () => {
    fs.ensureDirSync(path.join(tmp.dir, "src"));
    fs.writeFileSync(path.join(tmp.dir, "src", "model.py"), "");
    fs.writeFileSync(path.join(tmp.dir, "requirements.txt"), "");
    expect(checkRequiredFiles()).toEqual([]);
  });

  it("honors an explicit file list", () => {
    expect(checkRequiredFiles(["custom.txt"])).toEqual([
      "Required file missing: custom.txt",
    ]);
  });

  it("returns nothing for an empty list", () => {
    expect(checkRequiredFiles([])).toEqual([]);
  });
});

describe("checkPythonVersion", () => {
  afterEach(() => {
    vi.mocked(execSync).mockReset();
  });

  function stubPython(output: string): void {
    vi.mocked(execSync).mockReturnValue(output as never);
  }

  it("accepts a version above the requirement", () => {
    stubPython("Python 3.12.1\n");
    expect(checkPythonVersion("3.9")).toEqual([]);
  });

  it("accepts a version exactly at the requirement", () => {
    stubPython("Python 3.9.0\n");
    expect(checkPythonVersion("3.9")).toEqual([]);
  });

  it("rejects a lower minor version", () => {
    stubPython("Python 3.8.10\n");
    expect(checkPythonVersion("3.9")).toEqual([
      "Python 3.9+ required, found 3.8",
    ]);
  });

  it("rejects a lower major version", () => {
    stubPython("Python 2.7.18\n");
    expect(checkPythonVersion("3.9")).toEqual([
      "Python 3.9+ required, found 2.7",
    ]);
  });

  it("defaults the requirement to 3.9", () => {
    stubPython("Python 3.8.0\n");
    expect(checkPythonVersion()).toEqual(["Python 3.9+ required, found 3.8"]);
  });

  it("reports python3 as unavailable when the probe throws", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("command not found");
    });
    expect(checkPythonVersion("3.9")).toEqual(["Python3 not available"]);
  });

  it("accepts unparseable output rather than failing the build", () => {
    stubPython("Python next\n");
    expect(checkPythonVersion("3.9")).toEqual([]);
  });
});

describe("checkIndexConfig", () => {
  it("ignores a missing index config entirely", () => {
    expect(checkIndexConfig(undefined, { requireDataTypes: true })).toEqual([]);
    expect(checkIndexConfig(null, { requireDataTypes: true })).toEqual([]);
  });

  it("accepts a valid config when dataTypes are required", () => {
    expect(
      checkIndexConfig(
        { features: ["a"], dataTypes: { a: "float" } },
        { requireDataTypes: true }
      )
    ).toEqual([]);
  });

  it("flags a missing or non-array features field", () => {
    expect(checkIndexConfig({}, { requireDataTypes: false })).toEqual([
      "Index file missing or invalid features array",
    ]);
    expect(
      checkIndexConfig({ features: "nope" }, { requireDataTypes: false })
    ).toEqual(["Index file missing or invalid features array"]);
  });

  it("only flags dataTypes when they are required", () => {
    expect(
      checkIndexConfig({ features: ["a"] }, { requireDataTypes: false })
    ).toEqual([]);
    expect(
      checkIndexConfig({ features: ["a"] }, { requireDataTypes: true })
    ).toEqual(["Index file missing or invalid dataTypes object"]);
  });

  it("reports both problems at once", () => {
    expect(checkIndexConfig({ other: 1 }, { requireDataTypes: true })).toEqual([
      "Index file missing or invalid features array",
      "Index file missing or invalid dataTypes object",
    ]);
  });
});
