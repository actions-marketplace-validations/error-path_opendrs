import { describe, expect, it } from "vitest";
import { computeSlowKinds } from "../../scripts/metrics-report.mjs";

function run(kind: string, durationMs: number) {
  return { kind, durationMs };
}

describe("computeSlowKinds", () => {
  it("flags a kind whose median duration is over the threshold as a parallelism candidate", () => {
    const runs = [run("bench:apachejit", 11 * 60_000), run("bench:apachejit", 12 * 60_000), run("test", 5_000)];

    const slow = computeSlowKinds(runs, 10 * 60_000);

    expect(slow).toEqual([{ kind: "bench:apachejit", count: 2, p50Ms: 11.5 * 60_000, maxMs: 12 * 60_000 }]);
  });

  it("does not flag a kind whose median duration is at or under the threshold", () => {
    const runs = [run("test", 9 * 60_000), run("test", 9 * 60_000)];

    const slow = computeSlowKinds(runs, 10 * 60_000);

    expect(slow).toEqual([]);
  });
});
