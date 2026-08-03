import os from "node:os";
import fetch from "node-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node-fetch", () => ({ default: vi.fn() }));
const fetchMock = vi.mocked(fetch);

import { CirronApi } from "../../../src/utils/api";
import { ConfigManager } from "../../../src/utils/config";
import { createAuthenticatedSession } from "../../helpers/session";
import { makeTmpDir } from "../../helpers/tmpdir";

/**
 * Pin the wire contract between CirronApi and the platform's `/api/cli` routes.
 *
 * Each test feeds a real platform response shape into a mocked fetch and
 * asserts on what the client returns, plus what it puts on the wire, so that a
 * change to either envelope or request body fails loudly here.
 */
describe("CirronApi wire contract", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let origCwd: string;
  let api: CirronApi;

  /** The subset of a posted request body these tests assert on. */
  interface SentBody {
    environment?: string;
    modelName?: string;
  }

  /** Stub the next fetch with a successful JSON response body. */
  function mockJson<T>(body: T, status = 200): void {
    fetchMock.mockResolvedValue({
      ok: true,
      status,
      json: async () => body,
    } as never);
  }

  /** Parse the JSON body sent on the most recent fetch call. */
  function lastRequestBody(): SentBody {
    const call = fetchMock.mock.calls.at(-1);
    const init = call?.[1] as { body?: string } | undefined;
    return JSON.parse(init?.body ?? "{}");
  }

  beforeEach(() => {
    tmp = makeTmpDir("cirron-api-contract-");
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

  it("refreshToken reads the flat snake_case refresh body", async () => {
    mockJson({
      access_token: "a",
      refresh_token: "r",
      expires_in: 3600,
      token_type: "Bearer",
    });

    const tokens = await api.refreshToken("rt");

    expect(tokens.access_token).toBe("a");
    expect(tokens.refresh_token).toBe("r");
    expect(tokens.expires_in).toBe(3600);
  });

  it("createDeployment sends modelName alongside projectName", async () => {
    mockJson({ success: true, data: { id: "d1", status: "PENDING" } });

    await api.createDeployment({
      projectName: "m",
      environment: "production",
      message: "deploy",
      buildConfig: {},
      deployConfig: {},
      envConfig: {},
    });

    const body = lastRequestBody();
    expect(body.modelName).toBe("m");
    expect(body.environment).toBe("production");
  });

  it("reportBuild sends modelName alongside projectName", async () => {
    mockJson({ success: true });

    await api.reportBuild({
      projectName: "m",
      environment: "production",
      status: "success",
      timestamp: new Date().toISOString(),
    });

    expect(lastRequestBody().modelName).toBe("m");
  });

  it("createProject unwraps the { success, model } envelope", async () => {
    mockJson({ success: true, model: { id: "abc", name: "m" } }, 201);

    const model = await api.createProject({
      name: "m",
      framework: "pytorch",
      path: ".",
    });

    expect(model.id).toBe("abc");
  });

  it("rollbackDeployment unwraps { deployment } and normalizes its status", async () => {
    mockJson({
      success: true,
      message: "ok",
      deployment: { id: "d2", status: "PENDING" },
      rolledBackFrom: { id: "d1", name: "m" },
    });

    const deployment = await api.rollbackDeployment("m", "production", "d1");

    expect(deployment.id).toBe("d2");
    expect(deployment.status).toBe("pending");
  });

  it("validateAuth reads the flat status body", async () => {
    mockJson({ valid: true, user: { email: "x@y.z" } });

    const auth = await api.validateAuth();

    expect(auth.valid).toBe(true);
    expect(auth.user?.email).toBe("x@y.z");
  });

  it("getDeployments maps raw uppercase statuses onto the lowercase union", async () => {
    mockJson({ success: true, data: [{ id: "d", status: "ACTIVE" }] });

    const deployments = await api.getDeployments("m");

    expect(deployments[0].status).toBe("success");
  });

  it("getDeployments lowercases statuses the map does not cover", async () => {
    mockJson({ success: true, data: [{ id: "d", status: "STOPPED" }] });

    const deployments = await api.getDeployments("m");

    expect(deployments[0].status).toBe("stopped");
  });
});
