/**
 * Dotted-path access into plain config objects, shared by `cirron config` and
 * `cirron settings`.
 *
 * The `any` signatures are carried over verbatim from the two byte-identical
 * copies these replace. Config trees here are arbitrary user JSON/YAML, so
 * narrowing them is a separate change with its own risk.
 */

/**
 * Segments that would walk into the prototype chain instead of the object's
 * own data. A key path containing one is never a real config key.
 */
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function forbiddenSegment(keys: string[]): string | undefined {
  return keys.find((key) => FORBIDDEN_SEGMENTS.has(key));
}

function isTraversable(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

/**
 * Read `a.b.c`, following own properties only.
 *
 * @param obj - The config tree to read from.
 * @param path - A dotted key path.
 * @returns The value, or undefined if any segment is missing or the path
 *   contains `__proto__`, `constructor` or `prototype`.
 */
export function getNestedValue(obj: any, path: string): any {
  const keys = path.split(".");
  if (forbiddenSegment(keys)) {
    return;
  }

  let current: unknown = obj;
  for (const key of keys) {
    if (!(isTraversable(current) && Object.hasOwn(current, key))) {
      return;
    }
    current = current[key];
  }
  return current;
}

/**
 * Write `a.b.c`, creating missing intermediate objects.
 *
 * @param obj - The config tree to write into.
 * @param path - A dotted key path.
 * @param value - The value to store at the final segment.
 * @throws If the path contains `__proto__`, `constructor` or `prototype`, or
 *   if an existing intermediate value is not an object.
 */
export function setNestedValue(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  const forbidden = forbiddenSegment(keys);
  if (forbidden) {
    throw new Error(
      `Invalid key path "${path}": "${forbidden}" is not allowed`
    );
  }

  const lastKey = keys.pop()!;
  let current: Record<string, any> = obj;
  const walked: string[] = [];
  for (const key of keys) {
    walked.push(key);
    if (!Object.hasOwn(current, key)) {
      current[key] = {};
    } else if (!isTraversable(current[key])) {
      throw new Error(
        `Cannot set "${path}": "${walked.join(".")}" is not an object`
      );
    }
    current = current[key];
  }
  current[lastKey] = value;
}

/**
 * Delete `a.b.c`, following own properties only.
 *
 * @param obj - The config tree to delete from.
 * @param path - A dotted key path.
 * @returns Whether the key was present and removed. Always false for a path
 *   containing `__proto__`, `constructor` or `prototype`.
 */
export function deleteNestedValue(obj: any, path: string): boolean {
  const keys = path.split(".");
  if (forbiddenSegment(keys)) {
    return false;
  }

  const lastKey = keys.pop()!;
  const target = keys.length > 0 ? getNestedValue(obj, keys.join(".")) : obj;
  if (isTraversable(target) && Object.hasOwn(target, lastKey)) {
    delete target[lastKey];
    return true;
  }
  return false;
}
