import { test } from "node:test";
import assert from "node:assert/strict";
import { computeSlowKinds } from "./metrics-report.mjs";

function run(kind, durationMs) {
  return { kind, durationMs };
}

test("flags a kind whose median duration is over the threshold as a parallelism candidate", () => {
  const runs = [run("bench:apachejit", 11 * 60_000), run("bench:apachejit", 12 * 60_000), run("test", 5_000)];

  const slow = computeSlowKinds(runs, 10 * 60_000);

  assert.deepEqual(slow, [{ kind: "bench:apachejit", count: 2, p50Ms: 11.5 * 60_000, maxMs: 12 * 60_000 }]);
});

test("does not flag a kind whose median duration is at or under the threshold", () => {
  const runs = [run("test", 9 * 60_000), run("test", 9 * 60_000)];

  const slow = computeSlowKinds(runs, 10 * 60_000);

  assert.deepEqual(slow, []);
});
