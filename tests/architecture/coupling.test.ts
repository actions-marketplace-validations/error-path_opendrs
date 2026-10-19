import { afterEach, describe, expect, it } from "vitest";
import { couplingPairs } from "../../src/architecture/coupling.js";
import { detectCoupling } from "../../src/architecture/coupling.js";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import type { CommitInfo } from "../../src/domain/types.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "../signals/context.js";

const DEFAULT_OPTS = { minSupport: 5, minConfidence: 0.6, maxFilesPerCommit: 30, exclude: () => false };
// A fixed point in time so lookbackDays filtering does not depend on the real wall clock (tests/signals/history.test.ts's pattern).
const T = 1_700_000_000;

/** A minimal commit for couplingPairs, which only reads `files` and ignores everything else. */
function mkCommit(files: string[], time = 0): CommitInfo {
  return { sha: `s${time}-${files.join(",")}`, parents: [], authorName: "a", authorEmail: "a@x.com", time, subject: "x", files, isFix: false, isRevert: false, source: "human" };
}

describe("couplingPairs", () => {
  it("requires at least minSupport commits: 4 below, 5 meets it, both at confidence 1.0", () => {
    const below = Array.from({ length: 4 }, (_, i) => mkCommit(["a.ts", "b.ts"], i));
    expect(couplingPairs(below, ["a.ts"], DEFAULT_OPTS)).toEqual([]);

    const meets = Array.from({ length: 5 }, (_, i) => mkCommit(["a.ts", "b.ts"], i));
    expect(couplingPairs(meets, ["a.ts"], DEFAULT_OPTS)).toEqual([{ file: "a.ts", partner: "b.ts", support: 5, total: 5 }]);
  });

  it("requires at least minConfidence: 0.59 fails, 0.60 fires", () => {
    const low = [...Array.from({ length: 59 }, (_, i) => mkCommit(["a.ts", "b.ts"], i)), ...Array.from({ length: 41 }, (_, i) => mkCommit(["a.ts"], 100 + i))];
    expect(couplingPairs(low, ["a.ts"], DEFAULT_OPTS)).toEqual([]);

    const high = [...Array.from({ length: 60 }, (_, i) => mkCommit(["a.ts", "b.ts"], i)), ...Array.from({ length: 40 }, (_, i) => mkCommit(["a.ts"], 100 + i))];
    expect(couplingPairs(high, ["a.ts"], DEFAULT_OPTS)).toEqual([{ file: "a.ts", partner: "b.ts", support: 60, total: 100 }]);
  });

  it("excludes a commit touching more than maxFilesPerCommit files, but counts one at the limit", () => {
    const manyFiles = Array.from({ length: 31 }, (_, i) => `f${i}.ts`);
    const over = mkCommit(["a.ts", "b.ts", ...manyFiles], 1); // 33 files touched, including a.ts and b.ts
    const atLimit = mkCommit(["a.ts", "b.ts", ...manyFiles.slice(0, 28)], 2); // 30 files touched
    const base = Array.from({ length: 4 }, (_, i) => mkCommit(["a.ts", "b.ts"], 10 + i));
    const commits = [over, atLimit, ...base];
    // Only atLimit + the 4 base commits count: support 5, total 5.
    expect(couplingPairs(commits, ["a.ts"], DEFAULT_OPTS)).toEqual([{ file: "a.ts", partner: "b.ts", support: 5, total: 5 }]);
  });

  it("never reports a partner that the PR itself changed", () => {
    const commits = Array.from({ length: 5 }, (_, i) => mkCommit(["a.ts", "b.ts"], i));
    expect(couplingPairs(commits, ["a.ts", "b.ts"], DEFAULT_OPTS)).toEqual([]);
  });

  it("drops a file excluded by opts.exclude, as both A and B", () => {
    const commits = Array.from({ length: 5 }, (_, i) => mkCommit(["a.ts", "b.ts"], i));
    expect(couplingPairs(commits, ["a.ts"], { ...DEFAULT_OPTS, exclude: (p) => p === "b.ts" })).toEqual([]);
    expect(couplingPairs(commits, ["a.ts"], { ...DEFAULT_OPTS, exclude: (p) => p === "a.ts" })).toEqual([]);
  });

  it("reports only the highest-confidence partner when a file has two", () => {
    // Of 10 commits touching a.ts: b.ts is also touched in 8 (confidence 0.8), c.ts in 6 (confidence 0.6).
    const all3 = Array.from({ length: 6 }, (_, i) => mkCommit(["a.ts", "b.ts", "c.ts"], i));
    const aAndB = Array.from({ length: 2 }, (_, i) => mkCommit(["a.ts", "b.ts"], 10 + i));
    const aOnly = Array.from({ length: 2 }, (_, i) => mkCommit(["a.ts"], 20 + i));
    expect(couplingPairs([...all3, ...aAndB, ...aOnly], ["a.ts"], DEFAULT_OPTS)).toEqual([{ file: "a.ts", partner: "b.ts", support: 8, total: 10 }]);
  });
});

