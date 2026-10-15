import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { backtest } from "../../src/model/backtest.js";
import { mapLimit, replayHistory } from "../../src/model/replay.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

describe("replayHistory", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("counts commits it cannot read and reports them, with unresolved incidents, as warnings", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "one\n" }, "init");
    repo.commit({ "a.ts": "two\n" }, "edit a");
    repo.commit({ "a.ts": "three\n" }, "edit a again");
    repo.commit({ "b.ts": "b\n" }, "add b");
    // Lose the blob "edit a" wrote: that commit and the next one can no longer be diffed.
    const blob = repo.git("rev-parse", "HEAD~2:a.ts");
    rmSync(join(repo.dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
    mkdirSync(join(repo.dir, ".opendrs"));
    writeFileSync(join(repo.dir, ".opendrs/incidents.jsonl"), '{"inducing":"deadbeef00"}\n');

    const { rows, skipped, warnings } = await replayHistory({ repoDir: repo.dir, config: defaultConfig() });
    expect(skipped).toBe(2);
    expect(rows.map((r) => r.sha)).toEqual([repo.git("rev-parse", "HEAD")]);
    expect(warnings).toEqual([
      expect.stringMatching(/inducing commit deadbeef00 .*not counted/),
      "2 commits skipped (unreadable)",
    ]);
    expect((await backtest({ repoDir: repo.dir, config: defaultConfig() })).notes).toContain("2 commits skipped (unreadable)");
  }, 60_000);
});

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
