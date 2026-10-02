import { describe, expect, it } from "vitest";
import { formatSize } from "../../../src/utils/format";

/**
 * These exact strings reach users in push/pull/sync progress output, so the
 * bracket boundaries and decimal counts are the contract.
 */
describe("formatSize", () => {
  it("formats bytes/KB/MB/GB correctly", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(2 * 1024 * 1024)).toBe("2.00 MB");
    expect(formatSize(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });

  it("switches unit exactly at each 1024 boundary", () => {
    expect(formatSize(1023)).toBe("1023 B");
    expect(formatSize(1024)).toBe("1.0 KB");
    expect(formatSize(1024 * 1024 - 1)).toBe("1024.0 KB");
    expect(formatSize(1024 * 1024)).toBe("1.00 MB");
    expect(formatSize(1024 * 1024 * 1024)).toBe("1.00 GB");
  });
});
