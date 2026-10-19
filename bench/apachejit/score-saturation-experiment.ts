/**
 * Score-saturation experiment (docs/experiments.md, "Score saturation: fixPattern and incident
 * granularity on ApacheJIT"; pre-registered 2026-10-19): does excluding Conventional-Commit
 * housekeeping from `history.fixPattern`, and matching `history.incident` at file level instead of
 * folder level, reduce default-prior score saturation without hurting calibrated AUC?
 *
 * Reuses the existing full row cache (build 08355066ee67, the same 15-project replay behind the
 * 0.823 pooled calibrated AUC quoted throughout docs/experiments.md) for every signal but the two
 * under test. Those two are recomputed bench-locally from one blobless clone and one `git log
 * --name-only --no-renames --format=...` spawn per project (sha, time, subject, body, files — the
 * same shape `src/git/history.ts` itself logs, minus `-M` rename detection, which is what made
 * earlier full-history replays time out on the larger projects; same tradeoff as
 * coupling-experiment.ts). `src/` is not touched; the variants are bench-local reimplementations of
 * `src/signals/history.ts`'s matching rules. No LLM calls, no API spend.
 *
 * Run `npm run build` first, then `node bench/apachejit/score-saturation-experiment.ts`. Deletes
 * its ApacheJIT clones and the field-repo clones when it finishes (`--keep-clones` to skip that).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig } from "../../dist/domain/config.js";
import type { Signal } from "../../dist/domain/types.js";
import { matchAny } from "../../dist/git/glob.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { mulberry32 } from "../../dist/model/fit.js";
import { scoreSignals } from "../../dist/model/logistic.js";
import type { ReplayRow } from "../../dist/model/replay.js";
import { aucOf, parseApacheJit, PROJECTS, recallAt } from "./lib.ts";
import type { JitRow, Project } from "./lib.ts";
import { ALSO_IN, ensureDataset, git } from "./run.ts";

const WORK_DIR = join(homedir(), ".cache", "opendrs", "apachejit");
/** The row cache build with every project replayed (same one coupling-experiment.ts used). */
const BUILD = "08355066ee67";
const EXCLUDED_PROJECT = "apache/hadoop"; // no positive labels; every other ApacheJIT table excludes it too.
const BOOTSTRAP = 2000;
const CFG = defaultConfig();
const RED = CFG.thresholds.red; // 0.8
const GREEN = CFG.thresholds.green; // 0.3: the yellow-or-red boundary in the shipped three-tier rule
const LOOKBACK_DAYS = CFG.history.lookbackDays; // 365
const IGNORE = CFG.paths.ignore;
const FIX_PATTERN_V0 = CFG.history.fixPattern;
// type(scope): or type: where type or scope is a housekeeping token, or the literal "fix: typo".
const SCOPES = "deps?|dependencies|ci|docs?|build|chore|style|tests?";
const FIX_PATTERN_V1 =
  `^(?!(?:${SCOPES})(?:\\([^)]*\\))?:)(?!\\w+\\((?:${SCOPES})\\):)(?!fix:\\s*typo\\b)` +
  `.*\\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\\d?|revert)\\b`;
const FIELD_REPOS: { name: string; url: string }[] = [
  { name: "vite", url: "https://github.com/vitejs/vite.git" },
  { name: "black", url: "https://github.com/psf/black.git" },
  { name: "cli", url: "https://github.com/cli/cli.git" },
];
const OUT = new URL("./score-saturation-experiment.md", import.meta.url);

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
const compile = (pattern: string) => new RegExp(pattern, "i");
const isFixV0 = compile(FIX_PATTERN_V0);
const isFixV1 = compile(FIX_PATTERN_V1);

function parseOptions(argv: string[]): { keepClones: boolean } {
  const { values } = parseArgs({ args: argv, options: { "keep-clones": { type: "boolean", default: false } } });
  return { keepClones: values["keep-clones"] };
}

