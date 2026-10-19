/**
 * Change-coupling experiment (spec §10.1 of docs/specs/2026-10-19-captain-brief-design.md): does
 * `coupling.missing` predict ApacheJIT bugs, and should it also enter the calibrated score?
 *
 * Reuses `run.ts`'s dataset loader, the existing row cache (signals already replayed by a full
 * `run.ts` run) and `couplingPairs` exactly as shipped (`src/architecture/coupling.ts`). Only the
 * per-commit file history is new: one blobless clone (`git clone --filter=blob:none
 * --no-checkout`) per project and one `git log --name-only --no-renames` spawn per clone (file
 * lists only, never one spawn per commit; rename detection is skipped deliberately — it is the
 * slow part of a full-history walk and coupling only needs each commit's own file list). No LLM
 * calls.
 *
 * Run `npm run build` first, then `node bench/apachejit/coupling-experiment.ts`. Deletes its
 * clones when it finishes (`--keep-clones` to skip that, for a re-run while iterating).
 */
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { couplingPairs } from "../../dist/architecture/coupling.js";
import { defaultConfig } from "../../dist/domain/config.js";
import type { CommitInfo, Signal } from "../../dist/domain/types.js";
import { matchAny } from "../../dist/git/glob.js";
import { fitLogistic, mulberry32, resampleNegatives } from "../../dist/model/fit.js";
import { featureValues, sigmoid } from "../../dist/model/logistic.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import type { ReplayRow } from "../../dist/model/replay.js";
import { languageFamily } from "../../dist/signals/language.js";
import { aucOf, parseApacheJit, PROJECTS } from "./lib.ts";
import type { JitRow, Project } from "./lib.ts";
import { ALSO_IN, ensureDataset, git } from "./run.ts";

const WORK_DIR = join(homedir(), ".cache", "opendrs", "apachejit");
/** The row cache build with every project replayed (`ls ~/.cache/opendrs/apachejit/rows`). */
const BUILD = "08355066ee67";
const EXCLUDED_PROJECT = "apache/hadoop"; // no positive labels; every other ApacheJIT table excludes it too.
const MIN_SUPPORT_GRID = [3, 5, 8];
const MIN_CONFIDENCE_GRID = [0.5, 0.6, 0.75];
const MAX_FILES_PER_COMMIT = 30; // fixed by spec §6.1, not tuned
const LOOKBACK_DAYS = defaultConfig().history.lookbackDays; // 365
const LIFT_THRESHOLD = 1.2;
const BOOTSTRAP = 2000;
const OUT = new URL("./coupling-experiment.md", import.meta.url);

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parseOptions(argv: string[]): { keepClones: boolean; projects?: string[] } {
  const { values } = parseArgs({ args: argv, options: { "keep-clones": { type: "boolean", default: false }, projects: { type: "string" } } });
  return { keepClones: values["keep-clones"], projects: values.projects?.split(",").map((s) => s.trim()) };
}

/** A file this detector never treats as A or B: docs, lockfiles and other ignored paths (spec §6.1), the shipped default config. */
const IGNORE = defaultConfig().paths.ignore;
const excluded = (path: string): boolean => matchAny(IGNORE, path) || languageFamily(path) === "docs";

