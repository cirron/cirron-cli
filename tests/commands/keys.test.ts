import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("inquirer", () => ({
  default: { prompt: vi.fn() },
}));

import inquirer from "inquirer";
import {
  keysIssueCommand,
  keysListCommand,
  keysRevokeCommand,
  keysRotateCommand,
} from "../../src/commands/keys";
import type { InferenceKeyInfo, IssuedInferenceKey } from "../../src/types";
import { CirronApi } from "../../src/utils/api";
import { PlatformUnavailableError } from "../../src/utils/api-errors";
import { ConfigManager } from "../../src/utils/config";
import { makeTmpDir } from "../helpers/tmpdir";

const promptMock = vi.mocked(inquirer.prompt);

const stubApi = <K extends keyof CirronApi>(method: K, value: unknown) =>
  vi.spyOn(CirronApi.prototype, method).mockResolvedValue(value as never);

const stubApiReject = <K extends keyof CirronApi>(method: K, error: Error) =>
  vi.spyOn(CirronApi.prototype, method).mockRejectedValue(error as never);

function keyInfo(overrides: Partial<InferenceKeyInfo> = {}): InferenceKeyInfo {
  return {
    id: "key-1",
    prefix: "ifk-0123abcd",
    name: null,
    createdAt: "2026-08-13T00:00:00.000Z",
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function issued(
  overrides: Partial<IssuedInferenceKey> = {}
): IssuedInferenceKey {
  return {
    rawKey: `ifk-${"a".repeat(64)}`,
    key: keyInfo(),
    ...overrides,
  };
}

describe("keys commands", () => {
  let tmp: ReturnType<typeof makeTmpDir>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  const output = () =>
    [...errorSpy.mock.calls.flat(), ...logSpy.mock.calls.flat()].join(" ");

  beforeEach(() => {
    vi.clearAllMocks();
    tmp = makeTmpDir("cirron-keys-");
    vi.spyOn(os, "homedir").mockReturnValue(tmp.dir);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    tmp.cleanup();
  });

  const authenticate = () => {
    new ConfigManager().save({
      apiUrl: "http://localhost:1",
      defaultEnv: "production",
      timeout: 1000,
      retries: 0,
      token: "fake-token",
    });
  };

  describe("auth gating", () => {
    it("prompts to authenticate when no token is configured", async () => {
      await keysListCommand("dep-1");
      expect(output()).toMatch(/cirron auth login/);
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("issue", () => {
    beforeEach(authenticate);

    it("prints the raw key with the shown-once warning", async () => {
      const spy = stubApi("issueInferenceKey", issued());
      await keysIssueCommand("dep-1", { name: "prod" });

      expect(spy).toHaveBeenCalledWith("dep-1", { name: "prod" });
      expect(output()).toContain(`ifk-${"a".repeat(64)}`);
      expect(output()).toMatch(/shown once/i);
      expect(output()).toMatch(/Authorization: Bearer/);
      expect(exitSpy).not.toHaveBeenCalled();
    });

    it("passes a valid --expires-at through", async () => {
      const spy = stubApi("issueInferenceKey", issued());
      await keysIssueCommand("dep-1", { expiresAt: "2027-01-01T00:00:00Z" });
      expect(spy).toHaveBeenCalledWith("dep-1", {
        expiresAt: "2027-01-01T00:00:00Z",
      });
    });

    it("rejects a malformed --expires-at before any API call", async () => {
      const spy = stubApi("issueInferenceKey", issued());
      exitSpy.mockImplementation(() => {
        throw new Error("__exit__");
      });
      await expect(
        keysIssueCommand("dep-1", { expiresAt: "not-a-date" })
      ).rejects.toThrow("__exit__");
      expect(output()).toMatch(/Invalid --expires-at/);
      expect(spy).not.toHaveBeenCalled();
    });

    it("exits 1 when the platform rejects the request", async () => {
      stubApiReject(
        "issueInferenceKey",
        new PlatformUnavailableError("offline")
      );
      await keysIssueCommand("dep-1", {});
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });

  describe("list", () => {
    beforeEach(authenticate);

    it("renders prefixes and statuses, never key material", async () => {
      stubApi("listInferenceKeys", [
        keyInfo({ name: "prod" }),
        keyInfo({
          id: "key-2",
          prefix: "ifk-9999ffff",
          revokedAt: "2026-08-01T00:00:00.000Z",
        }),
        keyInfo({
          id: "key-3",
          prefix: "ifk-5555eeee",
          expiresAt: "2020-01-01T00:00:00.000Z",
        }),
      ]);
      await keysListCommand("dep-1");

      expect(output()).toContain("ifk-0123abcd");
      expect(output()).toMatch(/active/);
      expect(output()).toMatch(/revoked/);
      expect(output()).toMatch(/expired/);
      expect(output()).not.toContain("a".repeat(64));
    });

    it("hints at issue when the deployment has no keys", async () => {
      stubApi("listInferenceKeys", []);
      await keysListCommand("dep-1");
      expect(output()).toMatch(/cirron keys issue dep-1/);
    });
  });

  describe("rotate", () => {
    beforeEach(authenticate);

    it("prints the replacement key and the cutover warning", async () => {
      const spy = stubApi(
        "rotateInferenceKey",
        issued({ key: keyInfo({ name: "prod" }) })
      );
      await keysRotateCommand("dep-1", "key-1", {});

      expect(spy).toHaveBeenCalledWith("dep-1", "key-1", {});
      expect(output()).toMatch(/old key .*key-1.* is revoked/i);
      expect(output()).toContain(`ifk-${"a".repeat(64)}`);
    });
  });

  describe("revoke", () => {
    beforeEach(authenticate);

    it("revokes without prompting when --yes is passed", async () => {
      const spy = stubApi("revokeInferenceKey", undefined);
      await keysRevokeCommand("dep-1", "key-1", { yes: true });
      expect(spy).toHaveBeenCalledWith("dep-1", "key-1");
      expect(promptMock).not.toHaveBeenCalled();
    });

    it("cancels when the confirmation is declined", async () => {
      const spy = stubApi("revokeInferenceKey", undefined);
      promptMock.mockResolvedValue({ confirm: false });
      await keysRevokeCommand("dep-1", "key-1", {});
      expect(spy).not.toHaveBeenCalled();
      expect(output()).toMatch(/cancelled/i);
    });

    it("exits 1 when the platform rejects the revoke", async () => {
      stubApiReject(
        "revokeInferenceKey",
        new PlatformUnavailableError("offline")
      );
      await keysRevokeCommand("dep-1", "key-1", { yes: true });
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
