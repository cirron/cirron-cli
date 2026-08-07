import type { CirronConfig } from "../types";

/**
 * True when either the device-flow JWT or a legacy sk-* token is present.
 *
 * This mirrors the credential precedence in `CirronApi.getAuthHeader()`
 * (src/utils/api.ts) exactly, and the two must stay in agreement: a command
 * that gates on less than the transport layer accepts will reject a login the
 * transport would have honored. If a third credential type is ever added, it
 * has to land in both places.
 */
export function isAuthenticated(config: CirronConfig): boolean {
  return Boolean(config.token || config.auth?.accessToken);
}
