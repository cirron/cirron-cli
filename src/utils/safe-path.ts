import path from "node:path";

/**
 * Resolve `candidate` against `baseDir` and verify the result lands strictly
 * inside `baseDir`. Returns the resolved absolute path, or null if it does not.
 *
 * Every caller wants a path to write a FILE at, so `baseDir` itself is a
 * rejection rather than a result: `""`, `"."` and `"./"` all resolve to the
 * base, and returning it lets a caller treat the project directory as a
 * destination. `keep-both` would then derive `<projectDir>.local` — a sibling,
 * outside the very directory this function exists to contain writes to.
 *
 * This is a LEXICAL check. It does not resolve symlinks, so a symlink that
 * lives inside `baseDir` and points outside it still passes. Guarding that
 * needs `fs.realpath` at the call site, which is a different (and racy)
 * problem; this function bounds the path string only.
 * @returns The resolved absolute path, or null when the candidate escapes the
 * base.
 */
export function resolveWithin(
  baseDir: string,
  candidate: string
): string | null {
  const resolvedBase = path.resolve(baseDir);
  const resolved = path.resolve(resolvedBase, candidate);
  const rel = path.relative(resolvedBase, resolved);

  if (rel === "") {
    return null;
  }
  // Compare against the separator, not a bare startsWith(".."), so a real
  // file named `..weights.bin` is not mistaken for climbing out of the base.
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return resolved;
}
