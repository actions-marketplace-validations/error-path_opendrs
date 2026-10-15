import { describe, expect, it } from "vitest";
import { mapLimit } from "../../src/model/replay.js";

describe("mapLimit", () => {
  it("preserves input order, bounds concurrency and reports progress", async () => {
    let running = 0;
    let peak = 0;
    const progress: number[] = [];
    const items = Array.from({ length: 30 }, (_, i) => i);
    const out = await mapLimit(
      items,
      8,
      async (x) => {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, (x * 7) % 5));
        running--;
        return x * 2;
      },
      (done) => progress.push(done),
    );
    expect(out).toEqual(items.map((x) => x * 2));
    expect(peak).toBe(8);
    expect(progress).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });

  it("rejects when a task fails", async () => {
    await expect(mapLimit([1, 2, 3], 2, async (x) => (x === 2 ? Promise.reject(new Error("boom")) : x))).rejects.toThrow("boom");
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 8, async (x: number) => x)).toEqual([]);
  });
});
