# Outcome labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `bench/outcomes/` harness that fetches merged PRs from six public repos, recomputes the captain brief each PR would have had, labels every fact by reviewer engagement and later fixes, and reports per-fact-type lifts, conclusions, the priority hit rate and drift against a committed baseline.

**Architecture:** `bench/outcomes/lib.ts` holds every pure function (PR selection, merge-shape resolution, label computation, lifts, decision rule, drift, report rendering) and is unit-tested without network, git or `dist/`. `bench/outcomes/run.ts` is the I/O shell (`gh api`, git, `scoreDiff` from `dist/`, cache under `~/.cache/opendrs/outcomes/`) with four resumable steps: `fetch`, `build`, `label`, `eval`. Same split and style as `bench/verify/{lib,run}.ts`.

**Tech Stack:** TypeScript/ESM, Node ≥ 22 (run.ts uses native type stripping like `bench/verify/run.ts`), vitest, `gh api` (read-only), git. No LLM, no paid API.

**Spec:** `docs/specs/2026-10-23-outcome-labels-design.md`

## Global Constraints

- Never push; commit trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- No LLM or paid API calls anywhere in the harness; `scoreDiff` always gets `llm: null`.
- `run.ts` is excluded from `tsc --noEmit` (root `tsconfig.json` already excludes `bench/**/run.ts`); `lib.ts` is type-checked and unit-tested.
- Scoped tests only: `npx vitest run tests/bench/outcomes-lib.test.ts` and `npx tsc --noEmit`, both under `node scripts/record-run.mjs`.
- Cache root `~/.cache/opendrs/outcomes/`; clones deleted at the end unless `--keep-clones`.
- Decision rule constants: window 90 days, ±10 lines, 30 fires, 1.2× bar, 60 PRs per repo (spec §3, §5, §7).

## Review Focus

1. A review comment whose `line` and `original_line` are both null (outdated, no position) — must count for `E_file`, never for `E_line` (Task 3).
2. A merge commit whose PR `commits` is 1 but the subject lacks `(#N)` — must resolve to `squash`, base `M^1` (Task 2).
3. A fact on an ignored or deleted file (no added lines) — expected line rates must be 0 and the fact must still be labelled at file level without a division by zero (Task 3, Task 4).
4. A fix commit inside the window that touches none of the PR's files — must not be blamed at all (Task 3 `fixCandidates`).
5. A PR whose blamed hit lands on an intermediate commit of a merge-commit PR — `hitsOnPr` must match any commit in the PR's commit list, not only `head` (Task 3).

---

### Task 1: PR selection and rate-limit arithmetic

**Files:**
- Create: `bench/outcomes/lib.ts`
- Test: `tests/bench/outcomes-lib.test.ts`

**Interfaces:**
- Produces:
  - `interface GhPullSummary { number; created_at; merged_at: string | null; merge_commit_sha; user: { login; type } }`
  - `selectPulls(pulls: GhPullSummary[], headTimeSec: number, o: { windowDays; lookbackDays; perRepo }): { selected: GhPullSummary[]; excluded: Array<{ number; reason: "not-merged" | "merged-inside-window" | "too-old" | "bot" }>; stopPaging: boolean }` — `stopPaging` is true when the oldest `created_at` on the page is before `headTime − window − lookback`.
  - `rateLimitWaitMs(remaining: number, resetEpochSec: number, nowSec: number, min = 200): number`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { rateLimitWaitMs, selectPulls } from "../../bench/outcomes/lib.js";

const DAY = 86_400;
const T = 1_800_000_000; // head time (s)
const iso = (s: number) => new Date(s * 1000).toISOString();
const pull = (n: number, created: number, merged: number | null, type = "User") => ({ number: n, created_at: iso(created), merged_at: merged === null ? null : iso(merged), merge_commit_sha: `sha${n}`, user: { login: `u${n}`, type } });

