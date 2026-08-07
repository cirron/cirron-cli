// biome-ignore-all lint/suspicious/noMisplacedAssertion: the per-fixture
// assertions live in the CASES table and are invoked from the generated it()
// below, which the rule cannot see through.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fetch from "node-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
const fetchMock = vi.mocked(fetch);

import { CirronApi } from "../../src/utils/api";
import {
  PlatformBadRequestError,
  PlatformRateLimitError,
} from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { createAuthenticatedSession } from "../helpers/session";
import { makeTmpDir } from "../helpers/tmpdir";

/**
 * The shared wire contract between this client and the platform's `/api/cli`
 * routes.
 *
 * Each `*.json` file in this directory describes one endpoint-scenario: the
 * request the client is expected to send and the exact top-level response the
 * route returns, transcribed from the route source rather than from memory.
 * The platform repo asserts its handlers against byte-identical copies of the
 * same files (`npm run contracts:check` compares them), so a change on either
 * side that the other has not adopted fails a suite instead of shipping.
 *
 * Every fixture must appear in CASES below. An unmapped fixture fails the
 * suite, which is what keeps the set honest as it grows.
 */

interface Fixture {
  endpoint: string;
  method: string;
  request?: {
    body?: Record<string, unknown>;
    /**
     * Query parameters that are part of the contract. Several calls carry
     * their whole payload here (device_code, artifactId, resource/name/tag),
     * so a rename on either side has to fail a test.
     */
    query?: Record<string, string>;
  };
  response: {
    status: number;
    headers?: Record<string, string>;
    body: unknown;
  };
  scenario: string;
}

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

interface Case {
  /** Assert on whatever the client did with the fixture body. */
  assert?: (outcome: Outcome) => void;
  /** Drive the client method this fixture describes. */
  invoke: (api: CirronApi) => Promise<unknown>;
}

const FIXTURE_DIR = __dirname;

/** Matches the device code the auth/device fixtures pin. */
const DEVICE_CODE = `device_${"a".repeat(32)}`;

function loadFixtures(): Fixture[] {
  return fs
    .readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map(
      (file) =>
        JSON.parse(
          fs.readFileSync(path.join(FIXTURE_DIR, file), "utf8")
        ) as Fixture
    );
}

const key = (fixture: Pick<Fixture, "method" | "endpoint" | "scenario">) =>
  `${fixture.method} ${fixture.endpoint} ${fixture.scenario}`;

