import { describe, expect, it } from "vitest";
import { CLI_VERSION, USER_AGENT } from "../src/utils/version";

describe("CLI_VERSION", () => {
  it("is a non-empty semver-shaped string", () => {
    expect(CLI_VERSION).toBeTruthy();
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("is embedded in USER_AGENT", () => {
    expect(USER_AGENT).toBe(`cirron-cli/${CLI_VERSION}`);
  });
});
