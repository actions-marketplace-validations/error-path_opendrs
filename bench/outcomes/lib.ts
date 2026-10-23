/**
 * bench/outcomes: the pure half of the outcome-labels harness (spec
 * docs/specs/2026-10-23-outcome-labels-design.md). PR selection, merge-shape resolution, the
 * per-fact outcome labels and their per-PR controls, lifts, the decision rule, the priority
 * table, drift and the report. Unit-tested without network, git or `dist/`; run.ts does the I/O.
 */

const DAY = 86_400;
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

// ---------------------------------------------------------------------------------------------
// Corpus (spec §3, §4.1)

export interface GhPullSummary {
  number: number;
  created_at: string;
  merged_at: string | null;
  merge_commit_sha: string;
  user: { login: string; type: string };
}

export type ExclusionReason = "not-merged" | "merged-inside-window" | "too-old" | "bot" | "not-first-parent" | "diff-mismatch" | "brief-failed";

export interface SelectOptions {
  windowDays: number;
  lookbackDays: number;
  perRepo: number;
}

/**
 * Spec §3: merged at least `windowDays` before the pinned head, created inside the lookback,
 * not bot-authored; the `perRepo` most recently merged. `stopPaging` is true once a page holds
 * a PR created before the lookback (pages arrive newest-created first).
 */
export function selectPulls(pulls: GhPullSummary[], headTimeSec: number, o: SelectOptions): { selected: GhPullSummary[]; excluded: Array<{ number: number; reason: ExclusionReason }>; stopPaging: boolean } {
  const cutoff = headTimeSec - o.windowDays * DAY;
  const oldest = cutoff - o.lookbackDays * DAY;
  const selected: GhPullSummary[] = [];
  const excluded: Array<{ number: number; reason: ExclusionReason }> = [];
  for (const p of pulls) {
    if (p.merged_at === null) excluded.push({ number: p.number, reason: "not-merged" });
    else if (sec(p.merged_at) > cutoff) excluded.push({ number: p.number, reason: "merged-inside-window" });
    else if (sec(p.created_at) < oldest) excluded.push({ number: p.number, reason: "too-old" });
    else if (p.user.type === "Bot") excluded.push({ number: p.number, reason: "bot" });
    else selected.push(p);
  }
  selected.sort((a, b) => sec(b.merged_at!) - sec(a.merged_at!));
  return { selected: selected.slice(0, o.perRepo), excluded, stopPaging: pulls.some((p) => sec(p.created_at) < oldest) };
}

/** Milliseconds to sleep before the next GitHub call: 0 above `min` remaining, else until reset plus a second. */
export function rateLimitWaitMs(remaining: number, resetEpochSec: number, nowSec: number, min = 200): number {
  return remaining >= min ? 0 : Math.max(0, resetEpochSec - nowSec) * 1000 + 1000;
}

export type MergeShape = "merge" | "squash" | "rebase";

/** Spec §4.1: two parents → merge; one parent with `(#N)` or a single commit → squash; else rebase. */
export function resolveMergeShape(m: { parents: string[]; subject: string; commits: number; number: number }): MergeShape {
  if (m.parents.length >= 2) return "merge";
  if (m.commits <= 1 || m.subject.trimEnd().endsWith(`(#${m.number})`)) return "squash";
  return "rebase";
}

/** The PR's base and head refs and the `git rev-list` range holding its own commits. */
export function prRange(shape: MergeShape, mergeSha: string, commits: number): { base: string; head: string; revList: string } {
  const base = shape === "merge" ? `${mergeSha}^1` : shape === "squash" ? `${mergeSha}^1` : `${mergeSha}~${commits}`;
  const head = shape === "merge" ? `${mergeSha}^2` : mergeSha;
  return { base, head, revList: `${base}..${head}` };
}

export interface CorpusRepo {
  slug: string;
  repo: string;
  language: string;
  defaultBranch: string;
  head: string;
  /** Committer time of `head`, unix seconds. */
  headTime: number;
  cloneMode: "blobless" | "full";
  config?: Record<string, number>;
}

export interface CorpusPr {
  slug: string;
  number: number;
  author: string;
  mergeSha: string;
  mergedAt: string;
  mergeSubject: string;
  shape: MergeShape;
  base: string;
  head: string;
  /** Resolved shas of the PR's own commits (the squash commit, or everything in the range). */
  commits: string[];
  changedFiles: number;
}

