/**
 * Map `items` through `fn` with at most `limit` promises in flight.
 *
 * Results are returned in input order regardless of completion order. The
 * first rejection stops new work from being scheduled; once the work already
 * in flight has settled, the call rejects with that first error. Callers can
 * rely on nothing still running when they handle the failure.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // Shared across workers: without it, a rejection stops one worker while the
  // rest keep pushing bytes for an upload the caller is about to abort.
  let failed = false;
  let firstError: unknown;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (!failed && next < items.length) {
        const index = next;
        next += 1;
        try {
          results[index] = await fn(items[index] as T, index);
        } catch (error) {
          if (!failed) {
            failed = true;
            firstError = error;
          }
        }
      }
    }
  );

  // Workers never reject, so this waits for every in-flight call to settle.
  await Promise.all(workers);
  if (failed) {
    throw firstError;
  }
  return results;
}