describe("selectPulls", () => {
  const o = { windowDays: 90, lookbackDays: 365, perRepo: 2 };
  it("keeps merged, non-bot PRs merged at least a window before head, newest-merged first, capped at perRepo", () => {
    const pulls = [pull(5, T - 10 * DAY, T - 5 * DAY), pull(4, T - 100 * DAY, T - 95 * DAY), pull(3, T - 120 * DAY, T - 91 * DAY), pull(2, T - 200 * DAY, T - 150 * DAY), pull(1, T - 300 * DAY, null)];
    const r = selectPulls(pulls, T, o);
    expect(r.selected.map((p) => p.number)).toEqual([3, 4]);
    expect(r.excluded).toEqual([{ number: 5, reason: "merged-inside-window" }, { number: 1, reason: "not-merged" }]);
    expect(r.stopPaging).toBe(false);
  });
  it("excludes bots and PRs created before the lookback, and stops paging once a page reaches past it", () => {
    const pulls = [pull(9, T - 100 * DAY, T - 95 * DAY, "Bot"), pull(8, T - 500 * DAY, T - 95 * DAY)];
    const r = selectPulls(pulls, T, o);
    expect(r.selected).toEqual([]);
    expect(r.excluded).toEqual([{ number: 9, reason: "bot" }, { number: 8, reason: "too-old" }]);
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
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/bench/outcomes-lib.test.ts` → fails: module not found.

- [ ] **Step 3: Implement** in `bench/outcomes/lib.ts`:

```ts
export interface GhPullSummary { number: number; created_at: string; merged_at: string | null; merge_commit_sha: string; user: { login: string; type: string } }
export type ExclusionReason = "not-merged" | "merged-inside-window" | "too-old" | "bot" | "not-first-parent" | "diff-mismatch" | "brief-failed";
const DAY = 86_400;
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export function selectPulls(pulls, headTimeSec, o) {
  const cutoff = headTimeSec - o.windowDays * DAY;
  const oldest = cutoff - o.lookbackDays * DAY;
  const selected = []; const excluded = [];
  for (const p of pulls) {
    if (p.merged_at === null) excluded.push({ number: p.number, reason: "not-merged" });
    else if (sec(p.merged_at) > cutoff) excluded.push({ number: p.number, reason: "merged-inside-window" });
    else if (sec(p.created_at) < oldest) excluded.push({ number: p.number, reason: "too-old" });
    else if (p.user.type === "Bot") excluded.push({ number: p.number, reason: "bot" });
    else selected.push(p);
  }
  selected.sort((a, b) => sec(b.merged_at!) - sec(a.merged_at!));
  const stopPaging = pulls.some((p) => sec(p.created_at) < oldest);
  return { selected: selected.slice(0, o.perRepo), excluded, stopPaging };
}
export function rateLimitWaitMs(remaining, resetEpochSec, nowSec, min = 200) {
  return remaining >= min ? 0 : Math.max(0, resetEpochSec - nowSec) * 1000 + 1000;
}
```

- [ ] **Step 4: Run to verify it passes.**
- [ ] **Step 5: Commit** — `git add bench/outcomes/lib.ts tests/bench/outcomes-lib.test.ts && git commit -m "bench(outcomes): PR selection rule and rate-limit wait"`.

### Task 2: Merge-shape resolution and PR range

**Files:**
- Modify: `bench/outcomes/lib.ts`
- Test: `tests/bench/outcomes-lib.test.ts`

**Interfaces:**
- Produces: `type MergeShape = "merge" | "squash" | "rebase"`; `resolveMergeShape(m: { parents: string[]; subject: string; commits: number; number: number }): MergeShape`; `prRange(shape: MergeShape, mergeSha: string, commits: number): { base: string; head: string; revList: string }` (`revList` is the `git rev-list` range whose commits are the PR's).

- [ ] **Step 1: Failing tests**

```ts
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
```

- [ ] **Step 2: Run, fails.** **Step 3: Implement** (`subject.trimEnd().endsWith(`(#${number})`)`). **Step 4: Run, passes.** **Step 5: Commit** `bench(outcomes): merge-shape resolution`.

### Task 3: Outcome labels for one fact

**Files:**
- Modify: `bench/outcomes/lib.ts`
- Test: `tests/bench/outcomes-lib.test.ts`

**Interfaces:**
- Produces:
  - `interface CommentLoc { path: string; line: number | null }`; `countedComments(comments: Array<{ path; line: number | null; original_line: number | null; user: { login; type } }>, prAuthor: string): CommentLoc[]`
  - `changesRequested(reviews: Array<{ state; user: { type } }>): boolean`
  - `interface BlameHit { sha: string; path: string; line: number }`; `hitsOnPr(hits: BlameHit[], prCommits: readonly string[]): BlameHit[]`
  - `fixCandidates(commits: CommitInfoLike[], mergedAtSec: number, windowDays: number, prFiles: ReadonlySet<string>): CommitInfoLike[]` where `CommitInfoLike = { sha; parents: string[]; time; subject; files: string[]; isFix; isRevert; revertsSha? }`
  - `isRevertOfPr(commits: CommitInfoLike[], pr: { commits: readonly string[]; mergeSubject: string }): boolean`
  - `partnerOf(text: string): string | undefined`
  - `addedLines(hunks: Array<{ newStart: number; lines: string[] }>): number[]`
  - `interface PrFile { path: string; ignored: boolean; addedLines: number[] }`
  - `interface FactRecord { slug; number; id; weight; file; line?; E_file; F_file; R; E_line?; F_line?; P_partner?; expE_file; expF_file; expE_line?; expF_line? }`
  - `labelFact(fact: { id; weight; file; line?; text }, ctx: { slug; number; files: PrFile[]; comments: CommentLoc[]; hits: BlameHit[]; reverted: boolean; fixTouched: ReadonlySet<string>; lineWindow?: number }): FactRecord`

- [ ] **Step 1: Failing tests**

```ts
describe("labels", () => {
  const files: PrFile[] = [
    { path: "a.ts", ignored: false, addedLines: [10, 11, 12, 40] },
    { path: "b.ts", ignored: false, addedLines: [5] },
    { path: "lock.json", ignored: true, addedLines: [1] },
  ];
  const comments: CommentLoc[] = [{ path: "a.ts", line: 15 }, { path: "a.ts", line: null }];
  const hits: BlameHit[] = [{ sha: "h", path: "b.ts", line: 5 }];
  const ctx = { slug: "r", number: 1, files, comments, hits, reverted: false, fixTouched: new Set(["z.ts"]) };

  it("file-level labels and per-PR expected rates over non-ignored files", () => {
    const r = labelFact({ id: "contract.api", weight: "strong", file: "a.ts", line: 10, text: "" }, ctx);
    expect(r).toMatchObject({ E_file: true, F_file: false, R: false, E_line: true, F_line: false, expE_file: 0.5, expF_file: 0.5 });
    expect(r.expE_line).toBeCloseTo(3 / 4); // 10,11,12 within ±10 of 15; 40 is not
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
  it("coupling facts get P_partner from the detector's text", () => {
    const text = "`z.ts` changed with `a.ts` in 9 of 10 commits (last 365 days); this PR changes only `a.ts`.";
    expect(partnerOf(text)).toBe("z.ts");
    expect(labelFact({ id: "coupling.missing", weight: "strong", file: "a.ts", text }, ctx).P_partner).toBe(true);
  });
});

describe("comments, hits, fixes, reverts", () => {
  it("countedComments drops bots and the PR author and prefers line over original_line", () => {
    const cs = [
      { path: "a", line: 3, original_line: 2, user: { login: "rev", type: "User" } },
      { path: "a", line: null, original_line: 7, user: { login: "rev", type: "User" } },
      { path: "a", line: 1, original_line: 1, user: { login: "author", type: "User" } },
      { path: "a", line: 1, original_line: 1, user: { login: "x[bot]", type: "Bot" } },
    ];
    expect(countedComments(cs, "author")).toEqual([{ path: "a", line: 3 }, { path: "a", line: 7 }]);
  });
  it("changesRequested ignores bot reviews", () => {
    expect(changesRequested([{ state: "CHANGES_REQUESTED", user: { type: "Bot" } }])).toBe(false);
    expect(changesRequested([{ state: "CHANGES_REQUESTED", user: { type: "User" } }])).toBe(true);
  });
  it("hitsOnPr matches any PR commit", () => {
    expect(hitsOnPr([{ sha: "mid", path: "a", line: 1 }, { sha: "other", path: "a", line: 2 }], ["head", "mid"])).toEqual([{ sha: "mid", path: "a", line: 1 }]);
  });
  it("fixCandidates: non-merge fix/revert commits inside (merged, merged+W] touching a PR file", () => {
    const c = (sha: string, time: number, files: string[], extra = {}) => ({ sha, parents: ["p"], time, subject: "fix: x", files, isFix: true, isRevert: false, ...extra });
    const commits = [c("in", 100 + DAY, ["a"]), c("late", 100 + 91 * DAY, ["a"]), c("other", 100 + DAY, ["q"]), c("merge", 100 + DAY, ["a"], { parents: ["p", "q"] }), c("notfix", 100 + DAY, ["a"], { isFix: false })];
    expect(fixCandidates(commits, 100, 90, new Set(["a"])).map((x) => x.sha)).toEqual(["in"]);
  });
  it("isRevertOfPr by revertsSha prefix or by subject", () => {
    const pr = { commits: ["abcdef0123456789", "fedcba9876543210"], mergeSubject: "feat: y (#3)" };
    expect(isRevertOfPr([{ sha: "r", parents: ["p"], time: 1, subject: "Revert x", files: [], isFix: false, isRevert: true, revertsSha: "abcdef0" }], pr)).toBe(true);
    expect(isRevertOfPr([{ sha: "r", parents: ["p"], time: 1, subject: 'Revert "feat: y (#3)"', files: [], isFix: false, isRevert: true }], pr)).toBe(true);
    expect(isRevertOfPr([{ sha: "r", parents: ["p"], time: 1, subject: 'Revert "other"', files: [], isFix: false, isRevert: true, revertsSha: "999" }], pr)).toBe(false);
  });
  it("addedLines walks hunks by new-side line numbers", () => {
    expect(addedLines([{ newStart: 10, lines: [" ctx", "+a", "-b", "+c", "\\ No newline"] }])).toEqual([11, 12]);
  });
});
```

- [ ] **Step 2: Run, fails.** **Step 3: Implement.** `near(lines, target, w)` helper; expected line rate = `added.filter(l => near(targets, l, w)).length / added.length` or 0 when no added lines. `addedLines`: walk `lines`, `+` → push n++, ` `/`""` → n++, `-` → nothing, `\` → nothing. `partnerOf`: `/^`([^`]+)` changed with `/`. **Step 4: Run, passes.** **Step 5: Commit** `bench(outcomes): per-fact outcome labels and controls`.

### Task 4: Lifts, decision rule, priority table, drift, report

**Files:**
- Modify: `bench/outcomes/lib.ts`
- Test: `tests/bench/outcomes-lib.test.ts`

**Interfaces:**
- Produces:
  - `type Conclusion = "insufficient" | "keep" | "retune" | "demote"`; `conclude(fires: number, liftE: number, liftF: number, o = { minFires: 30, bar: 1.2 }): Conclusion`
  - `interface FactTypeSummary { id; fires; prs; strong; E_file; expE_file; liftE_file; F_file; expF_file; liftF_file; E_line?; expE_line?; liftE_line?; F_line?; expF_line?; liftF_line?; R; noOutcome; P_partner?; conclusion }` (rates as fractions; lifts `Infinity` when expected is 0 and observed > 0, `NaN` when both 0 → rendered as "—")
  - `summarise(records: FactRecord[], o?): FactTypeSummary[]` sorted by id
  - `interface PriorityRow { priority; n; fixedOrReverted; rate }`; `priorityTable(prs: Array<{ priority; fixedOrReverted: boolean }>, o = { minCareful: 30, bar: 1.2 }): { rows: PriorityRow[]; base: number; recallAtCareful: number; informative: boolean }`
  - `drift(baseline: FactTypeSummary[], current: FactTypeSummary[], fireTolerance = 0.2): string[]`
  - `renderResults(r: { builtAt; corpus: { repos: number; prs: number; excluded: number }; facts: FactTypeSummary[]; priority: ReturnType<typeof priorityTable>; drift: string[]; timings: Record<string, number> }): string`

- [ ] **Step 1: Failing tests**

```ts
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
describe("summarise", () => {
  const rec = (id: string, E: boolean, F: boolean, expE: number, expF: number, extra = {}) => ({ slug: "r", number: 1, id, weight: "strong", file: "f", E_file: E, F_file: F, R: false, expE_file: expE, expF_file: expF, ...extra });
  it("computes rates, lifts and the no-outcome share per fact type", () => {
    const [s] = summarise([rec("contract.api", true, false, 0.25, 0.5), rec("contract.api", false, false, 0.25, 0.5)]);
    expect(s).toMatchObject({ id: "contract.api", fires: 2, E_file: 0.5, expE_file: 0.25, liftE_file: 2, F_file: 0, liftF_file: 0, noOutcome: 0.5, conclusion: "insufficient" });
  });
  it("line lifts only over facts that have a line", () => {
    const [s] = summarise([rec("contract.api", false, false, 0, 0, { line: 3, E_line: true, expE_line: 0.5, F_line: false, expF_line: 0 }), rec("contract.api", false, false, 0, 0)]);
    expect(s.liftE_line).toBe(2);
    expect(s.liftF_line).toBeNaN();
  });
});
describe("priorityTable", () => {
  it("rates per tier, base rate, recall at careful, informative flag", () => {
    const prs = [...Array(30).fill({ priority: "careful", fixedOrReverted: true }), ...Array(30).fill({ priority: "careful", fixedOrReverted: false }), ...Array(40).fill({ priority: "quick", fixedOrReverted: false })];
    const t = priorityTable(prs);
    expect(t.base).toBeCloseTo(0.3);
    expect(t.rows.find((r) => r.priority === "careful")?.rate).toBe(0.5);
    expect(t.recallAtCareful).toBe(1);
    expect(t.informative).toBe(true);
  });
});
describe("drift", () => {
  it("reports fire-count moves over the tolerance and conclusion changes", () => {
    const b = [{ id: "a", fires: 100, conclusion: "keep" }, { id: "b", fires: 10, conclusion: "insufficient" }] as FactTypeSummary[];
    const c = [{ id: "a", fires: 130, conclusion: "keep" }, { id: "b", fires: 10, conclusion: "retune" }, { id: "c", fires: 5, conclusion: "insufficient" }] as FactTypeSummary[];
    expect(drift(b, c)).toEqual(["a: fires 100 → 130 (+30 %)", "b: conclusion insufficient → retune", "c: new fact type (5 fires)"]);
  });
});
```

- [ ] **Step 2: Run, fails.** **Step 3: Implement** (`renderResults` produces the Markdown tables; tested only for containing each fact id and the decision-rule heading). **Step 4: Run, passes.** **Step 5: Commit** `bench(outcomes): lifts, decision rule, priority table, drift and report`.

### Task 5: `run.ts` — fetch and build

**Files:**
- Create: `bench/outcomes/run.ts`, `bench/outcomes/README.md`
- Modify: `bench/outcomes/lib.ts` (export `CorpusFile`, `CorpusRepo`, `CorpusPr` types)

**Interfaces:**
- `corpus.json`: `{ builtAt, windowDays: 90, perRepo: 60, lookbackDays: 365, repos: CorpusRepo[], prs: CorpusPr[], excluded: Array<{ slug; number; reason }> }` with `CorpusRepo = { slug; repo; language; defaultBranch; head; headTime; cloneMode: "blobless" | "full"; config?: Record<string, number> }`, `CorpusPr = { slug; number; author; mergeSha; mergedAt; mergeSubject; shape; base; head; commits: string[]; changedFiles }`.
- Cache files: `gh/<slug>/repo.json`, `gh/<slug>/head.json`, `gh/<slug>/pulls-<page>.json`, `gh/<slug>/pr-<n>.json`, `gh/<slug>/comments-<n>.json`, `gh/<slug>/reviews-<n>.json`; `briefs/<slug>/<n>.json` = `{ priority, facts, notes, score, tier, files: PrFile[] }`.

- [ ] **Step 1: `gh` wrapper** — `ghJson(path)`: cache hit → parse; else check `/rate_limit` every 50 calls (sleep `rateLimitWaitMs`), `execFile("gh", ["api", path])`, retry 403/429 with backoff ×3, write cache.
- [ ] **Step 2: `fetch`** — per repo (in a pool of 3): `repos/{o}/{r}` → default branch; `repos/{o}/{r}/commits/<branch>` → head sha + committer date (pinned on first fetch, `head.json`); pulls pages until `stopPaging` or an empty page; `selectPulls`; per selected PR: `pr-<n>`, `comments-<n>` (paginate `?per_page=100&page=k` until a short page), `reviews-<n>`.
- [ ] **Step 3: `build`** — `ensureClone` (blobless, or full for fastlane; reused across runs); one `git rev-list --first-parent <head>` per repo into a Set; per PR: `resolveMergeShape` from `git show -s --format=%P%x00%s M`; exclude `not-first-parent` when M is not in the set; `prRange`; `git rev-list --no-merges <revList>` → commits; `loadDiff`-equivalent file count via `scoreDiff`'s result (`result.diff.files`) compared with `changedFiles` → `diff-mismatch`; stop rule (> 20 % of a repo's selected PRs excluded as `not-first-parent`/`diff-mismatch` → exit 3 with the list); write `corpus.json`; per PR (pool of `--pr-concurrency`), `scoreDiff({..., llm: null, brief: {}, history, baseHistory: history, asOf: baseTime + 1})` → `briefs/<slug>/<n>.json` with `files` from `result.brief`'s diff? No — the brief does not carry hunks, so `build` reads the diff itself: `loadDiff(repoDir, base, head, config)` from `dist/git/diff.js` once, passes nothing extra to `scoreDiff` (it re-reads), and stores `files: loadDiff(...).files.map(f => ({ path, ignored, addedLines: addedLines(f.hunks) }))`.
- [ ] **Step 4: Pilot** — `node scripts/record-run.mjs bench:outcomes:fetch -- node bench/outcomes/run.ts fetch --repos vite` then `... build --repos vite --limit 10`; record wall time per brief in `briefs/<slug>/<n>.json` (`ms`).
- [ ] **Step 5: Commit** `bench(outcomes): fetch and build steps`.

### Task 6: `run.ts` — label and eval

**Files:**
- Modify: `bench/outcomes/run.ts`
- Create (by running): `bench/outcomes/labels.json`, `bench/outcomes/results.md`, `bench/outcomes/results.json`, `bench/outcomes/baseline.json`

- [ ] **Step 1: `label`** — per repo: the shared history index; per PR: `countedComments`, `changesRequested`, `isRevertOfPr`, `fixCandidates(history.commits, mergedAtSec, 90, prFiles)`; blame each candidate once (`blame/<slug>/<sha>.json` cache, pool of 4) with `blameFix` from `dist/model/label.js`; `hitsOnPr`; write `labels.json`: `{ prs: { "<slug>#<n>": { comments: CommentLoc[]; hits: BlameHit[]; reverted; changesRequested; fixTouched: string[] } } }`.
- [ ] **Step 2: `eval`** — needs `briefs/` (rebuilds missing ones via `build`'s per-PR function) and `labels.json`; `labelFact` per fact; `summarise`; `priorityTable` (`fixedOrReverted = reverted || hits.length > 0`); `drift` vs `baseline.json` when present; write `results.json` and `results.md`; `--write-baseline` copies the summaries into `baseline.json`.
- [ ] **Step 3: `all`** = fetch → build → label → eval; clones deleted at the end unless `--keep-clones`.
- [ ] **Step 4: Commit** `bench(outcomes): label and eval steps`.

### Task 7: Run, record, conclude

- [ ] **Step 1:** `node scripts/record-run.mjs bench:outcomes:fetch -- node bench/outcomes/run.ts fetch`.
- [ ] **Step 2:** `node scripts/record-run.mjs bench:outcomes:build -- node bench/outcomes/run.ts build --keep-clones` (parallel: 3 repos × 2 PRs).
- [ ] **Step 3:** `node scripts/record-run.mjs bench:outcomes:label -- node bench/outcomes/run.ts label --keep-clones`.
- [ ] **Step 4:** `node scripts/record-run.mjs bench:outcomes:eval -- node bench/outcomes/run.ts eval --write-baseline` then delete the clones.
- [ ] **Step 5:** Copy the numbers into `docs/experiments.md` "Result" (table row updated), with per-fact-type conclusions and follow-ups, the timings, and anything that failed. Commit `corpus.json`, `labels.json`, `baseline.json`, `results.*`, `docs/experiments.md`.
- [ ] **Step 6:** Ledger entry (≤ 8 lines) and the ≤ 120-word reply.
