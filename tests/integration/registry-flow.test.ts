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

  /** Part size the stub advertises; the CLI must slice to whatever it says. */
  const STUB_PART_SIZE = 64 * 1024 * 1024;

  interface ReceivedUpload {
    bytes: number;
    contentLength: string | undefined;
    contentRange: string | undefined;
    label: string;
    sha256: string;
    transferEncoding: string | undefined;
  }

  let tmp: ReturnType<typeof makeTmpDir>;
  let server: http.Server | undefined;
  let port: number;
  /** Number of metadata requests served; the first one answers 401. */
  let metadataRequests: number;
  /** Every PUT the stub storage endpoint received, in completion order. */
  let uploads: ReceivedUpload[];
  let recordedParts: { partNumber: number; etag: string }[];
  let confirmedUploadIds: string[];
  let multipartPartCount: number;
  let multipartCompleted: boolean;

  beforeEach(async () => {
    tmp = makeTmpDir("cirron-registry-flow-");
    metadataRequests = 0;
    uploads = [];
    recordedParts = [];
    confirmedUploadIds = [];
    multipartPartCount = 0;
    multipartCompleted = false;
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

  /** Drain a JSON request body. */
  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => resolve(raw));
    });
  }

  /**
   * Consume an upload PUT, recording the framing headers that matter.
   *
   * Hashes rather than buffers the body so a multipart test can push hundreds
   * of megabytes through without holding it all in memory.
   */
  function collectUpload(
    req: http.IncomingMessage,
    label: string
  ): Promise<ReceivedUpload> {
    return new Promise((resolve) => {
      const hash = crypto.createHash("sha256");
      let bytes = 0;
      req.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        hash.update(chunk);
      });
      req.on("end", () => {
        resolve({
          label,
          bytes,
          sha256: hash.digest("hex"),
          contentLength: req.headers["content-length"],
          transferEncoding: req.headers["transfer-encoding"],
          contentRange: req.headers["content-range"],
        });
      });
    });
  }

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

      // --- Push: single bound PUT ---

      if (url.pathname === "/api/cli/registry/push/check-dedupe") {
        readBody(req).then(() =>
          send(res, 200, { success: true, data: { exists: false } })
        );
        return;
      }

      if (url.pathname === "/api/cli/registry/push/upload-url") {
        readBody(req).then(() => {
          send(res, 200, {
            success: true,
            data: {
              uploadUrl: `http://127.0.0.1:${port}/files/put/single`,
              uploadId: "sess-single",
              chunkSize: 5 * 1024 * 1024,
              maxChunks: 1,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          });
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/push/confirm") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          confirmedUploadIds.push(body.uploadId);
          send(res, 200, {
            success: true,
            data: {
              artifactId: "art-pushed",
              versionId: "ver-1",
              name: "demo-artifact",
              type: "model",
              tag: "latest",
              size: body.size,
              checksum: body.checksum,
              createdAt: new Date(0).toISOString(),
            },
          });
        });
        return;
      }

      // --- Push: multipart ---

      if (url.pathname === "/api/cli/registry/push/multipart/init") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          multipartPartCount = Math.max(
            1,
            Math.ceil(body.size / STUB_PART_SIZE)
          );
          send(res, 200, {
            success: true,
            data: {
              sessionId: "sess-multipart",
              uploadId: "provider-upload-1",
              partSize: STUB_PART_SIZE,
              partCount: multipartPartCount,
              multipartThreshold: 256 * 1024 * 1024,
            },
          });
        });
        return;
      }

      if (url.pathname.startsWith("/api/cli/registry/push/session/")) {
        send(res, 200, {
          success: true,
          data: {
            sessionId: "sess-multipart",
            filePath: "artifact.bin",
            totalSize: 0,
            chunkSize: STUB_PART_SIZE,
            totalChunks: multipartPartCount,
            completedChunks: [],
            chunkChecksums: {},
            multipart: true,
            uploadUrl: "",
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/push/multipart/part-url") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          send(res, 200, {
            success: true,
            data: {
              url: `http://127.0.0.1:${port}/files/put/part/${body.partNumber}`,
              partNumber: body.partNumber,
              expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            },
          });
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/push/multipart/part-complete") {
        readBody(req).then((raw) => {
          const body = JSON.parse(raw || "{}");
          recordedParts.push({ partNumber: body.partNumber, etag: body.etag });
          send(res, 200, {
            success: true,
            data: {
              partNumber: body.partNumber,
              completedParts: recordedParts.length,
              totalParts: multipartPartCount,
            },
          });
        });
        return;
      }

      if (url.pathname === "/api/cli/registry/push/multipart/complete") {
        readBody(req).then(() => {
          multipartCompleted = true;
          send(res, 200, {
            success: true,
            data: {
              sessionId: "sess-multipart",
              partCount: recordedParts.length,
            },
          });
        });
        return;
      }

      // --- Storage: the presigned PUT targets ---

      const partMatch = url.pathname.match(/^\/files\/put\/part\/(\d+)$/);
      if (partMatch || url.pathname === "/files/put/single") {
        const label = partMatch ? `part-${partMatch[1]}` : "single";
        collectUpload(req, label).then((received) => {
          uploads.push(received);
          res.writeHead(200, { etag: `"etag-${label}"` });
          res.end();
        });
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

  it("pushes a 6 MB file as one bound PUT, not chunks", async () => {
    writeConfig(`http://127.0.0.1:${port}`);
    expect(
      (await runCli(["init", "demo", "-t", "custom", "--no-install"])).status
    ).toBe(0);

    const projectDir = path.join(tmp.dir, "demo");
    const payload = Buffer.alloc(6 * 1024 * 1024, 7);
    const artifact = path.join(projectDir, "artifact.bin");
    fs.writeFileSync(artifact, payload);

    const { status, stderr } = await runCli(
      ["push", "./artifact.bin"],
      projectDir
    );

    expect(status, `stderr: ${stderr}`).toBe(0);

    // The regression: anything over 5 MB used to be split into chunks PUT at
    // a single presigned URL, which the storage signature rejects.
    expect(uploads).toHaveLength(1);
    const put = uploads[0];
    expect(put?.bytes).toBe(payload.length);
    expect(put?.sha256).toBe(
      crypto.createHash("sha256").update(payload).digest("hex")
    );
    // Framing the presigned signature depends on.
    expect(put?.contentLength).toBe(String(payload.length));
    expect(put?.transferEncoding).toBeUndefined();
    expect(put?.contentRange).toBeUndefined();
    expect(confirmedUploadIds).toEqual(["sess-single"]);
  });

  it("pushes an artifact above the threshold as multipart parts", async () => {
    writeConfig(`http://127.0.0.1:${port}`);
    expect(
      (await runCli(["init", "demo", "-t", "custom", "--no-install"])).status
    ).toBe(0);

    const projectDir = path.join(tmp.dir, "demo");
    const artifact = path.join(projectDir, "artifact.bin");
    // Sparse: 260 MiB of zeros that costs no real disk. Above the CLI's
    // 256 MiB cutover, so this takes the multipart path.
    const size = 260 * 1024 * 1024;
    const fd = fs.openSync(artifact, "w");
    fs.ftruncateSync(fd, size);
    fs.closeSync(fd);

    const { status, stderr } = await runCli(
      ["push", "./artifact.bin"],
      projectDir
    );

    expect(status, `stderr: ${stderr}`).toBe(0);

    // 260 MiB at the stub's advertised 64 MiB part size.
    const expectedParts = Math.ceil(size / STUB_PART_SIZE);
    expect(uploads).toHaveLength(expectedParts);
    expect(recordedParts).toHaveLength(expectedParts);
    expect(multipartCompleted).toBe(true);

    // Every part arrived exactly once, and the parts tile the file with no
    // gap or overlap.
    expect(
      recordedParts.map((p) => p.partNumber).sort((a, b) => a - b)
    ).toEqual(Array.from({ length: expectedParts }, (_, i) => i + 1));
    expect(uploads.reduce((sum, u) => sum + u.bytes, 0)).toBe(size);

    // A presigned part URL is signed for one part and takes the part's bytes
    // as its whole body: a Content-Range would break it.
    for (const put of uploads) {
      expect(put.contentRange).toBeUndefined();
      expect(put.transferEncoding).toBeUndefined();
      expect(put.contentLength).toBe(String(put.bytes));
    }

    // The etags the storage layer returned were reported back verbatim.
    expect(recordedParts.every((p) => /^"etag-part-\d+"$/.test(p.etag))).toBe(
      true
    );

    // confirm resolves the SESSION, not the provider's upload id.
    expect(confirmedUploadIds).toEqual(["sess-multipart"]);
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
