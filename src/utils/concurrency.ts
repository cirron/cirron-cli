/**
 * Map `items` through `fn` with at most `limit` promises in flight.
 *
 * Results are returned in input order regardless of completion order. The
 * first rejection stops new work from being scheduled and rejects; work
 * already in flight is allowed to settle.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  // Shared across workers: a worker whose callback rejects exits its own loop,
  // but the others would happily keep pulling indices. For part uploads that
  // means pushing megabytes for an upload the caller is about to abort.
  let failed = false;

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (!failed && next < items.length) {
        const index = next++;
        try {
          results[index] = await fn(items[index] as T, index);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }
  );

  await Promise.all(workers);
  return results;
}
