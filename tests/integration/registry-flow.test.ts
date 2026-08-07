import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * End-to-end integration test: the real `bin/cirron` binary pulls an artifact
 * from an in-process stub platform, through a full token-refresh cycle.
 *
 * This is the only test that exercises the auth/refresh/streaming stack for
 * real. The unit suites stub the global fetch, so they cannot catch a regression in
 * how the spawned process reads HOME, persists rotated tokens, or streams a
 * response body to disk. It is also the safety net for any future change to the
 * HTTP client itself.
 */
describe("registry pull flow (spawned CLI binary against a stub platform)", () => {
  const binPath = path.resolve(__dirname, "..", "..", "bin", "cirron");
  const PAYLOAD = "artifact-bytes-for-the-integration-test";
  const CHECKSUM = crypto.createHash("sha256").update(PAYLOAD).digest("hex");

  let tmp: ReturnType<typeof makeTmpDir>;
  let server: http.Server | undefined;
  let port: number;
  /** Number of metadata requests served; the first one answers 401. */
  let metadataRequests: number;

  beforeEach(async () => {
    tmp = makeTmpDir("cirron-registry-flow-");
    metadataRequests = 0;
    ({ server, port } = await startStubPlatform());
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = undefined;
    }
    tmp.cleanup();
  });

  function send(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  /**
   * A stub of the platform's `/api/cli` surface, scripted so the first
   * metadata read is rejected and only succeeds after a token refresh.
   */
  function startStubPlatform(): Promise<{ server: http.Server; port: number }> {
    const stub = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (url.pathname === "/api/cli/auth/refresh") {
        send(res, 200, {
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 3600,
          token_type: "Bearer",
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/pull") {
        metadataRequests++;
        if (metadataRequests === 1) {
          send(res, 401, { error: "Unauthorized" });
          return;
        }

        // The retry must carry the rotated token.
        if (req.headers.authorization !== "Bearer rotated-access") {
          send(res, 401, { error: "stale token on retry" });
          return;
        }

        send(res, 200, {
          success: true,
          data: {
            artifacts: [
              {
                id: "art-1",
                name: "demo-model",
                type: "model",
                tag: "latest",
                filename: "demo-model.bin",
                size: PAYLOAD.length,
                checksum: CHECKSUM,
                createdAt: new Date(0).toISOString(),
              },
            ],
          },
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/pull/download") {
        send(res, 200, {
          success: true,
          data: {
            artifactId: "art-1",
            downloadUrl: `http://127.0.0.1:${port}/files/art-1`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
        });
        return;
      }

      if (url.pathname === "/files/art-1") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": Buffer.byteLength(PAYLOAD),
        });
        res.end(PAYLOAD);
        return;
      }

      send(res, 404, { error: `no stub route for ${url.pathname}` });
    });

    return new Promise((resolve) => {
      stub.listen(0, "127.0.0.1", () => {
        const address = stub.address();
        const assigned =
          typeof address === "object" && address ? address.port : 0;
        resolve({ server: stub, port: assigned });
      });
    });
  }

  /**
   * Write the CLI config directly. The spawned process resolves HOME itself,
   * so the os.homedir() spy the unit tests use does not apply here.
   */
  function writeConfig(apiUrl: string): void {
    fs.ensureDirSync(path.join(tmp.dir, ".cirron"));
    fs.writeJSONSync(path.join(tmp.dir, ".cirron", "config.json"), {
      apiUrl,
      defaultEnv: "production",
      timeout: 5000,
      retries: 0,
      auth: {
        accessToken: "stale-access",
        refreshToken: "stale-refresh",
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
  }

  /**
   * Run the CLI asynchronously. spawnSync would block this process's event
   * loop, and the stub platform lives here, so the server could never answer.
   */
  function runCli(
    args: string[],
    cwd: string = tmp.dir
  ): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn(binPath, args, {
        cwd,
        env: { ...process.env, HOME: tmp.dir, NO_COLOR: "1" },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`cirron ${args.join(" ")} timed out`));
      }, 30_000);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, status });
      });
    });
  }

  it("pulls an artifact through a 401 refresh cycle and persists the rotated tokens", async () => {
    writeConfig(`http://127.0.0.1:${port}`);
    expect(
      (await runCli(["init", "demo", "-t", "custom", "--no-install"])).status
    ).toBe(0);

    const projectDir = path.join(tmp.dir, "demo");
    const { status, stderr } = await runCli(
      ["pull", "model", "demo-model", "--force"],
      projectDir
    );

    expect(status, `stderr: ${stderr}`).toBe(0);

    // The artifact landed, with bytes matching the advertised checksum.
    const pulled = path.join(projectDir, "demo-model.bin");
    expect(fs.existsSync(pulled)).toBe(true);
    expect(fs.readFileSync(pulled, "utf8")).toBe(PAYLOAD);

    // The refresh really happened, and really persisted, in the spawned
    // process rather than only in memory.
    expect(metadataRequests).toBe(2);
    const stored = fs.readJSONSync(
      path.join(tmp.dir, ".cirron", "config.json")
    );
    expect(stored.auth.accessToken).toBe("rotated-access");
    expect(stored.auth.refreshToken).toBe("rotated-refresh");
  });

  it("fails gracefully when the platform is unreachable", async () => {
    // Port 1 is always refused.
    writeConfig("http://127.0.0.1:1");
    expect(
      (await runCli(["init", "demo", "-t", "custom", "--no-install"])).status
    ).toBe(0);

    const { status } = await runCli(
      ["pull", "model", "demo-model"],
      path.join(tmp.dir, "demo")
    );

    expect(status).not.toBe(0);
  });
});
