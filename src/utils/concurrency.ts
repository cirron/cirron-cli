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

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index] as T, index);
      }
    }
  );

  await Promise.all(workers);
  return results;
}