/** Blobless, no-checkout clone at the project's pinned head (same layout as coupling-experiment.ts's). */
async function ensureBlobless(workDir: string, project: Project): Promise<{ repoDir: string; head: string } | { skipped: string }> {
  const repoDir = join(workDir, "repos", project.name);
  if (!existsSync(repoDir)) {
    const partial = `${repoDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(repoDir), { recursive: true });
    console.error(`${project.name}: cloning (blobless) ${project.url}`);
    try {
      await git(workDir, ["clone", "-q", "--filter=blob:none", "--no-checkout", project.url, partial]);
      await git(partial, ["config", "gc.auto", "0"]);
      await git(partial, ["config", "maintenance.auto", "false"]);
    } catch (e) {
      return { skipped: `clone failed: ${errorMessage(e)}` };
    }
    await rename(partial, repoDir);
  }
  try {
    return { repoDir, head: await git(repoDir, ["rev-parse", "--verify", `${project.head}^{commit}`]) };
  } catch {
    return { skipped: `pinned head ${project.head} not in the clone` };
  }
}

const RECORD = "\0";
const FIELD = "\x1f";
const END = "\x1d";
/** sha, time, subject, body (for revert detection) — the fields `src/git/history.ts` itself reads, minus parents/author. */
const FORMAT = "%x00%H%x1f%ct%x1f%s%x1f%b%x1d";
const REVERTS = /This reverts commit ([0-9a-f]{7,64})/i;

interface Commit {
  sha: string;
  time: number;
  subject: string;
  revertsSha?: string;
  files: string[];
}

/** One `git log --name-only --no-renames` spawn per clone. Sorted ascending for the indexes below. */
async function historyFor(repoDir: string, head: string): Promise<Commit[]> {
  const out = await git(repoDir, ["-c", "core.quotepath=off", "log", "--name-only", "--no-renames", "--no-show-signature", `--format=${FORMAT}`, "--end-of-options", head]);
  const commits: Commit[] = [];
  for (const record of out.split(RECORD)) {
    const end = record.lastIndexOf(END);
    if (end < 0) continue;
    const [sha = "", time = "0", subject = "", ...body] = record.slice(0, end).split(FIELD);
    const revertsSha = REVERTS.exec(body.join(FIELD))?.[1]?.toLowerCase();
    const files = record
      .slice(end + 1)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    commits.push({ sha: sha.toLowerCase(), time: Number(time), subject, revertsSha, files });
  }
  return commits.sort((a, b) => a.time - b.time);
}

interface Event {
  time: number;
  files: Set<string>;
  dirs: Set<string>;
}

interface ProjectIndex {
  commits: Commit[]; // ascending by time
  shaIndex: Map<string, number>;
  pathIndex: Map<string, number[]>; // file -> ascending commit indices that touched it
  events: Event[]; // past reverts, ascending by time
  eventFileIndex: Map<string, number[]>; // file -> ascending event indices touching it exactly
  eventDirIndex: Map<string, number[]>; // dir -> ascending event indices touching a file under it
}

/** Builds the per-file and per-revert indexes once per project; every query below is then O(log n) or O(1). */
function buildIndex(commits: Commit[]): ProjectIndex {
  const shaIndex = new Map<string, number>();
  const pathIndex = new Map<string, number[]>();
  commits.forEach((c, i) => {
    shaIndex.set(c.sha, i);
    for (const f of c.files) {
      let arr = pathIndex.get(f);
      if (!arr) pathIndex.set(f, (arr = []));
      arr.push(i);
    }
  });
  // Full- or abbreviated-sha resolution, as src/model/label.ts's shaResolver does (reverts are rare; a linear scan is fine).
  const resolve = (sha: string): Commit | undefined => {
    const s = sha.toLowerCase();
    const exact = shaIndex.get(s);
    if (exact !== undefined) return commits[exact];
    if (s.length < 7) return undefined;
    return commits.find((c) => c.sha.startsWith(s));
  };
  const events: Event[] = commits
    .filter((c): c is Commit & { revertsSha: string } => c.revertsSha !== undefined)
    .map((c) => {
      const target = resolve(c.revertsSha);
      const files = target?.files ?? c.files; // src/signals/history.ts: `target?.files ?? c.files`
      return { time: c.time, files: new Set(files), dirs: new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== ".")) };
    })
    .sort((a, b) => a.time - b.time);
  const eventFileIndex = new Map<string, number[]>();
  const eventDirIndex = new Map<string, number[]>();
  events.forEach((e, i) => {
    for (const f of e.files) {
      let arr = eventFileIndex.get(f);
      if (!arr) eventFileIndex.set(f, (arr = []));
      arr.push(i);
    }
    for (const d of e.dirs) {
      let arr = eventDirIndex.get(d);
      if (!arr) eventDirIndex.set(d, (arr = []));
      arr.push(i);
    }
  });
  return { commits, shaIndex, pathIndex, events, eventFileIndex, eventDirIndex };
}

/** First index in `indices` (ascending by commit time) whose commit.time >= t. */
function lowerBoundTime(commits: Commit[], indices: number[], t: number): number {
  let lo = 0;
  let hi = indices.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (commits[indices[mid]!]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Query {
  own: Commit;
  idx: ProjectIndex;
}

/** `history.prior_fixes`: log1p of distinct fix-or-revert commits touching any of this commit's own files in the lookback window. */
function priorFixesValue(q: Query, isFix: RegExp): number {
  const now = q.own.time;
  const from = now - LOOKBACK_DAYS * 86_400;
  const files = q.own.files.filter((f) => !matchAny(IGNORE, f));
  const seen = new Set<number>();
  for (const f of files) {
    const idxs = q.idx.pathIndex.get(f);
    if (!idxs) continue;
    const lo = lowerBoundTime(q.idx.commits, idxs, from);
    const hi = lowerBoundTime(q.idx.commits, idxs, now);
    for (let k = lo; k < hi; k++) seen.add(idxs[k]!);
  }
  let count = 0;
  for (const ci of seen) {
    const c = q.idx.commits[ci]!;
    const isRevert = c.subject.startsWith('Revert "') || c.revertsSha !== undefined;
    if (isFix.test(c.subject) || isRevert) count++;
  }
  return Math.log1p(count);
}

/** `history.incident`: 1 when a past, now-visible revert touched one of this commit's own files (file mode), or its folder (folder mode). */
function incidentValue(q: Query, mode: "folder" | "file"): 0 | 1 {
  const now = q.own.time;
  const files = q.own.files.filter((f) => !matchAny(IGNORE, f));
  for (const f of files) {
    const fi = q.idx.eventFileIndex.get(f);
    if (fi && q.idx.events[fi[0]!]!.time < now) return 1;
    if (mode === "folder") {
      const dir = posix.dirname(f);
      if (dir !== ".") {
        const di = q.idx.eventDirIndex.get(dir);
        if (di && q.idx.events[di[0]!]!.time < now) return 1;
      }
    }
  }
  return 0;
}

type Variant = "V0" | "V1" | "V2" | "V3";
const VARIANTS: Variant[] = ["V0", "V1", "V2", "V3"];

function replaceSignal(signals: Signal[], id: string, value: number): Signal[] {
  return [...signals.filter((s) => s.id !== id), { id, value, status: "derived", summary: "", evidence: [] }];
}

function variantSignals(base: Signal[], variant: Variant, q: Query | undefined): Signal[] {
  if (!q || variant === "V0") return base; // unresolved rows keep their real, shipped V0 value in every variant (conservative: understates the effect, never overstates it).
  let signals = base;
  if (variant === "V1" || variant === "V3") signals = replaceSignal(signals, "history.prior_fixes", priorFixesValue(q, isFixV1));
  if (variant === "V2" || variant === "V3") signals = replaceSignal(signals, "history.incident", incidentValue(q, "file"));
  return signals;
}

const csv = async (file: string): Promise<JitRow[]> => parseApacheJit(await readFile(join(WORK_DIR, "data", file), "utf8")).filter((r) => r.project !== EXCLUDED_PROJECT);

async function loadRows(): Promise<ReplayRow[]> {
  const dir = join(WORK_DIR, "rows");
  const files = (await readdir(dir)).filter((f) => f.includes(BUILD) && !f.includes(".max") && !f.startsWith("hadoop."));
  const rows: ReplayRow[] = [];
  for (const file of files) {
    const [, ...lines] = (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line) as ReplayRow;
      rows.push({ ...row, signals: row.signals.map((s: Signal) => ({ ...s, summary: "", evidence: [] })) });
    }
  }
  return rows;
}

interface Resolved {
  sha: string;
  label: 0 | 1;
  base: Signal[];
  query?: Query;
}

function stats(scores: number[]): { mean: number; sd: number; iqr: number } {
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
  return { mean, sd: Math.sqrt(variance), iqr: q(0.75) - q(0.25) };
}

function bootstrapAucGain(scoresA: number[], scoresB: number[], labels: number[], seed = 7, n = BOOTSTRAP): { mean: number; lo: number; hi: number } {
  const rand = mulberry32(seed);
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Array.from({ length: labels.length }, () => Math.floor(rand() * labels.length));
    const yy = idx.map((j) => labels[j]!);
    diffs.push(aucOf(idx.map((j) => scoresA[j]!), yy)! - aucOf(idx.map((j) => scoresB[j]!), yy)!);
  }
  diffs.sort((a, b) => a - b);
  return { mean: diffs.reduce((a, b) => a + b, 0) / n, lo: diffs[Math.floor(n * 0.025)]!, hi: diffs[Math.floor(n * 0.975)]! };
}

interface VariantResult {
  variant: Variant;
  auc: number;
  r10: number;
  r30: number;
  redShare: number;
  yellowRedShare: number;
  spread: { mean: number; sd: number; iqr: number };
  gainVsV0?: { mean: number; lo: number; hi: number };
}

async function fieldRepoCounts(keepClones: boolean): Promise<{ repo: string; total: number; v0: number; v1: number }[]> {
  const dir = join(WORK_DIR, "field-repos");
  const out: { repo: string; total: number; v0: number; v1: number }[] = [];
  for (const repo of FIELD_REPOS) {
    const repoDir = join(dir, repo.name);
    console.error(`${repo.name}: cloning (blobless) ${repo.url} for the field-repo fixPattern count`);
    await mkdir(dirname(repoDir), { recursive: true });
    await rm(repoDir, { recursive: true, force: true });
    try {
      await git(dir, ["clone", "-q", "--filter=blob:none", "--no-checkout", repo.url, repoDir]);
    } catch (e) {
      console.error(`${repo.name}: skipped, clone failed: ${errorMessage(e)}`);
      continue;
    }
    const log = await git(repoDir, ["log", "--no-show-signature", "--format=%s", "HEAD"]);
    const subjects = log.split("\n").filter(Boolean);
    out.push({ repo: repo.name, total: subjects.length, v0: subjects.filter((s) => isFixV0.test(s)).length, v1: subjects.filter((s) => isFixV1.test(s)).length });
  }
  if (!keepClones) await rm(dir, { recursive: true, force: true });
  return out;
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));

  console.error("loading dataset and row cache");
  await ensureDataset(WORK_DIR);
  const [trainCsv, testCsv] = await Promise.all([csv("apachejit_train.csv"), csv("apachejit_test_large.csv")]);
  const projectOf = new Map<string, string>([...trainCsv, ...testCsv].map((r) => [r.sha, r.project]));
  const labelOf = new Map<string, 0 | 1>([...trainCsv, ...testCsv].map((r) => [r.sha, r.buggy]));
  const trainShas = new Set(trainCsv.map((r) => r.sha));
  const testShas = new Set(testCsv.map((r) => r.sha));
  const rows = await loadRows();
  const rowBySha = new Map(rows.map((r) => [r.sha, r]));

  console.error(`cloning (blobless) and indexing ${PROJECTS.length} repositories`);
  const indexByProject = new Map<string, ProjectIndex>();
  const warnings: string[] = [];
  for (const project of PROJECTS) {
    const clone = await ensureBlobless(WORK_DIR, project);
    if ("skipped" in clone) {
      warnings.push(`${project.name}: ${clone.skipped}`);
      console.error(`${project.name}: skipped, ${clone.skipped}`);
      continue;
    }
    console.error(`${project.name}: building history index`);
    try {
      indexByProject.set(project.name, buildIndex(await historyFor(clone.repoDir, clone.head)));
    } catch (e) {
      warnings.push(`${project.name}: history index failed: ${errorMessage(e)}`);
      console.error(`${project.name}: skipped, history index failed: ${errorMessage(e)}`);
    }
  }

  function resolveContext(sha: string, csvProject: string): Query | undefined {
    const name = csvProject.replace("apache/", "");
    const fallback = ALSO_IN[name];
    const tryProject = (projName: string | undefined): Query | undefined => {
      if (!projName) return undefined;
      const idx = indexByProject.get(projName);
      if (!idx) return undefined;
      const i = idx.shaIndex.get(sha.toLowerCase());
      return i === undefined ? undefined : { own: idx.commits[i]!, idx };
    };
    return tryProject(name) ?? tryProject(fallback);
  }

  console.error("resolving labelled commits to their own git history");
  const resolved: Resolved[] = [];
  let queryMisses = 0;
  for (const sha of new Set([...trainShas, ...testShas])) {
    const base = rowBySha.get(sha);
    if (!base) continue; // not in the row cache: no signals to vary, excluded from every variant the same way run.ts excludes it from coverage
    const query = resolveContext(sha, projectOf.get(sha)!);
    if (!query) queryMisses++;
    resolved.push({ sha, label: labelOf.get(sha)!, base: base.signals, query });
  }
  console.error(`resolved ${resolved.length} row-cache commits; ${queryMisses} could not be matched to a cloned history (kept at their V0 value in every variant)`);

  if (!opts.keepClones) {
    console.error("deleting ApacheJIT clones");
    await rm(join(WORK_DIR, "repos"), { recursive: true, force: true });
  }

  console.error("fitting and scoring each variant");
  const results: VariantResult[] = [];
  let v0Default: number[] | undefined;
  let v0Calibrated: number[] | undefined;
  let yTest: number[] | undefined;
  for (const variant of VARIANTS) {
    const toRow = (r: Resolved): ReplayRow => ({ sha: r.sha, time: r.query?.own.time ?? 0, label: r.label, signals: variantSignals(r.base, variant, r.query) });
    const train = resolved.filter((r) => trainShas.has(r.sha)).map(toRow);
    const test = resolved.filter((r) => testShas.has(r.sha)).map(toRow);
    const model = fitModel(train, DEFAULT_WEIGHTS, "pooled");
    const calibratedScores = test.map((r) => scoreSignals(r.signals, model).score);
    const defaultScores = test.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score);
    const labels = test.map((r) => r.label);
    yTest ??= labels;
    if (variant === "V0") {
      v0Default = defaultScores;
      v0Calibrated = calibratedScores;
    }
    const result: VariantResult = {
      variant,
      auc: aucOf(calibratedScores, labels)!,
      r10: recallAt(calibratedScores, labels, 10),
      r30: recallAt(calibratedScores, labels, 30),
      redShare: defaultScores.filter((s) => s >= RED).length / defaultScores.length,
      yellowRedShare: defaultScores.filter((s) => s >= GREEN).length / defaultScores.length,
      spread: stats(defaultScores),
    };
    if (variant !== "V0") result.gainVsV0 = bootstrapAucGain(calibratedScores, v0Calibrated!, yTest);
    console.error(
      `${variant}: AUC ${result.auc.toFixed(3)}, recall@10% ${(result.r10 * 100).toFixed(1)}%, red ${(result.redShare * 100).toFixed(1)}%, yellow+red ${(result.yellowRedShare * 100).toFixed(1)}%`,
    );
    results.push(result);
  }

  console.error("counting fixPattern matches on the field-test repos");
  const fieldCounts = await fieldRepoCounts(opts.keepClones);

  const v0RedShare = results[0]!.redShare;
  const THRESHOLD = 0.25; // relative reduction required to adopt, per the pre-registration
  const lines: string[] = [];
  lines.push("# Score saturation: fixPattern and incident granularity on ApacheJIT", "");
  lines.push(
    "Generated by `bench/apachejit/score-saturation-experiment.ts`. Pooled over every project except `apache/hadoop`, on the dataset's official split. " +
      `Row cache build \`${BUILD}\`; every signal but \`history.prior_fixes\`/\`history.incident\` is the real, shipped value.`,
    "",
  );
  lines.push("## Coverage", "");
  lines.push(`- ${resolved.length} row-cache commits considered; ${queryMisses} could not be resolved to a cloned history (kept at their real V0 value in every variant).`);
  if (warnings.length) lines.push(`- Project warnings: ${warnings.join("; ")}`);
  lines.push("");
  lines.push("## Variants", "");
  lines.push("- **V0 (current).** Shipped `history.fixPattern` and folder-or-file `history.incident` matching.");
  lines.push(`- **V1 (fixPattern excludes housekeeping scopes).** \`${FIX_PATTERN_V1}\``);
  lines.push("- **V2 (incident at file level).** Drops the folder-level branch of `history.incident`'s matching.");
  lines.push("- **V3.** V1 and V2 together.", "");
  lines.push("## Results (test split)", "");
  lines.push(
    "| Variant | Calibrated AUC | AUC gain vs V0 (95% CI) | Recall@10% | Recall@30% | Default-prior red share (≥0.8) | Default-prior yellow+red share (≥0.3) | Red share, relative change | Default score mean/SD/IQR |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    const gain = r.gainVsV0 ? `${r.gainVsV0.mean >= 0 ? "+" : ""}${r.gainVsV0.mean.toFixed(4)} (${r.gainVsV0.lo.toFixed(4)} to ${r.gainVsV0.hi.toFixed(4)})` : "—";
    const relChange = r.variant === "V0" ? "—" : `${(((r.redShare - v0RedShare) / v0RedShare) * 100).toFixed(1)}%`;
    lines.push(
      `| ${r.variant} | ${r.auc.toFixed(3)} | ${gain} | ${(r.r10 * 100).toFixed(1)}% | ${(r.r30 * 100).toFixed(1)}% | ${(r.redShare * 100).toFixed(1)}% | ${(r.yellowRedShare * 100).toFixed(1)}% | ${relChange} | ${r.spread.mean.toFixed(3)} / ${r.spread.sd.toFixed(3)} / ${r.spread.iqr.toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push("## Field-repo fixPattern counts (descriptive, not ApacheJIT)", "");
  lines.push("One `git log --format=%s` per repo on a fresh blobless clone of its default branch HEAD at run time.", "");
  lines.push("| Repo | Commits | V0 matches | V0 share | V1 matches | V1 share | Relative drop |", "|---|---:|---:|---:|---:|---:|---:|");
  for (const f of fieldCounts) {
    const drop = f.v0 === 0 ? "—" : `${(((f.v0 - f.v1) / f.v0) * 100).toFixed(1)}%`;
    lines.push(`| ${f.repo} | ${f.total} | ${f.v0} | ${((f.v0 / f.total) * 100).toFixed(1)}% | ${f.v1} | ${((f.v1 / f.total) * 100).toFixed(1)}% | ${drop} |`);
  }
  lines.push("");
  lines.push("## Decision (pre-registration's rule, applied per variant)", "");
  for (const r of results.slice(1)) {
    const relDrop = (v0RedShare - r.redShare) / v0RedShare;
    const redOk = relDrop >= THRESHOLD;
    const aucOk = r.gainVsV0 !== undefined && (r.gainVsV0.lo > 0 || (r.gainVsV0.lo <= 0 && r.gainVsV0.hi >= 0));
    lines.push(
      `- **${r.variant}.** Red-share relative reduction ${(relDrop * 100).toFixed(1)}% ${redOk ? "≥" : "<"} ${THRESHOLD * 100}% threshold; AUC-gain 95% CI ${r.gainVsV0!.lo.toFixed(4)} to ${r.gainVsV0!.hi.toFixed(4)} (${aucOk ? "includes 0 or positive — no significant loss" : "entirely negative — significant loss"}) → **${redOk && aucOk ? "adopt" : "reject"}**.`,
    );
  }
  lines.push("");
  lines.push(
    "## Caveats",
    "",
    "- **No rename detection.** The per-commit file lists come from `git log --name-only --no-renames` (not the shipped detector's `-M`), so a rename shows as a delete and an add rather than one path; both the current commit's own changed files and the historical file-touch index use the same raw paths. This understates `history.prior_fixes`'s true lookback count and can miss a file-level `history.incident` match across a rename, in both V0's reproduction and every other variant equally.",
    `- **Unresolved rows keep their real V0 value.** ${queryMisses} of ${resolved.length} row-cache commits could not be matched to the cloned history by sha (a shallow fallback mismatch, or a sha the clone does not have); those rows never vary across V0–V3, which understates each variant's effect rather than overstating it.`,
    "- **The decision rule's AUC side accepts a CI that excludes 0 in the negative direction as a loss, not a wash** — consistent with the change-coupling experiment's reading of the same kind of rule.",
    "- **ApacheJIT is Java and mostly pre-dates Conventional Commits**, hence the separate, descriptive field-repo count on vite/black/cli, which do use that convention.",
    "",
  );
  await writeFile(OUT, lines.join("\n"));
  console.error(`wrote ${OUT.pathname}`);
}

await main();