export interface CorpusFile {
  builtAt: string;
  windowDays: number;
  lookbackDays: number;
  perRepo: number;
  repos: CorpusRepo[];
  prs: CorpusPr[];
  excluded: Array<{ slug: string; number: number; reason: ExclusionReason; detail?: string }>;
}

// ---------------------------------------------------------------------------------------------
// Labels (spec §5)

export interface CommentLoc {
  path: string;
  /** GitHub's `line` (position at the final head), else `original_line`, else null (outdated). */
  line: number | null;
}

/** Spec §5.1: review comments by someone who is neither a bot nor the PR author. */
export function countedComments(comments: Array<{ path: string; line: number | null; original_line: number | null; user: { login: string; type: string } }>, prAuthor: string): CommentLoc[] {
  return comments.filter((c) => c.user.type !== "Bot" && c.user.login !== prAuthor).map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null }));
}

export function changesRequested(reviews: Array<{ state: string; user: { type: string } }>): boolean {
  return reviews.some((r) => r.state === "CHANGES_REQUESTED" && r.user.type !== "Bot");
}

export interface BlameHit {
  sha: string;
  path: string;
  line: number;
}

/** Blame hits whose blamed commit is one of the PR's own commits (any of them, not only head). */
export function hitsOnPr(hits: BlameHit[], prCommits: readonly string[]): BlameHit[] {
  const set = new Set(prCommits);
  return hits.filter((h) => set.has(h.sha));
}

export interface CommitInfoLike {
  sha: string;
  parents: string[];
  time: number;
  subject: string;
  files: string[];
  isFix: boolean;
  isRevert: boolean;
  revertsSha?: string;
}

/** Spec §5.2: non-merge fix or revert commits in `(mergedAt, mergedAt + window]` that touch a PR file. */
export function fixCandidates<T extends CommitInfoLike>(commits: T[], mergedAtSec: number, windowDays: number, prFiles: ReadonlySet<string>): T[] {
  const end = mergedAtSec + windowDays * DAY;
  return commits.filter((c) => c.parents.length <= 1 && (c.isFix || c.isRevert) && c.time > mergedAtSec && c.time <= end && c.files.some((f) => prFiles.has(f)));
}

/** Spec §5.2 `R`: a later commit reverts one of the PR's commits by sha, or by the merge commit's subject. */
export function isRevertOfPr(commits: CommitInfoLike[], pr: { commits: readonly string[]; mergeSubject: string }): boolean {
  const bySubject = `Revert "${pr.mergeSubject}"`;
  return commits.some((c) => (c.revertsSha !== undefined && pr.commits.some((sha) => sha.startsWith(c.revertsSha!))) || c.subject === bySubject);
}

/** The partner named by `coupling.missing`'s fixed text (src/architecture/coupling.ts). */
export function partnerOf(text: string): string | undefined {
  return /^`([^`]+)` changed with `/.exec(text)?.[1];
}

/** New-side line numbers of every added line, walking hunk bodies the way src/git/diff.ts does. */
export function addedLines(hunks: Array<{ newStart: number; lines: string[] }>): number[] {
  const out: number[] = [];
  for (const h of hunks) {
    let n = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith("+")) out.push(n++);
      else if (l.startsWith("-") || l.startsWith("\\")) continue;
      else n++;
    }
  }
  return out;
}

export interface PrFile {
  path: string;
  ignored: boolean;
  addedLines: number[];
}

export interface FactRecord {
  slug: string;
  number: number;
  id: string;
  weight: "strong" | "info";
  file: string;
  line?: number;
  E_file: boolean;
  F_file: boolean;
  R: boolean;
  E_line?: boolean;
  F_line?: boolean;
  P_partner?: boolean;
  expE_file: number;
  expF_file: number;
  expE_line?: number;
  expF_line?: number;
}

export interface PrLabelContext {
  slug: string;
  number: number;
  files: PrFile[];
  comments: CommentLoc[];
  /** Blame hits already filtered to the PR's commits (hitsOnPr). */
  hits: BlameHit[];
  reverted: boolean;
  /** Files touched by any fix commit in the window (for coupling's P_partner). */
  fixTouched: ReadonlySet<string>;
  lineWindow?: number;
}

const near = (targets: number[], line: number, w: number): boolean => targets.some((t) => Math.abs(t - line) <= w);

/** Share of `added` lines within ±w of any target; 0 when the file added nothing. */
function lineRate(added: number[], targets: number[], w: number): number {
  if (added.length === 0) return 0;
  return added.filter((l) => near(targets, l, w)).length / added.length;
}