/** Expect a resolved value; fail loudly with the error otherwise. */
function value(outcome: Outcome): any {
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

/** Expect a rejection and hand back the thrown error. */
function error(outcome: Outcome): unknown {
  expect(outcome.ok, "expected this call to reject").toBe(false);
  return (outcome as { error: unknown }).error;
}

const CASES: Record<string, Case> = {
  "POST /api/cli/auth/refresh success": {
    invoke: (api) => api.refreshToken("<REFRESH_TOKEN>"),
    assert: (outcome) => {
      const tokens = value(outcome);
      // Refresh answers snake_case and flat, unlike the device route.
      expect(tokens.access_token).toBe("<JWT>");
      expect(tokens.refresh_token).toBe("<REFRESH_TOKEN>");
      expect(tokens.expires_in).toBe(3600);
    },
  },

  "POST /api/cli/auth/device success": {
    invoke: (api) => api.requestDeviceCode(),
    assert: (outcome) => {
      const device = value(outcome);
      expect(device.deviceCode).toMatch(/^device_[0-9a-f]{32}$/);
      // The poll deadline and cadence both come from these two fields.
      expect(device.expiresIn).toBe(600);
      expect(device.interval).toBe(5);
    },
  },

  "GET /api/cli/auth/device success": {
    invoke: (api) => api.pollDeviceAuthorization(DEVICE_CODE),
    assert: (outcome) => {
      const status = value(outcome);
      // Device success is camelCase and flat, with no status discriminator.
      expect(status.accessToken).toBe("<JWT>");
      expect(status.refreshToken).toBe("<REFRESH_TOKEN>");
      expect(status.tokenType).toBe("Bearer");
      expect(status.status).toBeUndefined();
    },
  },

  "GET /api/cli/auth/device pending": {
    invoke: (api) => api.pollDeviceAuthorization(DEVICE_CODE),
    assert: (outcome) => {
      const err = error(outcome);
      expect(err).toBeInstanceOf(PlatformBadRequestError);
      // The poll loop branches on this exact message to keep polling.
      expect((err as Error).message).toBe("authorization_pending");
    },
  },

  "GET /api/cli/auth/device expired": {
    invoke: (api) => api.pollDeviceAuthorization(DEVICE_CODE),
    assert: (outcome) => {
      const err = error(outcome);
      expect(err).toBeInstanceOf(PlatformBadRequestError);
      expect((err as Error).message).toBe("expired_token");
    },
  },

  "GET /api/cli/auth/device rate-limited": {
    invoke: (api) => api.pollDeviceAuthorization(DEVICE_CODE),
    assert: (outcome) => {
      const err = error(outcome);
      expect(err).toBeInstanceOf(PlatformRateLimitError);
      expect((err as PlatformRateLimitError).retryAfterSeconds).toBe(7);
    },
  },

  "GET /api/cli/status success": {
    invoke: (api) => api.validateAuth(),
    assert: (outcome) => {
      const auth = value(outcome);
      // Status is flat: no { success, data } envelope.
      expect(auth.valid).toBe(true);
      expect(auth.user?.email).toBe("dev@example.com");
    },
  },

  "POST /api/cli/deployments success": {
    invoke: (api) =>
      api.createDeployment({
        projectName: "demo-model",
        environment: "production",
        message: "Deploy to production",
        buildConfig: {},
        deployConfig: {},
        envConfig: {},
      }),
    assert: (outcome) => {
      const deployment = value(outcome);
      expect(deployment.id).toBe("dep_1");
      // Raw enum statuses are normalized to the lowercase union.
      expect(deployment.status).toBe("pending");
    },
  },

  "POST /api/cli/deployments missing-model": {
    invoke: (api) =>
      api.createDeployment({
        projectName: "demo-model",
        environment: "production",
        message: "Deploy to production",
        buildConfig: {},
        deployConfig: {},
        envConfig: {},
      }),
    assert: (outcome) => {
      expect(error(outcome)).toBeInstanceOf(PlatformBadRequestError);
    },
  },

  "GET /api/cli/models/{name}/deployments success": {
    invoke: (api) => api.getDeployments("demo-model"),
    assert: (outcome) => {
      const deployments = value(outcome);
      expect(deployments).toHaveLength(1);
      expect(deployments[0].status).toBe("success");
    },
  },

  "GET /api/cli/models/{name}/deployments unmapped-status": {
    invoke: (api) => api.getDeployments("demo-model"),
    assert: (outcome) => {
      // Deployments.status is a free-form string server-side, so anything the
      // status map doesn't cover must still come through, lowercased.
      expect(value(outcome)[0].status).toBe("stopped");
    },
  },

  "POST /api/cli/models/{name}/rollback success": {
    invoke: (api) =>
      api.rollbackDeployment("demo-model", "production", "dep_1"),
    assert: (outcome) => {
      const deployment = value(outcome);
      // Rollback nests its payload under `deployment`, not `data`.
      expect(deployment.id).toBe("dep_3");
      expect(deployment.status).toBe("pending");
    },
  },

  "POST /api/cli/models success": {
    invoke: (api) =>
      api.createProject({
        name: "demo-model",
        framework: "pytorch",
        path: ".",
      }),
    assert: (outcome) => {
      // Model creation nests its payload under `model`, not `data`.
      expect(value(outcome).id).toBe("m_1");
    },
  },

  "POST /api/cli/builds success": {
    invoke: (api) =>
      api.reportBuild({
        projectName: "demo-model",
        environment: "production",
        status: "success",
        timestamp: "2026-01-01T00:00:00.000Z",
      }),
  },

  "POST /api/cli/registry/push/upload-url success": {
    invoke: (api) =>
      api.getUploadUrl({
        filename: "demo-model.pth",
        size: 1024,
        checksum: "a".repeat(64),
      }),
    assert: (outcome) => {
      const upload = value(outcome);
      expect(upload.uploadId).toBe("upload_1");
      expect(upload.chunkSize).toBe(5_242_880);
    },
  },

  "POST /api/cli/registry/push/confirm success": {
    invoke: (api) =>
      api.confirmUpload({
        uploadId: "upload_1",
        checksum: "a".repeat(64),
        size: 1024,
      }),
    assert: (outcome) => {
      expect(value(outcome).artifactId).toBe("art_1");
    },
  },

  "GET /api/cli/registry/pull success": {
    invoke: (api) =>
      api.getPullArtifacts({
        resource: "model",
        name: "demo-model",
        tag: "latest",
      }),
    assert: (outcome) => {
      // Pull nests its list one level deeper, under data.artifacts.
      const artifacts = value(outcome);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0].filename).toBe("demo-model.pth");
    },
  },

  "GET /api/cli/registry/pull/download success": {
    invoke: (api) => api.getPullDownloadUrl("art_1"),
    assert: (outcome) => {
      expect(value(outcome).downloadUrl).toContain("/download/art_1");
    },
  },
};

