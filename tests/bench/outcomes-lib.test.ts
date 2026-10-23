import { describe, expect, it } from "vitest";
import {
  addedLines,
  changesRequested,
  conclude,
  countedComments,
  drift,
  fixCandidates,
  hitsOnPr,
  isRevertOfPr,
  labelFact,
  partnerOf,
  prRange,
  priorityTable,
  rateLimitWaitMs,
  renderResults,
  resolveMergeShape,
  selectPulls,
  summarise,
  type BlameHit,
  type CommentLoc,
  type FactRecord,
  type FactTypeSummary,
  type PrFile,
} from "../../bench/outcomes/lib.js";

const DAY = 86_400;
const T = 1_800_000_000; // head time (s)
const iso = (s: number) => new Date(s * 1000).toISOString();
const pull = (n: number, created: number, merged: number | null, type = "User") => ({
  number: n,
  created_at: iso(created),
  merged_at: merged === null ? null : iso(merged),
  merge_commit_sha: `sha${n}`,
  user: { login: `u${n}`, type },
});

describe("selectPulls", () => {
  const o = { windowDays: 90, lookbackDays: 365, perRepo: 2 };
  it("keeps merged, non-bot PRs merged at least a window before head, newest-merged first, capped at perRepo", () => {
    const pulls = [pull(5, T - 10 * DAY, T - 5 * DAY), pull(4, T - 100 * DAY, T - 95 * DAY), pull(3, T - 120 * DAY, T - 91 * DAY), pull(2, T - 200 * DAY, T - 150 * DAY), pull(1, T - 300 * DAY, null)];
    const r = selectPulls(pulls, T, o);
    expect(r.selected.map((p) => p.number)).toEqual([3, 4]);
    expect(r.excluded).toEqual([
      { number: 5, reason: "merged-inside-window" },
      { number: 1, reason: "not-merged" },
    ]);
    expect(r.stopPaging).toBe(false);
  });
  it("excludes bots and PRs created before the lookback, and stops paging once a page reaches past it", () => {
    const pulls = [pull(9, T - 100 * DAY, T - 95 * DAY, "Bot"), pull(8, T - 500 * DAY, T - 95 * DAY)];
    const r = selectPulls(pulls, T, o);
    expect(r.selected).toEqual([]);
    expect(r.excluded).toEqual([
      { number: 9, reason: "bot" },
      { number: 8, reason: "too-old" },
    ]);
    expect(r.stopPaging).toBe(true);
  });
});

describe("rateLimitWaitMs", () => {
  it("waits until reset (plus a second) only when under the minimum", () => {
    expect(rateLimitWaitMs(4000, 1000, 900)).toBe(0);
    expect(rateLimitWaitMs(150, 1000, 900)).toBe(101_000);
    expect(rateLimitWaitMs(0, 800, 900)).toBe(1000);
  });
});

describe("resolveMergeShape / prRange", () => {
  it("merge commit → M^1..M^2", () => {
    expect(resolveMergeShape({ parents: ["a", "b"], subject: "Merge pull request #7", commits: 3, number: 7 })).toBe("merge");
    expect(prRange("merge", "M", 3)).toEqual({ base: "M^1", head: "M^2", revList: "M^1..M^2" });
  });
  it("one parent with (#N) or a single commit → squash", () => {
    expect(resolveMergeShape({ parents: ["a"], subject: "fix: x (#7)", commits: 4, number: 7 })).toBe("squash");
    expect(resolveMergeShape({ parents: ["a"], subject: "fix: x", commits: 1, number: 7 })).toBe("squash");
    expect(prRange("squash", "M", 4)).toEqual({ base: "M^1", head: "M", revList: "M^1..M" });
  });
  it("one parent, several commits, no (#N) → rebase over k commits", () => {
    expect(resolveMergeShape({ parents: ["a"], subject: "fix: x", commits: 3, number: 7 })).toBe("rebase");
    expect(prRange("rebase", "M", 3)).toEqual({ base: "M~3", head: "M", revList: "M~3..M" });
  });
});

