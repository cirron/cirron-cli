import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../../../src/utils/concurrency";

/**
 * `mapWithConcurrency` bounds parallel part uploads in push. The properties
 * that matter there: results stay aligned with their inputs, the in-flight
 * count never exceeds the limit (the registry rate-limits), and a failed part
 * rejects rather than silently producing a hole in the results.
 */
describe("mapWithConcurrency", () => {
  const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  it("returns results in input order, not completion order", async () => {
    const items = [30, 10, 20, 0];
    const results = await mapWithConcurrency(items, 4, async (ms) => {
      await tick(ms);
      return ms * 2;
    });
    expect(results).toEqual([60, 20, 40, 0]);
  });

  it("passes the index to the callback", async () => {
    const seen: [string, number][] = [];
    await mapWithConcurrency(["a", "b", "c"], 1, (item, index) => {
      seen.push([item, index]);
      return Promise.resolve(item);
    });
    expect(seen).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(Array.from({ length: 20 }), 4, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(1);
      inFlight--;
      return null;
    });

    expect(maxInFlight).toBeLessThanOrEqual(4);
    // Sanity: the limit was actually reached, so the assertion above is not
    // passing because everything ran serially.
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("runs serially when the limit is 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency([1, 2, 3], 1, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(1);
      inFlight--;
      return null;
    });

    expect(maxInFlight).toBe(1);
  });

  it("rejects with the first error", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, (n) => {
        if (n === 2) {
          return Promise.reject(new Error("part 2 failed"));
        }
        return Promise.resolve(n);
      })
    ).rejects.toThrow("part 2 failed");
  });

  it("stops scheduling new work after a rejection", async () => {
    const started: number[] = [];

    await expect(
      mapWithConcurrency([1, 2, 3, 4, 5, 6], 1, async (n) => {
        started.push(n);
        await tick(1);
        if (n === 2) {
          throw new Error("boom");
        }
        return n;
      })
    ).rejects.toThrow("boom");

    // With limit 1, nothing after the failing item should have started.
    expect(started).toEqual([1, 2]);
  });

  it("handles empty input", async () => {
    const results = await mapWithConcurrency([], 4, () =>
      Promise.reject(new Error("should never run"))
    );
    expect(results).toEqual([]);
  });

  it("handles a limit larger than the input length", async () => {
    const results = await mapWithConcurrency([1, 2], 100, (n) =>
      Promise.resolve(n + 1)
    );
    expect(results).toEqual([2, 3]);
  });
});
