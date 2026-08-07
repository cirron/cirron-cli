import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWithin } from "../../../src/utils/safe-path";

/**
 * `resolveWithin` is the containment guard for every path whose components
 * come from an API response. These cases are the threat model: a hostile
 * artifact filename or sync conflict path must never resolve outside the
 * directory the caller chose.
 */
describe("resolveWithin", () => {
  const base = path.resolve("/tmp/project");

  describe("contained candidates", () => {
    it("resolves a plain filename inside the base", () => {
      expect(resolveWithin(base, "file.txt")).toBe(path.join(base, "file.txt"));
    });

    it("resolves a nested relative path inside the base", () => {
      expect(resolveWithin(base, "models/weights.bin")).toBe(
        path.join(base, "models", "weights.bin")
      );
    });

    it("normalizes interior traversal that stays inside", () => {
      expect(resolveWithin(base, "a/../file.txt")).toBe(
        path.join(base, "file.txt")
      );
    });

    it("accepts a filename that merely starts with dots", () => {
      expect(resolveWithin(base, "..weights.bin")).toBe(
        path.join(base, "..weights.bin")
      );
    });

    it("resolves the base itself to the base", () => {
      expect(resolveWithin(base, ".")).toBe(base);
      expect(resolveWithin(base, "")).toBe(base);
    });

    it("resolves a relative base against cwd", () => {
      expect(resolveWithin("some-dir", "file.txt")).toBe(
        path.resolve("some-dir", "file.txt")
      );
    });
  });

  describe("escaping candidates", () => {
    it("rejects a single parent-directory hop", () => {
      expect(resolveWithin(base, "../evil")).toBeNull();
    });

    it("rejects a deep traversal", () => {
      expect(resolveWithin(base, "../../etc/passwd")).toBeNull();
    });

    it("rejects traversal buried mid-path", () => {
      expect(resolveWithin(base, "models/../../escape.txt")).toBeNull();
    });

    it("rejects a bare parent reference", () => {
      expect(resolveWithin(base, "..")).toBeNull();
    });

    it("rejects an absolute path", () => {
      const absolute =
        process.platform === "win32" ? "C:\\evil" : "/etc/passwd";
      expect(resolveWithin(base, absolute)).toBeNull();
    });

    it("rejects a traversal that lands on a sibling with a shared prefix", () => {
      expect(resolveWithin(base, "../project-evil/file.txt")).toBeNull();
    });
  });
});