/** Blobless, no-checkout clone at the project's pinned head: same layout as run.ts's full clones, but without blob objects. */
async function ensureBlobless(workDir: string, project: Project): Promise<{ repoDir: string; head: string } | { skipped: string }> {
  const repoDir = join(workDir, "repos", project.name);
  if (!existsSync(repoDir)) {
    const partial = `${repoDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(repoDir), { recursive: true });
    console.error(`${project.name}: cloning (blobless) ${project.url}`);
    try {
      await git(workDir, ["clone", "-q", "--filter=blob:none", "--no-checkout", project.url, partial]);
      // A detached `git gc --auto` on a freshly packed clone can hold a lock while the single big
      // `git log` below is running and make it time out (tests/helpers/repo.ts hits the same race).
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

/**
 * One `git log --name-only --no-renames` spawn per clone: sha, time and files, nothing else
 * (coupling only needs each commit's own file list, not history.ts's full rename lineage).
 * Sorted ascending for the binary search below. `--no-renames` keeps this fast on a huge history:
 * `-M` rename detection is what made the first attempt at this time out at history.ts's 120s
 * `git()` default.
 */
async function historyFor(repoDir: string, head: string): Promise<CommitInfo[]> {
  const out = await git(repoDir, ["-c", "core.quotepath=off", "log", "--name-only", "--no-renames", "--no-show-signature", "--format=%x00%H%x1f%ct%x1d", "--end-of-options", head]);
  const commits: CommitInfo[] = [];
  for (const record of out.split(RECORD)) {
    const end = record.lastIndexOf(END);
    if (end < 0) continue;
    const [sha = "", time = "0"] = record.slice(0, end).split(FIELD);
    const files = record
      .slice(end + 1)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    // Only sha/time/files feed couplingPairs; the rest are placeholders to satisfy CommitInfo.
    commits.push({ sha, parents: [], authorName: "", authorEmail: "", time: Number(time), subject: "", files, isFix: false, isRevert: false, source: "human" });
  }
  return commits.sort((a, b) => a.time - b.time);
}

/** First index with commits[i].time >= t (commits sorted ascending). */
function lowerBound(commits: CommitInfo[], t: number): number {
  let lo = 0;
  let hi = commits.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (commits[mid]!.time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** One labelled commit resolved to its own repo's history, with the commits in its lookback window precomputed once (shared across every grid point). */
interface Context {
  sha: string;
  label: 0 | 1;
  files: string[];
  window: CommitInfo[];
}

interface GridPoint {
  minSupport: number;
  minConfidence: number;
}

/** Firing files (log1p count) for one context at one grid point. */
function fireCount(ctx: Context, g: GridPoint): number {
  return couplingPairs(ctx.window, ctx.files, { minSupport: g.minSupport, minConfidence: g.minConfidence, maxFilesPerCommit: MAX_FILES_PER_COMMIT, exclude: excluded }).length;
}

interface LiftStats {
  fires: number;
  total: number;
  buggyWhenFires: number;
  baseRate: number;
}

function liftStats(contexts: Context[], g: GridPoint): LiftStats {
  let fires = 0;
  let buggyWhenFires = 0;
  let positives = 0;
  for (const ctx of contexts) {
    if (ctx.label === 1) positives++;
    if (fireCount(ctx, g) > 0) {
      fires++;
      if (ctx.label === 1) buggyWhenFires++;
    }
  }
  return { fires, total: contexts.length, buggyWhenFires, baseRate: positives / contexts.length };
}

const lift = (s: LiftStats): number => (s.fires === 0 ? NaN : s.buggyWhenFires / s.fires / s.baseRate);

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

/** The feature vector calibrate.ts fits on (its own `featureVector` is not exported), as fit-experiment.ts does. */
const vector = (signals: Signal[], ids: string[]): number[] => {
  const values = featureValues(signals, DEFAULT_WEIGHTS.priors);
  return ids.map((id) => values.get(id) ?? DEFAULT_WEIGHTS.priors?.[id] ?? 0);
};

function fitAndScore(train: { signals: Signal[]; label: 0 | 1 }[], test: { signals: Signal[] }[], ids: string[]): number[] {
  const sample = resampleNegatives(train, (r) => r.label === 1, 5, 1);
  const fit = fitLogistic(
    sample.map((r) => vector(r.signals, ids)),
    sample.map((r) => r.label),
    { l2: 0.01, priorWeights: ids.map((id) => DEFAULT_WEIGHTS.weights[id] ?? 0) },
  );
  return test.map((r) => sigmoid(vector(r.signals, ids).reduce((z, x, j) => z + fit.weights[j]! * x, fit.intercept)));
}

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  const projects = PROJECTS.filter((p) => !opts.projects || opts.projects.includes(p.name));

  console.error("loading dataset and row cache");
  await ensureDataset(WORK_DIR); // downloads/verifies the CSVs if they are not already cached
  const [trainCsv, testCsv] = await Promise.all([csv("apachejit_train.csv"), csv("apachejit_test_large.csv")]);
  const projectOf = new Map<string, string>([...trainCsv, ...testCsv].map((r) => [r.sha, r.project]));
  const labelOf = new Map<string, 0 | 1>([...trainCsv, ...testCsv].map((r) => [r.sha, r.buggy]));
  const trainShas = new Set(trainCsv.map((r) => r.sha));
  const testShas = new Set(testCsv.map((r) => r.sha));

  const names = new Set(projects.map((p) => p.name));
  if (projects.some((p) => p.name in ALSO_IN)) names.add("hadoop"); // needed for the hdfs/mapreduce fallback
  console.error(`cloning (blobless) and indexing ${names.size} repositories`);
  const byProjectName = new Map<string, CommitInfo[]>();
  const warnings: string[] = [];
  for (const name of names) {
    const project = PROJECTS.find((p) => p.name === name)!;
    const clone = await ensureBlobless(WORK_DIR, project);
    if ("skipped" in clone) {
      warnings.push(`${name}: ${clone.skipped}`);
      console.error(`${name}: skipped, ${clone.skipped}`);
      continue;
    }
    console.error(`${name}: building history index`);
    try {
      byProjectName.set(name, await historyFor(clone.repoDir, clone.head));
    } catch (e) {
      warnings.push(`${name}: history index failed: ${errorMessage(e)}`);
      console.error(`${name}: skipped, history index failed: ${errorMessage(e)}`);
    }
  }

  // sha -> Context, resolved in the commit's own project repo, falling back to apache/hadoop for hdfs/mapreduce.
  const bySha = new Map<string, CommitInfo>();
  for (const [name, commits] of byProjectName) for (const c of commits) if (!bySha.has(`${name}:${c.sha}`)) bySha.set(`${name}:${c.sha}`, c);

  function resolve(sha: string): Context | undefined {
    const project = projectOf.get(sha);
    if (!project) return undefined;
    const name = project.replace("apache/", "");
    const fallback = ALSO_IN[name];
    const commit = bySha.get(`${name}:${sha}`) ?? (fallback ? bySha.get(`${fallback}:${sha}`) : undefined);
    const commits = byProjectName.get(name) ?? (fallback ? byProjectName.get(fallback) : undefined);
    if (!commit || !commits) return undefined;
    const from = commit.time - LOOKBACK_DAYS * 86_400;
    const lo = lowerBound(commits, from);
    const hi = lowerBound(commits, commit.time);
    return { sha, label: labelOf.get(sha)!, files: commit.files, window: commits.slice(lo, hi) };
  }

  const resolveAll = (shas: Iterable<string>): Context[] => {
    const out: Context[] = [];
    for (const sha of shas) {
      const ctx = resolve(sha);
      if (ctx) out.push(ctx);
    }
    return out;
  };
  console.error("resolving labelled commits to their history");
  const trainContexts = resolveAll(trainShas);
  const testContexts = resolveAll(testShas);
  console.error(`train: ${trainContexts.length}/${trainShas.size} resolved; test: ${testContexts.length}/${testShas.size} resolved`);

  if (!opts.keepClones) {
    console.error("deleting clones");
    await rm(join(WORK_DIR, "repos"), { recursive: true, force: true });
  }

  console.error("tuning minSupport x minConfidence on train");
  const grid: Array<GridPoint & { trainLift: number; stats: LiftStats }> = [];
  for (const minSupport of MIN_SUPPORT_GRID) {
    for (const minConfidence of MIN_CONFIDENCE_GRID) {
      const g = { minSupport, minConfidence };
      const stats = liftStats(trainContexts, g);
      grid.push({ ...g, trainLift: lift(stats), stats });
      console.error(`  minSupport=${minSupport} minConfidence=${minConfidence}: fires ${stats.fires}/${stats.total}, train lift ${lift(stats).toFixed(3)}`);
    }
  }
  const valid = grid.filter((g) => Number.isFinite(g.trainLift));
  const chosen = valid.reduce((best, g) => (g.trainLift > best.trainLift ? g : best), valid[0]!);
  console.error(`chosen: minSupport=${chosen.minSupport} minConfidence=${chosen.minConfidence} (train lift ${chosen.trainLift.toFixed(3)})`);

  console.error("measuring test lift once, at the chosen thresholds");
  const testStats = liftStats(testContexts, chosen);
  const testLift = lift(testStats);
  console.error(`test: fires ${testStats.fires}/${testStats.total}, buggy among them ${testStats.buggyWhenFires} (${((testStats.buggyWhenFires / testStats.fires) * 100).toFixed(1)} %), base rate ${(testStats.baseRate * 100).toFixed(1)} %, lift ${testLift.toFixed(3)}`);

  console.error("loading the existing row cache and fitting with/without coupling.missing");
  const rows = await loadRows();
  const rowByEverySha = new Map(rows.map((r) => [r.sha, r]));
  const couplingValue = new Map<string, number>();
  for (const ctx of [...trainContexts, ...testContexts]) couplingValue.set(ctx.sha, Math.log1p(fireCount(ctx, chosen)));

  const withSignal = (sha: string): Signal[] => {
    const r = rowByEverySha.get(sha);
    const base = r ? r.signals : [];
    return [...base, { id: "coupling.missing", value: couplingValue.get(sha) ?? 0, status: "derived" as const, summary: "", evidence: [] }];
  };
  const resolvedTrainShas = trainContexts.map((c) => c.sha).filter((sha) => rowByEverySha.has(sha));
  const resolvedTestShas = testContexts.map((c) => c.sha).filter((sha) => rowByEverySha.has(sha));
  console.error(`row cache coverage: train ${resolvedTrainShas.length}/${trainContexts.length}, test ${resolvedTestShas.length}/${testContexts.length}`);

  const idsWithout = [...new Set([...Object.keys(DEFAULT_WEIGHTS.weights), ...rows.flatMap((r) => r.signals.map((s) => s.id))])].sort();
  const idsWith = [...idsWithout, "coupling.missing"].sort();

  const trainRowsFor = (ids: string[]) => resolvedTrainShas.map((sha) => ({ signals: ids.includes("coupling.missing") ? withSignal(sha) : rowByEverySha.get(sha)!.signals, label: labelOf.get(sha)! }));
  const testRowsFor = (ids: string[]) => resolvedTestShas.map((sha) => ({ signals: ids.includes("coupling.missing") ? withSignal(sha) : rowByEverySha.get(sha)!.signals }));

  const yTest = resolvedTestShas.map((sha) => labelOf.get(sha)!);
  const scoresWithout = fitAndScore(trainRowsFor(idsWithout), testRowsFor(idsWithout), idsWithout);
  const scoresWith = fitAndScore(trainRowsFor(idsWith), testRowsFor(idsWith), idsWith);
  const aucWithout = aucOf(scoresWithout, yTest)!;
  const aucWith = aucOf(scoresWith, yTest)!;
  console.error(`test AUC: without coupling.missing ${aucWithout.toFixed(3)}, with ${aucWith.toFixed(3)}`);

  const rand = mulberry32(7);
  const diffs: number[] = [];
  for (let i = 0; i < BOOTSTRAP; i++) {
    const idx = Array.from({ length: yTest.length }, () => Math.floor(rand() * yTest.length));
    const yy = idx.map((j) => yTest[j]!);
    diffs.push(aucOf(idx.map((j) => scoresWith[j]!), yy)! - aucOf(idx.map((j) => scoresWithout[j]!), yy)!);
  }
  diffs.sort((a, b) => a - b);
  const ciLow = diffs[Math.floor(diffs.length * 0.025)]!;
  const ciHigh = diffs[Math.floor(diffs.length * 0.975)]!;
  const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  console.error(`AUC gain: ${(aucWith - aucWithout).toFixed(4)} (bootstrap mean ${mean.toFixed(4)}, 95% CI ${ciLow.toFixed(4)} to ${ciHigh.toFixed(4)})`);

  const liftDecision = testLift >= LIFT_THRESHOLD;
  // Spec §10.1 means a significant *positive* gain, not merely "the CI excludes 0": a CI entirely
  // below 0 also excludes 0, but that is evidence the signal hurts the score, not that it helps.
  const aucDecision = ciLow > 0;
  const ciDescription = ciLow <= 0 && ciHigh >= 0 ? "includes 0" : ciLow > 0 ? "excludes 0 (positive)" : "excludes 0, but negative";

  const lines: string[] = [];
  lines.push("# Change coupling on ApacheJIT", "");
  lines.push(`Generated by \`bench/apachejit/coupling-experiment.ts\`. Pooled over every project except \`apache/hadoop\` (no positive labels), on the dataset's official split.`, "");
  lines.push("## Coverage", "");
  lines.push(`- Train: ${trainContexts.length}/${trainShas.size} labelled commits resolved to a cloned history (${warnings.length} project(s) skipped: ${warnings.join("; ") || "none"}).`);
  lines.push(`- Test: ${testContexts.length}/${testShas.size} labelled commits resolved.`);
  lines.push(`- Row-cache coverage for the AUC comparison: train ${resolvedTrainShas.length}/${trainContexts.length}, test ${resolvedTestShas.length}/${testContexts.length}.`, "");
  lines.push("## Tuning on train (2003-2016)", "");
  lines.push("| minSupport | minConfidence | Fires | Train lift |", "|---:|---:|---:|---:|");
  for (const g of grid) lines.push(`| ${g.minSupport} | ${g.minConfidence} | ${g.stats.fires}/${g.stats.total} | ${Number.isFinite(g.trainLift) ? g.trainLift.toFixed(3) : "—"} |`);
  lines.push("", `**Chosen by train lift:** minSupport ${chosen.minSupport}, minConfidence ${chosen.minConfidence} (train lift ${chosen.trainLift.toFixed(3)}).`, "");
  lines.push("## Test (2017-2019), measured once", "");
  lines.push(`- Base rate: ${(testStats.baseRate * 100).toFixed(1)} % (${testStats.total} commits).`);
  lines.push(`- Fires on ${testStats.fires} commits (${((testStats.fires / testStats.total) * 100).toFixed(1)} %); ${testStats.buggyWhenFires} of them buggy (${((testStats.buggyWhenFires / testStats.fires) * 100).toFixed(1)} %).`);
  lines.push(`- **Lift: ${testLift.toFixed(3)}×** (threshold for shipping enabled by default: ${LIFT_THRESHOLD}×).`, "");
  lines.push("## Score: calibrated AUC with and without `coupling.missing`", "");
  lines.push(`- Without: ${aucWithout.toFixed(3)}. With (count of firing files, log1p): ${aucWith.toFixed(3)}.`);
  lines.push(`- Paired bootstrap (${BOOTSTRAP} resamples, test commits resampled together): mean ${mean >= 0 ? "+" : ""}${mean.toFixed(4)}, 95 % CI ${ciLow.toFixed(4)} to ${ciHigh.toFixed(4)}.`, "");
  lines.push("## Decision (spec §10.1, applied exactly)", "");
  lines.push(`- Lift ${testLift.toFixed(3)}× ${liftDecision ? "≥" : "<"} 1.2× → ${liftDecision ? "the fact ships with the tuned defaults." : "the detector ships with `captain.coupling.enabled: false` by default; this is a dead end."}`);
  lines.push(`- AUC-gain 95 % CI ${ciLow.toFixed(4)} to ${ciHigh.toFixed(4)} ${ciDescription} → ${aucDecision ? "the signal also enters the calibrated score." : "it stays brief-only."}`, "");
  if (warnings.length) {
    lines.push("## Warnings", "", ...warnings.map((w) => `- ${w}`), "");
  }
  lines.push(
    "## Caveats",
    "",
    "- **No rename detection.** The per-commit file lists come from `git log --name-only --no-renames` (not the shipped detector's `-M`), so a rename shows as a delete and an add rather than one path. `-M` is what made the first attempt at this time out on the larger histories.",
    "- **`exists at head` is not checked.** The shipped detector drops a fact when the partner was later deleted; this backtest has no notion of \"head\" beyond the commit itself, so it always treats a historically co-changing partner as present.",
    `- **The grid is chosen by train lift alone**, with no minimum fire count; a combination that rarely fires can still win on a lucky train split. The chosen point here fires on ${chosen.stats.fires} of ${chosen.stats.total} train commits, which is not a small sample.`,
    "",
  );
  await writeFile(OUT, lines.join("\n"));
  console.error(`wrote ${OUT.pathname}`);
}

await main();