/** Turn an endpoint template into a matcher for the real request path. */
function pathMatcher(endpoint: string): RegExp {
  const escaped = endpoint
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\{[^}]+\\\}/g, "[^/]+");
  return new RegExp(`^${escaped}$`);
}

describe("CLI/platform wire contract", () => {
  const fixtures = loadFixtures();

  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let api: CirronApi;

  beforeEach(() => {
    tmp = makeTmpDir("cirron-contract-");
    origCwd = process.cwd();
    process.chdir(tmp.dir);
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    createAuthenticatedSession(tmp.dir);
    fetchMock.mockReset();
    api = new CirronApi(new ConfigManager().load());
  });

  afterEach(() => {
    process.chdir(origCwd);
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  it("ships at least the endpoints drift has already bitten", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(16);
  });

  it("has a test mapping for every fixture", () => {
    const unmapped = fixtures.filter((f) => !CASES[key(f)]).map(key);
    expect(unmapped, "fixtures with no test mapping").toEqual([]);
  });

  it("has a fixture for every test mapping", () => {
    const present = new Set(fixtures.map(key));
    const orphaned = Object.keys(CASES).filter((k) => !present.has(k));
    expect(orphaned, "mappings with no fixture").toEqual([]);
  });

  it("uses placeholder secrets only", () => {
    for (const fixture of fixtures) {
      const serialized = JSON.stringify(fixture);
      expect(serialized, key(fixture)).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
      expect(serialized, key(fixture)).not.toMatch(/\bsk-[A-Za-z0-9]{8,}/);
    }
  });

  for (const fixture of fixtures) {
    it(`${key(fixture)}`, async () => {
      const testCase = CASES[key(fixture)];
      if (!testCase) {
        throw new Error(`fixture has no test mapping: ${key(fixture)}`);
      }

      fetchMock.mockResolvedValue({
        ok: fixture.response.status >= 200 && fixture.response.status < 300,
        status: fixture.response.status,
        statusText: "",
        headers: {
          get: (name: string) =>
            fixture.response.headers?.[name.toLowerCase()] ?? null,
        },
        json: async () => fixture.response.body,
      } as never);

      const outcome: Outcome = await testCase
        .invoke(api)
        .then((result) => ({ ok: true as const, value: result }))
        .catch((err: unknown) => ({ ok: false as const, error: err }));

      // 1. The client hit the endpoint and method the fixture describes.
      const call = fetchMock.mock.calls.at(0);
      expect(call, "the client made no request").toBeDefined();
      const requestUrl = new URL(String(call?.[0]));
      const init = call?.[1] as { method?: string; body?: string } | undefined;
      expect(requestUrl.pathname).toMatch(pathMatcher(fixture.endpoint));
      expect(init?.method ?? "GET").toBe(fixture.method);

      // 2. Every query parameter the fixture declares was sent, with the
      //    value it declares. Renaming device_code or artifactId is a
      //    breaking change and has to fail here.
      if (fixture.request?.query) {
        for (const [param, expected] of Object.entries(fixture.request.query)) {
          expect(
            requestUrl.searchParams.get(param),
            `query parameter "${param}"`
          ).toBe(expected);
        }
      }

      // 3. Every key the fixture declares is present in what we sent. The
      //    client may send more; it may not send less.
      if (fixture.request?.body) {
        const sent = JSON.parse(init?.body ?? "{}");
        for (const [field, expected] of Object.entries(fixture.request.body)) {
          expect(sent[field], `request body field "${field}"`).toEqual(
            expected
          );
        }
      }

      // 4. Whatever the fixture pins about how the body is read.
      testCase.assert?.(outcome);
    });
  }
});
