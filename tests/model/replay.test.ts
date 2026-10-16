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

    const config = horizon(0);
    const { rows, skipped, warnings } = await replayHistory({ repoDir: repo.dir, config });
    expect(skipped).toBe(2);
    expect(rows.map((r) => r.sha)).toEqual([repo.git("rev-parse", "HEAD")]);
    expect(warnings).toEqual([
      expect.stringMatching(/inducing commit deadbeef00 .*not counted/),
      "2 commits skipped (unreadable)",
    ]);
    expect((await backtest({ repoDir: repo.dir, config })).notes).toContain("2 commits skipped (unreadable)");
  }, 60_000);

  describe("label horizon", () => {
    const DAY = 86_400;
    // Root at day 0 (no parent, never replayed), then one commit every 30 days up to day 180.
    const spreadRepo = () => {
      repo = makeRepo();
      return [0, 30, 60, 90, 120, 150, 180].map((d) => repo.commit({ "a.ts": `day ${d}\n` }, `day ${d}`, undefined, 1_600_000_000 + d * DAY));
    };

    it("leaves out commits newer than newest commit time minus the horizon, and says how many", async () => {
      const shas = spreadRepo();
      const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: horizon(60) });
      // Cutoff is day 120: day 120 is old enough, days 150 and 180 are not.
      expect(rows.map((r) => r.sha).sort()).toEqual(shas.slice(1, 5).sort());
      expect(warnings).toEqual(["2 commits newer than 60 days excluded from evaluation (their bugs may not be found yet)"]);
    }, 60_000);

    it("keeps every commit when the horizon is 0", async () => {
      const shas = spreadRepo();
      const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: horizon(0) });
      expect(rows.map((r) => r.sha).sort()).toEqual(shas.slice(1).sort());
      expect(warnings).toEqual([]);
    }, 60_000);

    it("reports the excluded count in the backtest notes", async () => {
      spreadRepo();
      const { notes } = await backtest({ repoDir: repo.dir, config: horizon(60) });
      expect(notes).toContain("2 commits newer than 60 days excluded from evaluation (their bugs may not be found yet)");
    }, 60_000);
  });

  describe("external labels and head", () => {
    const config = () => defaultConfig();

    it("replays exactly the labelled single-parent commits with the given labels", async () => {
      repo = makeRepo();
      repo.commit({ "a.ts": "1\n" }, "init");
      const b = repo.commit({ "a.ts": "2\n" }, "edit");
      const c = repo.commit({ "a.ts": "3\n" }, "edit again");
      repo.commit({ "a.ts": "4\n" }, "unlabelled");
      const { rows } = await replayHistory({ repoDir: repo.dir, config: config(), labels: new Map([[b, 1], [c, 0]]) });
      expect(rows.map((r) => [r.sha, r.label]).sort()).toEqual([[b, 1], [c, 0]].sort());
    });

    it("keeps a given 0 label where SZZ-lite would say 1", async () => {
      repo = makeRepo();
      repo.commit({ "a.ts": "x\n" }, "init");
      const bad = repo.commit({ "a.ts": "x\nbad\n" }, "add bad line");
      repo.commit({ "a.ts": "x\ngood\n" }, "fix bug in bad line");
      const { rows } = await replayHistory({ repoDir: repo.dir, config: config(), labels: new Map([[bad, 0]]) });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.label).toBe(0);
    });

    it("reports unknown, abbreviated and merge shas once as not found", async () => {
      repo = makeRepo();
      repo.commit({ "a.ts": "1\n" }, "init");
      const b = repo.commit({ "a.ts": "2\n" }, "edit");
      repo.git("checkout", "-q", "-b", "side", "HEAD~1");
      repo.commit({ "s.ts": "s\n" }, "side");
      repo.git("checkout", "-q", "main");
      repo.git("merge", "-q", "--no-edit", "side");
      const merge = repo.git("rev-parse", "HEAD");
      const labels = new Map<string, 0 | 1>([[b, 1], ["f".repeat(40), 1], [b.slice(0, 12), 1], [b.toUpperCase(), 1], [merge, 0]]);
      const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: config(), labels });
      expect(rows.map((r) => r.sha)).toEqual([b]);
      expect(warnings).toContain("4 labelled commits not found in the history up to HEAD");
    });

    it("does not apply the label horizon to labelled commits", async () => {
      repo = makeRepo();
      repo.commit({ "a.ts": "1\n" }, "init");
      const newest = repo.commit({ "a.ts": "2\n" }, "edit");
      const cfg = config();
      cfg.history.labelHorizonDays = 3650;
      const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: cfg, labels: new Map([[newest, 1]]) });
      expect(rows.map((r) => r.sha)).toEqual([newest]);
      expect(warnings.some((w) => w.includes("excluded from evaluation"))).toBe(false);
    });

    it("replays from head: later commits are not replayed and history is cut there", async () => {
      repo = makeRepo();
      repo.commit({ "a.ts": "1\n" }, "init");
      const b = repo.commit({ "a.ts": "2\n" }, "edit");
      const later = repo.commit({ "a.ts": "3\n" }, "later");
      const { rows, warnings } = await replayHistory({ repoDir: repo.dir, config: config(), head: b, labels: new Map([[b, 1], [later, 1]]) });
      expect(rows.map((r) => r.sha)).toEqual([b]);
      expect(warnings).toContain(`1 labelled commits not found in the history up to ${b}`);
    });
  });
});

function horizon(days: number) {
  const config = defaultConfig();
  config.history.labelHorizonDays = days;
  return config;
}

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