describe("labelFact", () => {
  const files: PrFile[] = [
    { path: "a.ts", ignored: false, addedLines: [10, 11, 12, 40] },
    { path: "b.ts", ignored: false, addedLines: [5] },
    { path: "lock.json", ignored: true, addedLines: [1] },
  ];
  const comments: CommentLoc[] = [
    { path: "a.ts", line: 15 },
    { path: "a.ts", line: null },
  ];
  const hits: BlameHit[] = [{ sha: "h", path: "b.ts", line: 5 }];
  const ctx = { slug: "r", number: 1, files, comments, hits, reverted: false, fixTouched: new Set(["z.ts"]) };

  it("file-level labels and per-PR expected rates over non-ignored files", () => {
    const r = labelFact({ id: "contract.api", weight: "strong", file: "a.ts", line: 10, text: "" }, ctx);
    expect(r).toMatchObject({ slug: "r", number: 1, id: "contract.api", E_file: true, F_file: false, R: false, E_line: true, F_line: false, expE_file: 0.5, expF_file: 0.5 });
    expect(r.expE_line).toBeCloseTo(3 / 4); // 10, 11, 12 are within ±10 of 15; 40 is not
    expect(r.expF_line).toBe(0);
  });
  it("a fact without a line has no line labels; a null-line comment counts for E_file only", () => {
    const r = labelFact({ id: "contract.schema", weight: "strong", file: "a.ts", text: "" }, { ...ctx, comments: [{ path: "a.ts", line: null }] });
    expect(r.E_file).toBe(true);
    expect(r.E_line).toBeUndefined();
    expect(r.expE_line).toBeUndefined();
  });
  it("a fact on a file with no added lines gets expected line rates of 0, not NaN", () => {
    const r = labelFact({ id: "contract.api", weight: "strong", file: "c.ts", line: 3, text: "" }, { ...ctx, files: [...files, { path: "c.ts", ignored: false, addedLines: [] }] });
    expect(r.expE_line).toBe(0);
    expect(r.expF_line).toBe(0);
  });
  it("R comes from the PR and F_line matches a hit within the line window", () => {
    const r = labelFact({ id: "contract.api", weight: "strong", file: "b.ts", line: 12, text: "" }, { ...ctx, reverted: true });
    expect(r).toMatchObject({ R: true, F_file: true, F_line: true, E_file: false });
  });
  it("coupling facts get P_partner from the detector's text", () => {
    const text = "`z.ts` changed with `a.ts` in 9 of 10 commits (last 365 days); this PR changes only `a.ts`.";
    expect(partnerOf(text)).toBe("z.ts");
    expect(partnerOf("Removes exported `x`")).toBeUndefined();
    expect(labelFact({ id: "coupling.missing", weight: "strong", file: "a.ts", text }, ctx).P_partner).toBe(true);
    expect(labelFact({ id: "contract.api", weight: "strong", file: "a.ts", text: "" }, ctx).P_partner).toBeUndefined();
  });
});