/** Spec §5.1–5.3: one fact's labels and the expected rates from the PR's own other files/lines. */
export function labelFact(fact: { id: string; weight: "strong" | "info"; file: string; line?: number; text: string }, ctx: PrLabelContext): FactRecord {
  const w = ctx.lineWindow ?? 10;
  const counted = ctx.files.filter((f) => !f.ignored);
  const commented = new Set(ctx.comments.map((c) => c.path));
  const hitFiles = new Set(ctx.hits.map((h) => h.path));
  const share = (set: Set<string>) => (counted.length === 0 ? 0 : counted.filter((f) => set.has(f.path)).length / counted.length);

  const rec: FactRecord = {
    slug: ctx.slug,
    number: ctx.number,
    id: fact.id,
    weight: fact.weight,
    file: fact.file,
    ...(fact.line !== undefined && { line: fact.line }),
    E_file: commented.has(fact.file),
    F_file: hitFiles.has(fact.file),
    R: ctx.reverted,
    expE_file: share(commented),
    expF_file: share(hitFiles),
  };

  if (fact.line !== undefined) {
    const commentLines = ctx.comments.filter((c) => c.path === fact.file && c.line !== null).map((c) => c.line!);
    const hitLines = ctx.hits.filter((h) => h.path === fact.file).map((h) => h.line);
    const added = ctx.files.find((f) => f.path === fact.file)?.addedLines ?? [];
    rec.E_line = near(commentLines, fact.line, w);
    rec.F_line = near(hitLines, fact.line, w);
    rec.expE_line = lineRate(added, commentLines, w);
    rec.expF_line = lineRate(added, hitLines, w);
  }

  if (fact.id === "coupling.missing") {
    const partner = partnerOf(fact.text);
    if (partner !== undefined) rec.P_partner = ctx.fixTouched.has(partner);
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------
// Metrics and the decision rule (spec §5.4, §7, §8)

export type Conclusion = "insufficient" | "keep" | "retune" | "demote";

/** Spec §7, applied exactly. A NaN lift (nothing observed, nothing expected) counts as below 1. */
export function conclude(fires: number, liftE: number, liftF: number, o = { minFires: 30, bar: 1.2 }): Conclusion {
  if (fires < o.minFires) return "insufficient";
  if (liftE >= o.bar || liftF >= o.bar) return "keep";
  if (liftE >= 1 || liftF >= 1) return "retune";
  return "demote";
}

export interface FactTypeSummary {
  id: string;
  fires: number;
  prs: number;
  strong: number;
  E_file: number;
  expE_file: number;
  liftE_file: number;
  F_file: number;
  expF_file: number;
  liftF_file: number;
  /** Over the facts that have a line. */
  withLine: number;
  E_line?: number;
  expE_line?: number;
  liftE_line?: number;
  F_line?: number;
  expF_line?: number;
  liftF_line?: number;
  R: number;
  /** Neither E_file, F_file nor R. */
  noOutcome: number;
  P_partner?: number;
  conclusion: Conclusion;
}

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
/** observed / expected; Infinity when something was observed against zero expected, NaN when both are zero. */
const lift = (observed: number, expected: number): number => (expected === 0 ? (observed === 0 ? NaN : Infinity) : observed / expected);
const bool = (b: boolean | undefined): number => (b ? 1 : 0);

/** Per fact type, sorted by id: rates, expected rates, lifts, and the §7 conclusion. */
export function summarise(records: FactRecord[], o = { minFires: 30, bar: 1.2 }): FactTypeSummary[] {
  const byId = new Map<string, FactRecord[]>();
  for (const r of records) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  return [...byId.keys()].sort().map((id) => {
    const rs = byId.get(id)!;
    const E_file = mean(rs.map((r) => bool(r.E_file)));
    const expE_file = mean(rs.map((r) => r.expE_file));
    const F_file = mean(rs.map((r) => bool(r.F_file)));
    const expF_file = mean(rs.map((r) => r.expF_file));
    const s: FactTypeSummary = {
      id,
      fires: rs.length,
      prs: new Set(rs.map((r) => `${r.slug}#${r.number}`)).size,
      strong: rs.filter((r) => r.weight === "strong").length,
      E_file,
      expE_file,
      liftE_file: lift(E_file, expE_file),
      F_file,
      expF_file,
      liftF_file: lift(F_file, expF_file),
      withLine: rs.filter((r) => r.line !== undefined).length,
      R: mean(rs.map((r) => bool(r.R))),
      noOutcome: mean(rs.map((r) => bool(!r.E_file && !r.F_file && !r.R))),
      conclusion: "insufficient",
    };
    const lined = rs.filter((r) => r.line !== undefined);
    if (lined.length > 0) {
      s.E_line = mean(lined.map((r) => bool(r.E_line)));
      s.expE_line = mean(lined.map((r) => r.expE_line!));
      s.liftE_line = lift(s.E_line, s.expE_line);
      s.F_line = mean(lined.map((r) => bool(r.F_line)));
      s.expF_line = mean(lined.map((r) => r.expF_line!));
      s.liftF_line = lift(s.F_line, s.expF_line);
    }
    const partnered = rs.filter((r) => r.P_partner !== undefined);
    if (partnered.length > 0) s.P_partner = mean(partnered.map((r) => bool(r.P_partner)));
    s.conclusion = conclude(s.fires, s.liftE_file, s.liftF_file, o);
    return s;
  });
}

/**
 * The first `cap` records of each PR, in brief order (strong first, fixed detector order) — the
 * facts the PR comment actually shows (docs/captain.md §5). Post-hoc view added after run 2,
 * where one PR carried 2,628 `contract.api` facts; records must arrive grouped by PR in brief order.
 */
export function shownFacts(records: FactRecord[], cap = 5): FactRecord[] {
  const seen = new Map<string, number>();
  return records.filter((r) => {
    const key = `${r.slug}#${r.number}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n <= cap;
  });
}

export type Priority = "careful" | "standard" | "quick";
const PRIORITIES: readonly Priority[] = ["careful", "standard", "quick"];

export interface PriorityRow {
  priority: Priority;
  n: number;
  fixedOrReverted: number;
  rate: number;
}

export interface PriorityReport {
  rows: PriorityRow[];
  base: number;
  /** Share of all fixed-or-reverted PRs whose priority was careful. */
  recallAtCareful: number;
  informative: boolean;
}

/** Spec §5.4 and §7: fixed-or-reverted rate per tier; informative when careful ≥ bar × base on ≥ minCareful PRs. */
export function priorityTable(prs: Array<{ priority: Priority; fixedOrReverted: boolean }>, o = { minCareful: 30, bar: 1.2 }): PriorityReport {
  const rows = PRIORITIES.map((priority) => {
    const mine = prs.filter((p) => p.priority === priority);
    const fixedOrReverted = mine.filter((p) => p.fixedOrReverted).length;
    return { priority, n: mine.length, fixedOrReverted, rate: mine.length === 0 ? NaN : fixedOrReverted / mine.length };
  });
  const fixed = prs.filter((p) => p.fixedOrReverted).length;
  const base = prs.length === 0 ? NaN : fixed / prs.length;
  const careful = rows[0]!;
  return {
    rows,
    base,
    recallAtCareful: fixed === 0 ? NaN : careful.fixedOrReverted / fixed,
    informative: careful.n >= o.minCareful && careful.rate >= o.bar * base,
  };
}

/** Spec §8: fact types whose fire count moved more than `fireTolerance` or whose conclusion changed. */
export function drift(baseline: FactTypeSummary[], current: FactTypeSummary[], fireTolerance = 0.2): string[] {
  const out: string[] = [];
  const before = new Map(baseline.map((s) => [s.id, s]));
  const after = new Map(current.map((s) => [s.id, s]));
  for (const id of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(id);
    const c = after.get(id);
    if (!b) out.push(`${id}: new fact type (${c!.fires} fires)`);
    else if (!c) out.push(`${id}: no longer fires (was ${b.fires})`);
    else {
      const change = b.fires === 0 ? (c.fires === 0 ? 0 : Infinity) : (c.fires - b.fires) / b.fires;
      if (Math.abs(change) > fireTolerance) out.push(`${id}: fires ${b.fires} → ${c.fires} (${change > 0 ? "+" : ""}${Math.round(change * 100)} %)`);
      if (b.conclusion !== c.conclusion) out.push(`${id}: conclusion ${b.conclusion} → ${c.conclusion}`);
    }
  }
  return out;
}

export interface ResultsInput {
  builtAt: string;
  corpus: { repos: number; prs: number; excluded: number };
  facts: FactTypeSummary[];
  /** Post-hoc: the same summaries over the first five facts of each PR (what the comment shows). */
  factsShown?: FactTypeSummary[];
  priority: PriorityReport;
  drift: string[];
  /** Step durations in ms, by step name. */
  timings: Record<string, number>;
}

const pct = (x: number | undefined): string => (x === undefined || Number.isNaN(x) ? "—" : `${(x * 100).toFixed(1)} %`);
const x = (v: number | undefined): string => (v === undefined || Number.isNaN(v) ? "—" : v === Infinity ? "∞" : `${v.toFixed(2)}×`);
const minutes = (ms: number): string => `${(ms / 60_000).toFixed(1)} min`;

/** The Markdown report; every number docs/experiments.md quotes comes from here. */
export function renderResults(r: ResultsInput): string {
  const lines: string[] = [];
  lines.push("# Outcome labels: results", "", `Built ${r.builtAt}. ${r.corpus.repos} repos, ${r.corpus.prs} PRs scored, ${r.corpus.excluded} excluded (reasons in corpus.json).`, "");
  lines.push("Spec: `docs/specs/2026-10-23-outcome-labels-design.md`. Lift = observed rate ÷ the same PRs' expected rate (§5.3). Decision rule §7: ≥ 30 fires; keep when E_file or F_file lift ≥ 1.2×; retune when neither but one ≥ 1.0×; demote when both < 1.0×.", "");
  lines.push("## Per fact type (file level, primary)", "");
  lines.push("| Fact | Fires | PRs | Strong | E_file | exp | lift | F_file | exp | lift | R | No outcome | Conclusion |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const s of r.facts) {
    lines.push(`| \`${s.id}\` | ${s.fires} | ${s.prs} | ${s.strong} | ${pct(s.E_file)} | ${pct(s.expE_file)} | ${x(s.liftE_file)} | ${pct(s.F_file)} | ${pct(s.expF_file)} | ${x(s.liftF_file)} | ${pct(s.R)} | ${pct(s.noOutcome)} | **${s.conclusion}** |`);
  }
  lines.push("", "## Per fact type (line level, ±10 lines, facts with a line only)", "");
  lines.push("| Fact | With line | E_line | exp | lift | F_line | exp | lift | P_partner |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const s of r.facts) {
    lines.push(`| \`${s.id}\` | ${s.withLine} | ${pct(s.E_line)} | ${pct(s.expE_line)} | ${x(s.liftE_line)} | ${pct(s.F_line)} | ${pct(s.expF_line)} | ${x(s.liftF_line)} | ${pct(s.P_partner)} |`);
  }
  if (r.factsShown) {
    lines.push("", "## Post-hoc: the five facts the PR comment shows (first five per PR, brief order)", "");
    lines.push("Not part of the pre-registered rule; added after run 2 because one PR carried 2,628 `contract.api` facts and dominated the per-fact numbers above. The conclusion column applies the same §7 rule to this view.", "");
    lines.push("| Fact | Fires | PRs | E_file | exp | lift | F_file | exp | lift | No outcome | Rule on this view |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|");
    for (const s of r.factsShown) {
      lines.push(`| \`${s.id}\` | ${s.fires} | ${s.prs} | ${pct(s.E_file)} | ${pct(s.expE_file)} | ${x(s.liftE_file)} | ${pct(s.F_file)} | ${pct(s.expF_file)} | ${x(s.liftF_file)} | ${pct(s.noOutcome)} | ${s.conclusion} |`);
    }
  }
  lines.push("", "## Captain priority", "", `Corpus fixed-or-reverted rate: ${pct(r.priority.base)}. Recall at careful: ${pct(r.priority.recallAtCareful)}. Informative (careful ≥ 1.2× base on ≥ 30 PRs): **${r.priority.informative ? "yes" : "no"}**.`, "");
  lines.push("| Priority | PRs | Fixed or reverted | Rate |", "|---|---:|---:|---:|");
  for (const row of r.priority.rows) lines.push(`| ${row.priority} | ${row.n} | ${row.fixedOrReverted} | ${pct(row.rate)} |`);
  lines.push("", "## Drift vs. baseline.json", "");
  if (r.drift.length === 0) lines.push("No baseline, or nothing moved beyond the tolerance.");
  else for (const d of r.drift) lines.push(`- ${d}`);
  lines.push("", "## Timings", "");
  for (const [step, ms] of Object.entries(r.timings)) lines.push(`- ${step}: ${minutes(ms)}`);
  lines.push("");
  return lines.join("\n");
}
