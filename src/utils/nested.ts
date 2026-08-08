/**
 * Dotted-path access into plain config objects, shared by `cirron config` and
 * `cirron settings`.
 *
 * The `any` signatures are carried over verbatim from the two byte-identical
 * copies these replace. Config trees here are arbitrary user JSON/YAML, so
 * narrowing them is a separate change with its own risk.
 */

/** Read `a.b.c`, or undefined if any segment is missing. */
export function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((current, key) => current?.[key], obj);
}

/**
 * Write `a.b.c`, creating intermediate objects as needed.
 *
 * NOTE: the intermediate creation is unguarded, so a path containing
 * `__proto__` or `constructor` walks into the prototype chain. That is
 * pre-existing behavior, pinned by a test in `tests/unit/utils/nested.test.ts`
 * rather than changed here; hardening it is its own change.
 */
export function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => {
    if (!(key in current)) {
      current[key] = {};
    }
    return current[key];
  }, obj);
  target[lastKey] = value;
}

/** Delete `a.b.c`. Returns whether the key was actually present. */
export function deleteNestedValue(obj: any, path: string): boolean {
  const keys = path.split(".");
  const lastKey = keys.pop()!;
  const target = keys.reduce((current, key) => current?.[key], obj);

  if (target && lastKey in target) {
    delete target[lastKey];
    return true;
  }
  return false;
}