describe("comments, hits, fixes, reverts", () => {
  it("countedComments drops bots and the PR author and prefers line over original_line", () => {
    const cs = [
      { path: "a", line: 3, original_line: 2, user: { login: "rev", type: "User" } },
      { path: "a", line: null, original_line: 7, user: { login: "rev", type: "User" } },
      { path: "a", line: null, original_line: null, user: { login: "rev", type: "User" } },
      { path: "a", line: 1, original_line: 1, user: { login: "author", type: "User" } },
      { path: "a", line: 1, original_line: 1, user: { login: "x[bot]", type: "Bot" } },
    ];
    expect(countedComments(cs, "author")).toEqual([
      { path: "a", line: 3 },
      { path: "a", line: 7 },
      { path: "a", line: null },
    ]);
  });
  it("changesRequested ignores bot reviews", () => {
    expect(changesRequested([{ state: "CHANGES_REQUESTED", user: { type: "Bot" } }])).toBe(false);
    expect(changesRequested([{ state: "APPROVED", user: { type: "User" } }])).toBe(false);
    expect(changesRequested([{ state: "CHANGES_REQUESTED", user: { type: "User" } }])).toBe(true);
  });
  it("hitsOnPr matches any PR commit", () => {
    expect(hitsOnPr([{ sha: "mid", path: "a", line: 1 }, { sha: "other", path: "a", line: 2 }], ["head", "mid"])).toEqual([{ sha: "mid", path: "a", line: 1 }]);
  });
  const c = (sha: string, time: number, files: string[], extra: Record<string, unknown> = {}) => ({ sha, parents: ["p"], time, subject: "fix: x", files, isFix: true, isRevert: false, ...extra });
  it("fixCandidates: non-merge fix/revert commits inside (merged, merged+W] touching a PR file", () => {
    const commits = [
      c("in", 100 + DAY, ["a"]),
      c("revert", 100 + 2 * DAY, ["a"], { isFix: false, isRevert: true }),
      c("late", 100 + 91 * DAY, ["a"]),
      c("before", 100, ["a"]),
      c("other", 100 + DAY, ["q"]),
      c("merge", 100 + DAY, ["a"], { parents: ["p", "q"] }),
      c("notfix", 100 + DAY, ["a"], { isFix: false }),
    ];
    expect(fixCandidates(commits, 100, 90, new Set(["a"])).map((x) => x.sha)).toEqual(["in", "revert"]);
  });
  it("isRevertOfPr by revertsSha prefix or by subject", () => {
    const pr = { commits: ["abcdef0123456789", "fedcba9876543210"], mergeSubject: "feat: y (#3)" };
    expect(isRevertOfPr([c("r", 1, [], { revertsSha: "abcdef0", isRevert: true })], pr)).toBe(true);
    expect(isRevertOfPr([c("r", 1, [], { subject: 'Revert "feat: y (#3)"', isRevert: true })], pr)).toBe(true);
    expect(isRevertOfPr([c("r", 1, [], { subject: 'Revert "other"', revertsSha: "999", isRevert: true })], pr)).toBe(false);
  });
  it("addedLines walks hunks by new-side line numbers", () => {
    expect(addedLines([{ newStart: 10, lines: [" ctx", "+a", "-b", "+c", "\\ No newline", "", "+d"] }])).toEqual([11, 12, 14]);
  });
});

describe("conclude", () => {
  it("applies spec §7 exactly", () => {
    expect(conclude(29, 5, 5)).toBe("insufficient");
    expect(conclude(30, 1.2, 0.5)).toBe("keep");
    expect(conclude(30, 0.5, 1.2)).toBe("keep");
    expect(conclude(30, 1.19, 1.0)).toBe("retune");
    expect(conclude(30, 0.99, 0.99)).toBe("demote");
    expect(conclude(30, NaN, NaN)).toBe("demote");
  });
});

const rec = (id: string, E: boolean, F: boolean, expE: number, expF: number, extra: Partial<FactRecord> = {}): FactRecord => ({
  slug: "r",
  number: 1,
  id,
  weight: "strong",
  file: "f",
  E_file: E,
  F_file: F,
  R: false,
  expE_file: expE,
  expF_file: expF,
  ...extra,
});

describe("summarise", () => {
  it("computes rates, lifts and the no-outcome share per fact type", () => {
    const [s] = summarise([rec("contract.api", true, false, 0.25, 0.5), rec("contract.api", false, false, 0.25, 0.5, { number: 2 })]);
    expect(s).toMatchObject({ id: "contract.api", fires: 2, prs: 2, strong: 2, E_file: 0.5, expE_file: 0.25, liftE_file: 2, F_file: 0, expF_file: 0.5, liftF_file: 0, R: 0, noOutcome: 0.5, conclusion: "insufficient" });
  });
  it("line lifts only over facts that have a line; a lift with zero expected and zero observed is NaN", () => {
    const [s] = summarise([rec("contract.api", false, false, 0, 0, { line: 3, E_line: true, expE_line: 0.5, F_line: false, expF_line: 0 }), rec("contract.api", false, false, 0, 0)]);
    expect(s!.liftE_line).toBe(2);
    expect(s!.liftF_line).toBeNaN();
    expect(s!.liftE_file).toBeNaN();
  });
  it("P_partner is averaged only when present, and types are sorted by id", () => {
    const out = summarise([rec("coupling.missing", false, false, 0, 0, { P_partner: true }), rec("coupling.missing", false, false, 0, 0, { P_partner: false }), rec("contract.api", false, false, 0, 0)]);
    expect(out.map((s) => s.id)).toEqual(["contract.api", "coupling.missing"]);
    expect(out[1]!.P_partner).toBe(0.5);
    expect(out[0]!.P_partner).toBeUndefined();
  });
});

