import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * End-to-end integration test: spawn the real `bin/cirron` binary against a
 * tmp directory and validate the v0.1.0 offline-capable user flow. This is
 * the closest test we have to a real user install on an airplane:
 *
 *   $ cirron init demo --template custom --no-install
 *   $ cd demo && cirron config get apiUrl
 *   $ cirron list deployments   # platform unreachable → graceful error
 *   $ cirron auth status        # not signed in → returns early
 *
 * The test isolates ~/.cirron by setting HOME to the tmp dir, and points
 * apiUrl at 127.0.0.1:1 (always refused) so the platform-gated commands
 * exercise the PlatformUnavailableError path.
 */
describe("offline flow (spawned CLI binary)", () => {
  const binPath = path.resolve(__dirname, "..", "..", "bin", "cirron");

  let tmp: ReturnType<typeof makeTmpDir>;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-integration-");
  });

  afterEach(() => {
    tmp.cleanup();
  });

  function runCli(
    args: string[],
    cwd: string = tmp.dir
  ): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(binPath, args, {
      cwd,
      env: { ...process.env, HOME: tmp.dir, NO_COLOR: "1" },
      encoding: "utf8",
      timeout: 30_000,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      status: result.status,
    };
  }

  it("`cirron --version` prints the package version cleanly", () => {
    const { stdout, status } = runCli(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("`cirron init <name> -t custom --no-install` creates a working project offline", () => {
    const { status } = runCli(["init", "demo", "-t", "custom", "--no-install"]);
    expect(status).toBe(0);

    const projectPath = path.join(tmp.dir, "demo");
    expect(fs.existsSync(projectPath)).toBe(true);
    // Either cirron.yaml or cirron.json should be present.
    const hasConfig =
      fs.existsSync(path.join(projectPath, "cirron.yaml")) ||
      fs.existsSync(path.join(projectPath, "cirron.json"));
    expect(hasConfig).toBe(true);
  });

  it("`cirron config set apiUrl=...` persists offline", () => {
    const set = runCli([
      "config",
      "--scope",
      "cli",
      "--set",
      "apiUrl=http://127.0.0.1:1",
    ]);
    expect(set.status).toBe(0);

    const list = runCli(["config", "--scope", "cli", "--list"]);
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("http://127.0.0.1:1");
  });

  it("`cirron auth status` reports 'Not authenticated' without exiting non-zero", () => {
    const { stdout, status } = runCli(["auth", "status"]);
    expect(status).toBe(0);
    expect(stdout).toMatch(/Not authenticated/i);
  });

  it("`cirron list deployments` returns a graceful 'not signed in' message", () => {
    // No token configured → list returns early without calling the API.
    const { stdout, status } = runCli(["list", "deployments"]);
    // listCommand returns 0 here (no API call attempted).
    expect(status).toBe(0);
    expect(stdout).toMatch(/cirron auth login/);
  });

  it("`cirron list deployments` returns exit 3 with waitlist CTA when platform unreachable + signed in", () => {
    // Seed a fake token + dead apiUrl so the API call is attempted and fails.
    fs.ensureDirSync(path.join(tmp.dir, ".cirron"));
    fs.writeJSONSync(path.join(tmp.dir, ".cirron", "config.json"), {
      apiUrl: "http://127.0.0.1:1",
      defaultEnv: "production",
      timeout: 2000,
      retries: 0,
      token: "fake-token",
    });

    const { stderr, status } = runCli(["list", "deployments"]);
    expect(status).toBe(3);
    expect(stderr).toMatch(/private preview/i);
    expect(stderr).toMatch(/cirron\.com\/waitlist/);
  });

  it("`cirron auth login` exits 3 with waitlist CTA when platform unreachable", () => {
    fs.ensureDirSync(path.join(tmp.dir, ".cirron"));
    fs.writeJSONSync(path.join(tmp.dir, ".cirron", "config.json"), {
      apiUrl: "http://127.0.0.1:1",
      defaultEnv: "production",
      timeout: 2000,
      retries: 0,
    });

    const { stderr, status } = runCli(["auth", "login"]);
    expect(status).toBe(3);
    expect(stderr).toMatch(/private preview/i);
  });
});

/**
 * Sanity check: confirm the CLI binary is executable. If this fails the rest
 * of the integration suite will too — call out the cause explicitly.
 */
describe("CLI binary availability", () => {
  it("bin/cirron is executable from the repo root", () => {
    const binPath = path.resolve(__dirname, "..", "..", "bin", "cirron");
    expect(fs.existsSync(binPath)).toBe(true);
    // execFileSync throws on non-zero; --help should always succeed
    expect(() =>
      execFileSync(binPath, ["--help"], { stdio: "pipe", timeout: 15_000 })
    ).not.toThrow();
  });
});
