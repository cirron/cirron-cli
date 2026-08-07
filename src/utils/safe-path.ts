import path from "node:path";

/**
 * Resolve `candidate` against `baseDir` and verify the result stays inside
 * `baseDir`. Returns the resolved absolute path, or null if the candidate
 * escapes (via .., an absolute path, or drive-relative tricks).
 *
 * A candidate that resolves to `baseDir` itself is returned as the resolved
 * base — callers that expect a file always append a name component, so this
 * case is defensive.
 */
export function resolveWithin(
  baseDir: string,
  candidate: string
): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, candidate);
  const rel = path.relative(resolvedBase, resolved);

  if (rel === "") {
    return resolvedBase;
  }
  // `rel === ".."` / `"../…"` means the candidate climbed out of the base.
  // Compare against the separator rather than a bare `startsWith("..")` so a
  // legitimate file named `..weights.bin` is not mistaken for an escape.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