describe("priorityTable", () => {
  it("rates per tier, base rate, recall at careful, informative flag", () => {
    const prs = [
      ...Array<{ priority: "careful" | "standard" | "quick"; fixedOrReverted: boolean }>(30).fill({ priority: "careful", fixedOrReverted: true }),
      ...Array<{ priority: "careful" | "standard" | "quick"; fixedOrReverted: boolean }>(30).fill({ priority: "careful", fixedOrReverted: false }),
      ...Array<{ priority: "careful" | "standard" | "quick"; fixedOrReverted: boolean }>(40).fill({ priority: "quick", fixedOrReverted: false }),
    ];
    const t = priorityTable(prs);
    expect(t.base).toBeCloseTo(0.3);
    expect(t.rows.find((r) => r.priority === "careful")).toEqual({ priority: "careful", n: 60, fixedOrReverted: 30, rate: 0.5 });
    expect(t.rows.find((r) => r.priority === "standard")).toEqual({ priority: "standard", n: 0, fixedOrReverted: 0, rate: NaN });
    expect(t.recallAtCareful).toBe(1);
    expect(t.informative).toBe(true);
  });
  it("is not informative under 30 careful PRs even with a high rate", () => {
    const prs = [...Array(10).fill({ priority: "careful" as const, fixedOrReverted: true }), ...Array(40).fill({ priority: "quick" as const, fixedOrReverted: false })];
    expect(priorityTable(prs).informative).toBe(false);
  });
});

describe("drift", () => {
  it("reports fire-count moves over the tolerance and conclusion changes", () => {
    const b = [
      { id: "a", fires: 100, conclusion: "keep" },
      { id: "b", fires: 10, conclusion: "insufficient" },
      { id: "d", fires: 10, conclusion: "insufficient" },
    ] as FactTypeSummary[];
    const c = [
      { id: "a", fires: 130, conclusion: "keep" },
      { id: "b", fires: 10, conclusion: "retune" },
      { id: "c", fires: 5, conclusion: "insufficient" },
    ] as FactTypeSummary[];
    expect(drift(b, c)).toEqual(["a: fires 100 → 130 (+30 %)", "b: conclusion insufficient → retune", "c: new fact type (5 fires)", "d: no longer fires (was 10)"]);
  });
  it("is empty when nothing moved", () => {
    const b = [{ id: "a", fires: 100, conclusion: "keep" }] as FactTypeSummary[];
    expect(drift(b, [{ id: "a", fires: 110, conclusion: "keep" }] as FactTypeSummary[])).toEqual([]);
  });
});

describe("renderResults", () => {
  it("names every fact type, the priority rows and the drift lines", () => {
    const facts = summarise([rec("contract.api", true, false, 0.25, 0.5)]);
    const md = renderResults({
      builtAt: "2026-10-23T00:00:00Z",
      corpus: { repos: 1, prs: 1, excluded: 0 },
      facts,
      priority: priorityTable([{ priority: "careful", fixedOrReverted: true }]),
      drift: ["a: fires 1 → 2 (+100 %)"],
      timings: { build: 1234 },
    });
    expect(md).toContain("`contract.api`");
    expect(md).toContain("careful");
    expect(md).toContain("a: fires 1 → 2 (+100 %)");
    expect(md).toContain("insufficient");
  });
});
