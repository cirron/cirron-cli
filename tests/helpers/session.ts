import os from "node:os";
import { vi } from "vitest";
import { ConfigManager } from "../../src/utils/config";

/**
 * Redirect HOME to the given tmp dir and persist a fully authenticated config.
 * Use in beforeEach to push a command past its `checkAuth` gate.
 */
export function createAuthenticatedSession(
  tmpDir: string,
  overrides: Partial<{
    apiUrl: string;
    defaultEnv: string;
    timeout: number;
    retries: number;
    token: string;
  }> = {}
): void {
  vi.spyOn(os, "homedir").mockReturnValue(tmpDir);
  new ConfigManager().save({
    apiUrl: overrides.apiUrl ?? "http://localhost:1",
    defaultEnv: overrides.defaultEnv ?? "production",
    timeout: overrides.timeout ?? 1000,
    retries: overrides.retries ?? 0,
    token: overrides.token ?? "fake-token",
    auth: {
      accessToken: "jwt-access",
      refreshToken: "jwt-refresh",
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
}