describe("detectCoupling", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("fires with the exact text from spec §6.1", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "0\n" }, "create a", undefined, T);
    repo.commit({ "b.ts": "0\n" }, "create b", undefined, T + 1);
    for (let i = 0; i < 5; i++) repo.commit({ "a.ts": `${i + 1}\n`, "b.ts": `${i + 1}\n` }, `co-change ${i}`, undefined, T + 2 + i);
    const base = repo.git("rev-parse", "HEAD");
    const head = repo.commit({ "a.ts": "9\n" }, "change a alone", undefined, T + 10);
    const ctx = await contextFor(repo, base, head, { asOf: T + 10 });
    const result = await detectCoupling(ctx, {});
    expect(result.notes).toEqual([]);
    expect(result.facts).toEqual([
      { id: "coupling.missing", weight: "strong", file: "a.ts", text: "`b.ts` changed with `a.ts` in 5 of 6 commits (last 365 days); this PR changes only `a.ts`." },
    ]);
  });

  it("reports no fact when the partner no longer exists at head", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "0\n", "b.ts": "0\n" }, "init", undefined, T);
    for (let i = 0; i < 5; i++) repo.commit({ "a.ts": `${i + 1}\n`, "b.ts": `${i + 1}\n` }, `co-change ${i}`, undefined, T + 1 + i);
    const base = repo.git("rev-parse", "HEAD");
    repo.commit({ "b.ts": null }, "delete b", undefined, T + 10); // b.ts is gone before the PR even starts
    const head = repo.commit({ "a.ts": "9\n" }, "change a alone", undefined, T + 11);
    const ctx = await contextFor(repo, base, head, { asOf: T + 11 });
    const result = await detectCoupling(ctx, {});
    expect(result.facts).toEqual([]);
  });

  it("excludes a docs partner and a lockfile partner", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "0\n", "README.md": "0\n", "package-lock.json": "0\n" }, "init", undefined, T);
    for (let i = 0; i < 5; i++) repo.commit({ "a.ts": `${i + 1}\n`, "README.md": `${i + 1}\n`, "package-lock.json": `${i + 1}\n` }, `co-change ${i}`, undefined, T + 1 + i);
    const base = repo.git("rev-parse", "HEAD");
    const head = repo.commit({ "a.ts": "9\n" }, "change a alone", undefined, T + 10);
    const ctx = await contextFor(repo, base, head, { asOf: T + 10 });
    const result = await detectCoupling(ctx, {});
    expect(result.facts).toEqual([]);
  });

  it("produces no facts and no notes when captain.coupling.enabled is false", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "0\n", "b.ts": "0\n" }, "init", undefined, T);
    for (let i = 0; i < 5; i++) repo.commit({ "a.ts": `${i + 1}\n`, "b.ts": `${i + 1}\n` }, `co-change ${i}`, undefined, T + 1 + i);
    const base = repo.git("rev-parse", "HEAD");
    const head = repo.commit({ "a.ts": "9\n" }, "change a alone", undefined, T + 10);
    const config = parseConfig({ captain: { coupling: { enabled: false } } });
    const ctx = await contextFor(repo, base, head, { config, asOf: T + 10 });
    const result = await detectCoupling(ctx, {});
    expect(result).toEqual({ facts: [], notes: [] });
  });

  it("reports nothing when no historical pair meets the configured defaults", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "0\n", "b.ts": "0\n" }, "init", undefined, T);
    const base = repo.git("rev-parse", "HEAD");
    const head = repo.commit({ "a.ts": "1\n" }, "change a alone", undefined, T + 1);
    const ctx = await contextFor(repo, base, head, { config: defaultConfig(), asOf: T + 1 });
    const result = await detectCoupling(ctx, {});
    expect(result.facts).toEqual([]);
  });
});
