import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Create a fresh tmp directory for a test, returning the path and a cleanup
 * function. Callers should invoke cleanup in afterEach (or use the disposable
 * pattern below).
 *
 * Each tmp dir is unique per call, so tests can run in parallel without
 * clobbering one another.
 */
export function makeTmpDir(prefix = "cirron-test-"): {
  dir: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run a function with a fresh tmp dir, cleaning up afterwards even on error.
 * Returns whatever the callback returns. Useful when a single test only needs
 * one tmp dir.
 */
export async function withTmpDir<T>(
  fn: (dir: string) => T | Promise<T>,
  prefix = "cirron-test-"
): Promise<T> {
  const { dir, cleanup } = makeTmpDir(prefix);
  try {
    return await fn(dir);
  } finally {
    cleanup();
  }
}
