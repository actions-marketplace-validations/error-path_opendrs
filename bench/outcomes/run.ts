/**
 * bench/outcomes: the I/O half of the outcome-labels harness (spec
 * docs/specs/2026-10-23-outcome-labels-design.md). Four resumable steps:
 *
 *   fetch  — GitHub (read-only `gh api`): pinned head, merged PRs, review comments, reviews
 *   build  — clones, merge-shape resolution, corpus.json, one captain brief per PR (dist/)
 *   label  — fix commits in the window, SZZ-lite blame, labels.json
 *   eval   — per-fact labels, lifts, decision rule, priority table, drift, results.md/json
 *
 * Everything fetched or computed is cached under ~/.cache/opendrs/outcomes/ and reused, so an
 * interrupted run resumes. No LLM, no paid API. Node >= 23.6 (type stripping), like
 * bench/verify/run.ts; imports dist/, so `npm run build` first.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { defaultConfig, type OpendrsConfig } from "../../dist/domain/config.js";
import type { ArchitectureFact, CommitInfo, HistoryIndex } from "../../dist/domain/types.js";
import { scoreDiff } from "../../dist/engine.js";
import { loadDiff } from "../../dist/git/diff.js";
import { git } from "../../dist/git/exec.js";
import { buildHistoryIndex } from "../../dist/git/history.js";
import { blameFix } from "../../dist/model/label.js";
import {
  addedLines,
  changesRequested,
  countedComments,
  drift,
  fixCandidates,
  hitsOnPr,
  isRevertOfPr,
  labelFact,
  prRange,
  priorityTable,
  rateLimitWaitMs,
  renderResults,
  resolveMergeShape,
  selectPulls,
  summarise,
  type BlameHit,
  type CommentLoc,
  type CorpusFile,
  type CorpusPr,
  type CorpusRepo,
  type ExclusionReason,
  type FactRecord,
  type FactTypeSummary,
  type GhPullSummary,
  type PrFile,
  type Priority,
} from "./lib.ts";

const execFileAsync = promisify(execFile);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const CACHE = join(homedir(), ".cache/opendrs/outcomes");
const WINDOW_DAYS = 90;
const LOOKBACK_DAYS = 365;
const PER_REPO = 60;
const LINE_WINDOW = 10;
const BLAME_CONCURRENCY = 4;

/**
 * Spec §3: the six repos. `config` holds the field test's recorded quirks (fastlane). Every clone
 * is full: the vite pilot on a blobless clone spent 2–6 min per brief in partial-clone lazy
 * fetches (one small promisor pack per batch of missing blobs the graph build touched), which a
 * full clone removes without changing anything the brief computes.
 */
const REPOS: ReadonlyArray<Pick<CorpusRepo, "slug" | "repo" | "language" | "config">> = [
  { slug: "black", repo: "psf/black", language: "python" },
  { slug: "cli-cli", repo: "cli/cli", language: "go" },
  { slug: "actix-web", repo: "actix/actix-web", language: "rust" },
  { slug: "vite", repo: "vitejs/vite", language: "js" },
  { slug: "fastlane", repo: "fastlane/fastlane", language: "ruby", config: { "history.maxCommits": 1500, "history.lookbackDays": 90 } },
  { slug: "mockito", repo: "mockito/mockito", language: "java" },
];

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const log = (msg: string): void => console.error(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
const sec = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

async function readJson<T>(file: string): Promise<T | undefined> {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return undefined; // a partial write from an interrupted run: redo it
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 1)}\n`);
  await rename(tmp, file);
}

/** Bounded pool, in input order of start; errors propagate. */
async function pool<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// GitHub

let ghCalls = 0;

/** `gh api <path>` (read-only), cached one file per request; rate limit checked every 50 calls. */
async function ghJson<T>(path: string): Promise<T> {
  const file = join(CACHE, "gh", `${path.replace(/[^\w.=-]+/g, "_")}.json`);
  const cached = await readJson<T>(file);
  if (cached !== undefined) return cached;
  if (ghCalls++ % 50 === 0) {
    const { stdout } = await execFileAsync("gh", ["api", "rate_limit", "--jq", ".resources.core"]);
    const core = JSON.parse(stdout) as { remaining: number; reset: number };
    const wait = rateLimitWaitMs(core.remaining, core.reset, Math.floor(Date.now() / 1000));
    if (wait > 0) {
      log(`rate limit: ${core.remaining} left, sleeping ${Math.round(wait / 1000)} s until reset`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  for (let attempt = 0; ; attempt++) {
    try {
      const { stdout } = await execFileAsync("gh", ["api", path], { maxBuffer: 1 << 28 });
      const value = JSON.parse(stdout) as T;
      await writeJson(file, value);
      return value;
    } catch (e) {
      const msg = errorMessage(e);
      if (attempt < 3 && /HTTP (403|429|5\d\d)|rate limit/i.test(msg)) {
        const delay = 30_000 * 2 ** attempt;
        log(`gh api ${path}: ${msg.split("\n")[0]}; retrying in ${delay / 1000} s`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw new Error(`gh api ${path}: ${msg}`);
    }
  }
}

/** Every page of a list endpoint, until a short page. */
async function ghPages<T>(path: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; ; page++) {
    const items = await ghJson<T[]>(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

interface GhPull extends GhPullSummary {
  title: string;
  commits: number;
  changed_files: number;
}
interface GhComment {
  path: string;
  line: number | null;
  original_line: number | null;
  user: { login: string; type: string };
}
interface GhReview {
  state: string;
  user: { type: string };
}

/** What `fetch` leaves per repo, and `build`/`label` read: the pinned head and the selection. */
interface Selection {
  defaultBranch: string;
  head: string;
  headTime: number;
  selected: number[];
  excluded: Array<{ number: number; reason: ExclusionReason }>;
}

const selectionFile = (slug: string): string => join(CACHE, "gh", slug, "selection.json");

async function fetchRepo(repo: (typeof REPOS)[number], limit: number): Promise<Selection> {
  const existing = await readJson<Selection>(selectionFile(repo.slug));
  const [owner, name] = repo.repo.split("/");
  const info = await ghJson<{ default_branch: string }>(`repos/${owner}/${name}`);
  // The head is pinned by the cache: the first fetch's answer is the one every later run sees.
  const head = await ghJson<{ sha: string; commit: { committer: { date: string } } }>(`repos/${owner}/${name}/commits/${info.default_branch}`);
  const headTime = sec(head.commit.committer.date);
  let selection: Selection;
  if (existing && existing.head === head.sha) {
    selection = existing;
  } else {
    const pulls: GhPullSummary[] = [];
    for (let page = 1; ; page++) {
      const items = await ghJson<GhPullSummary[]>(`repos/${owner}/${name}/pulls?state=closed&base=${info.default_branch}&sort=created&direction=desc&per_page=100&page=${page}`);
      pulls.push(...items);
      const { stopPaging } = selectPulls(items, headTime, { windowDays: WINDOW_DAYS, lookbackDays: LOOKBACK_DAYS, perRepo: PER_REPO });
      if (stopPaging || items.length < 100) break;
    }
    const { selected, excluded } = selectPulls(pulls, headTime, { windowDays: WINDOW_DAYS, lookbackDays: LOOKBACK_DAYS, perRepo: PER_REPO });
    selection = { defaultBranch: info.default_branch, head: head.sha, headTime, selected: selected.map((p) => p.number), excluded: excluded.filter((e) => e.reason !== "not-merged" && e.reason !== "merged-inside-window") };
    await writeJson(selectionFile(repo.slug), selection);
  }
  for (const n of selection.selected.slice(0, limit)) {
    await ghJson<GhPull>(`repos/${owner}/${name}/pulls/${n}`);
    await ghPages<GhComment>(`repos/${owner}/${name}/pulls/${n}/comments`);
    await ghPages<GhReview>(`repos/${owner}/${name}/pulls/${n}/reviews`);
  }
  log(`${repo.slug}: head ${selection.head.slice(0, 7)} (${new Date(selection.headTime * 1000).toISOString().slice(0, 10)}), ${selection.selected.length} PRs selected, ${selection.excluded.length} excluded before reconstruction`);
  return selection;
}

const prDetail = (repo: string, n: number) => ghJson<GhPull>(`repos/${repo}/pulls/${n}`);

// ---------------------------------------------------------------------------------------------
// Clones and history

const cloneDir = (slug: string): string => join(CACHE, "clones", slug);

async function ensureClone(repo: (typeof REPOS)[number], head: string): Promise<string> {
  const dir = cloneDir(repo.slug);
  if (!existsSync(dir)) {
    const partial = `${dir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(dir), { recursive: true });
    log(`${repo.slug}: cloning (full)`);
    await execFileAsync("git", ["clone", "-q", `https://github.com/${repo.repo}.git`, partial], { maxBuffer: 1 << 28 });
    await rename(partial, dir);
  }
  try {
    await git(dir, ["rev-parse", "--verify", "--quiet", `${head}^{commit}`]);
  } catch {
    await git(dir, ["fetch", "-q", "origin", head], { timeoutMs: 600_000 });
  }
  return dir;
}

function repoConfig(repo: (typeof REPOS)[number]): OpendrsConfig {
  const config = defaultConfig();
  const max = repo.config?.["history.maxCommits"];
  const days = repo.config?.["history.lookbackDays"];
  if (max !== undefined) config.history.maxCommits = max;
  if (days !== undefined) config.history.lookbackDays = days;
  return config;
}

const histories = new Map<string, Promise<HistoryIndex>>();
function historyOf(slug: string, repoDir: string, head: string, config: OpendrsConfig): Promise<HistoryIndex> {
  let h = histories.get(slug);
  if (!h) {
    log(`${slug}: building the history index at ${head.slice(0, 7)}`);
    h = buildHistoryIndex(repoDir, head, config);
    histories.set(slug, h);
  }
  return h;
}

// ---------------------------------------------------------------------------------------------
// build

interface BriefFile {
  priority: Priority;
  facts: ArchitectureFact[];
  notes: string[];
  score: number;
  tier: string;
  files: PrFile[];
  ms: number;
}

interface RepoBuild {
  repo: CorpusRepo;
  prs: CorpusPr[];
  excluded: CorpusFile["excluded"];
}

const buildFile = (slug: string): string => join(CACHE, "build", `${slug}.json`);
const briefFile = (slug: string, n: number): string => join(CACHE, "briefs", slug, `${n}.json`);

async function resolvePr(repoDir: string, repo: (typeof REPOS)[number], detail: GhPull, firstParent: ReadonlySet<string>): Promise<CorpusPr | { reason: ExclusionReason; detail: string }> {
  const M = detail.merge_commit_sha;
  if (!firstParent.has(M)) return { reason: "not-first-parent", detail: `merge commit ${M.slice(0, 7)} is not on the pinned head's first-parent history` };
  const [parents = "", rawSubject = ""] = (await git(repoDir, ["show", "-s", "--format=%P%x00%s", M])).split("\0");
  const subject = rawSubject.trim();
  const shape = resolveMergeShape({ parents: parents.split(" ").filter(Boolean), subject, commits: detail.commits, number: detail.number });
  const range = prRange(shape, M, detail.commits);
  const commits = (await git(repoDir, ["rev-list", "--no-merges", range.revList])).split("\n").filter(Boolean);
  return { slug: repo.slug, number: detail.number, author: detail.user.login, mergeSha: M, mergedAt: detail.merged_at!, mergeSubject: subject, shape, base: range.base, head: range.head, commits, changedFiles: detail.changed_files };
}

async function briefPr(repoDir: string, repo: (typeof REPOS)[number], pr: CorpusPr, config: OpendrsConfig, history: HistoryIndex): Promise<BriefFile | { reason: ExclusionReason; detail: string }> {
  const started = Date.now();
  const diff = await loadDiff(repoDir, pr.base, pr.head, config);
  if (diff.files.length !== pr.changedFiles) return { reason: "diff-mismatch", detail: `diff has ${diff.files.length} files, GitHub says ${pr.changedFiles}` };
  const baseTime = Number(await git(repoDir, ["show", "-s", "--format=%ct", diff.base]));
  const result = await scoreDiff({ repoDir, base: pr.base, head: pr.head, config, llm: null, brief: {}, history, baseHistory: history, asOf: baseTime + 1 });
  const captain = result.brief?.captain;
  if (!captain) return { reason: "brief-failed", detail: "scoreDiff returned no captain brief" };
  return {
    priority: captain.priority,
    facts: captain.facts,
    notes: captain.notes,
    score: result.score,
    tier: result.tier,
    files: diff.files.map((f) => ({ path: f.path, ignored: f.ignored, addedLines: addedLines(f.hunks) })),
    ms: Date.now() - started,
  };
}

async function buildRepo(repo: (typeof REPOS)[number], o: Options): Promise<RepoBuild> {
  const selection = await readJson<Selection>(selectionFile(repo.slug));
  if (!selection) throw new Error(`${repo.slug}: run fetch first (no ${selectionFile(repo.slug)})`);
  const repoDir = await ensureClone(repo, selection.head);
  const config = repoConfig(repo);
  const corpusRepo: CorpusRepo = { slug: repo.slug, repo: repo.repo, language: repo.language, defaultBranch: selection.defaultBranch, head: selection.head, headTime: selection.headTime, cloneMode: "full", ...(repo.config && { config: repo.config }) };
  const firstParent = new Set((await git(repoDir, ["rev-list", "--first-parent", selection.head], { timeoutMs: 600_000 })).split("\n"));
  const history = await historyOf(repo.slug, repoDir, selection.head, config);

  const prs: CorpusPr[] = [];
  const excluded: CorpusFile["excluded"] = selection.excluded.map((e) => ({ slug: repo.slug, ...e }));
  const numbers = selection.selected.slice(0, o.limit);
  await pool(numbers, o.prConcurrency, async (n) => {
    const detail = await prDetail(repo.repo, n);
    const resolved = await resolvePr(repoDir, repo, detail, firstParent);
    if ("reason" in resolved) {
      excluded.push({ slug: repo.slug, number: n, ...resolved });
      return;
    }
    const file = briefFile(repo.slug, n);
    let brief = o.freshBriefs ? undefined : await readJson<BriefFile>(file);
    if (!brief) {
      let out: Awaited<ReturnType<typeof briefPr>>;
      try {
        out = await briefPr(repoDir, repo, resolved, config, history);
      } catch (e) {
        out = { reason: "brief-failed", detail: errorMessage(e).split("\n")[0]! };
      }
      if ("reason" in out) {
        excluded.push({ slug: repo.slug, number: n, ...out });
        log(`${repo.slug}#${n}: excluded (${out.reason}: ${out.detail})`);
        return;
      }
      await writeJson(file, out);
      brief = out;
      log(`${repo.slug}#${n}: ${brief.priority}, ${brief.facts.length} facts, ${(brief.ms / 1000).toFixed(1)} s`);
    }
    prs.push(resolved);
  });
  prs.sort((a, b) => a.number - b.number);
  const build: RepoBuild = { repo: corpusRepo, prs, excluded };
  await writeJson(buildFile(repo.slug), build);

  const unreconstructible = excluded.filter((e) => e.reason === "not-first-parent" || e.reason === "diff-mismatch").length;
  if (numbers.length > 0 && unreconstructible / numbers.length > 0.2) {
    throw new Error(`${repo.slug}: ${unreconstructible} of ${numbers.length} selected PRs are not reconstructible (> 20 %, spec §3 stop rule). See ${buildFile(repo.slug)} before reading any result.`);
  }
  return build;
}

/** corpus.json from every repo whose build file exists (a `--repos` subset leaves the others as they were). */
async function writeCorpus(): Promise<CorpusFile> {
  const corpus: CorpusFile = { builtAt: new Date().toISOString(), windowDays: WINDOW_DAYS, lookbackDays: LOOKBACK_DAYS, perRepo: PER_REPO, repos: [], prs: [], excluded: [] };
  for (const repo of REPOS) {
    const build = await readJson<RepoBuild>(buildFile(repo.slug));
    if (!build) continue;
    corpus.repos.push(build.repo);
    corpus.prs.push(...build.prs);
    corpus.excluded.push(...build.excluded);
  }
  await writeJson(join(HERE, "corpus.json"), corpus);
  return corpus;
}

// ---------------------------------------------------------------------------------------------
// label

interface PrLabels {
  comments: CommentLoc[];
  changesRequested: boolean;
  reverted: boolean;
  hits: BlameHit[];
  fixTouched: string[];
  /** Shas of the fix commits in the window that touched a PR file (blamed, whether or not they hit). */
  fixCommits: string[];
}

interface LabelsFile {
  windowDays: number;
  lineWindow: number;
  prs: Record<string, PrLabels>;
}

const prKey = (pr: { slug: string; number: number }): string => `${pr.slug}#${pr.number}`;

async function labelRepo(repo: (typeof REPOS)[number], build: RepoBuild, o: Options): Promise<Record<string, PrLabels>> {
  const repoDir = await ensureClone(repo, build.repo.head);
  const config = repoConfig(repo);
  const history = await historyOf(repo.slug, repoDir, build.repo.head, config);
  const out: Record<string, PrLabels> = {};
  const candidatesByPr = new Map<number, CommitInfo[]>();
  for (const pr of build.prs.slice(0, o.limit)) {
    const brief = await readJson<BriefFile>(briefFile(repo.slug, pr.number));
    if (!brief) continue;
    candidatesByPr.set(pr.number, fixCandidates(history.commits, sec(pr.mergedAt), WINDOW_DAYS, new Set(brief.files.map((f) => f.path))));
  }
  const shas = [...new Set([...candidatesByPr.values()].flat().map((c) => c.sha))];
  log(`${repo.slug}: blaming ${shas.length} fix commits for ${candidatesByPr.size} PRs`);
  const blamed = new Map<string, BlameHit[]>();
  await pool(shas, BLAME_CONCURRENCY, async (sha) => {
    const file = join(CACHE, "blame", repo.slug, `${sha}.json`);
    let hits = await readJson<BlameHit[]>(file);
    if (!hits) {
      hits = await blameFix(repoDir, sha, config.paths.ignore);
      await writeJson(file, hits);
    }
    blamed.set(sha, hits);
  });
  for (const pr of build.prs.slice(0, o.limit)) {
    const cands = candidatesByPr.get(pr.number);
    if (!cands) continue;
    const detail = await prDetail(repo.repo, pr.number);
    const comments = countedComments(await ghPages<GhComment>(`repos/${repo.repo}/pulls/${pr.number}/comments`), detail.user.login);
    const reviews = await ghPages<GhReview>(`repos/${repo.repo}/pulls/${pr.number}/reviews`);
    out[prKey(pr)] = {
      comments,
      changesRequested: changesRequested(reviews),
      reverted: isRevertOfPr(history.commits, pr),
      hits: hitsOnPr(cands.flatMap((c) => blamed.get(c.sha) ?? []), pr.commits),
      fixTouched: [...new Set(cands.flatMap((c) => c.files))],
      fixCommits: cands.map((c) => c.sha),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// eval

interface ResultsJson {
  builtAt: string;
  corpus: { repos: number; prs: number; excluded: number };
  facts: FactTypeSummary[];
  priority: ReturnType<typeof priorityTable>;
  drift: string[];
  timings: Record<string, number>;
  records: FactRecord[];
  prs: Array<{ key: string; priority: Priority; fixedOrReverted: boolean; changesRequested: boolean; facts: number }>;
}

async function evalCorpus(o: Options): Promise<ResultsJson> {
  const corpus = await readJson<CorpusFile>(join(HERE, "corpus.json"));
  const labels = await readJson<LabelsFile>(join(HERE, "labels.json"));
  if (!corpus || !labels) throw new Error("eval needs bench/outcomes/corpus.json and labels.json: run build and label first");
  const records: FactRecord[] = [];
  const prs: ResultsJson["prs"] = [];
  let scored = 0;
  for (const pr of corpus.prs) {
    if (o.repos && !o.repos.includes(pr.slug)) continue;
    const brief = await readJson<BriefFile>(briefFile(pr.slug, pr.number));
    const l = labels.prs[prKey(pr)];
    if (!brief || !l) continue;
    scored++;
    const ctx = { slug: pr.slug, number: pr.number, files: brief.files, comments: l.comments, hits: l.hits, reverted: l.reverted, fixTouched: new Set(l.fixTouched), lineWindow: labels.lineWindow };
    for (const fact of brief.facts) records.push(labelFact(fact, ctx));
    prs.push({ key: prKey(pr), priority: brief.priority, fixedOrReverted: l.reverted || l.hits.length > 0, changesRequested: l.changesRequested, facts: brief.facts.length });
  }
  const facts = summarise(records);
  const baseline = await readJson<{ facts: FactTypeSummary[] }>(join(HERE, "baseline.json"));
  const timings = (await readJson<Record<string, number>>(join(CACHE, "timings.json"))) ?? {};
  const results: ResultsJson = {
    builtAt: new Date().toISOString(),
    corpus: { repos: corpus.repos.length, prs: scored, excluded: corpus.excluded.length },
    facts,
    priority: priorityTable(prs),
    drift: baseline ? drift(baseline.facts, facts) : [],
    timings,
    records,
    prs,
  };
  await writeJson(join(HERE, "results.json"), results);
  await writeFile(join(HERE, "results.md"), renderResults(results));
  if (o.writeBaseline) await writeJson(join(HERE, "baseline.json"), { builtAt: results.builtAt, facts, priority: results.priority });
  return results;
}

// ---------------------------------------------------------------------------------------------
// main

interface Options {
  step: "fetch" | "build" | "label" | "eval" | "all";
  repos?: string[];
  limit: number;
  repoConcurrency: number;
  prConcurrency: number;
  keepClones: boolean;
  freshBriefs: boolean;
  writeBaseline: boolean;
}

function parseOptions(argv: string[]): Options {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repos: { type: "string" },
      limit: { type: "string", default: String(PER_REPO) },
      "repo-concurrency": { type: "string", default: "3" },
      "pr-concurrency": { type: "string", default: "2" },
      "keep-clones": { type: "boolean", default: false },
      "fresh-briefs": { type: "boolean", default: false },
      "write-baseline": { type: "boolean", default: false },
    },
  });
  const step = positionals[0];
  if (step !== "fetch" && step !== "build" && step !== "label" && step !== "eval" && step !== "all") {
    console.error("usage: node bench/outcomes/run.ts <fetch|build|label|eval|all> [--repos a,b] [--limit N] [--repo-concurrency N] [--pr-concurrency N] [--keep-clones] [--fresh-briefs] [--write-baseline]");
    process.exit(2);
  }
  const int = (name: string, raw: string): number => {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
      console.error(`--${name} must be a positive integer, got "${raw}"`);
      process.exit(2);
    }
    return n;
  };
  const repos = values.repos?.split(",").map((s) => s.trim());
  for (const slug of repos ?? []) {
    if (!REPOS.some((r) => r.slug === slug)) {
      console.error(`unknown repo slug "${slug}"; known: ${REPOS.map((r) => r.slug).join(", ")}`);
      process.exit(2);
    }
  }
  return {
    step,
    repos,
    limit: int("limit", values.limit),
    repoConcurrency: int("repo-concurrency", values["repo-concurrency"]),
    prConcurrency: int("pr-concurrency", values["pr-concurrency"]),
    keepClones: values["keep-clones"],
    freshBriefs: values["fresh-briefs"],
    writeBaseline: values["write-baseline"],
  };
}

async function timed(step: string, fn: () => Promise<void>): Promise<void> {
  const started = Date.now();
  await fn();
  const file = join(CACHE, "timings.json");
  const timings = (await readJson<Record<string, number>>(file)) ?? {};
  timings[step] = Date.now() - started;
  await writeJson(file, timings);
  log(`${step}: ${((Date.now() - started) / 60_000).toFixed(1)} min`);
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const repos = REPOS.filter((r) => !o.repos || o.repos.includes(r.slug));
  await mkdir(CACHE, { recursive: true });
  const run = (s: Options["step"]) => o.step === s || o.step === "all";

  if (run("fetch")) await timed("fetch", () => pool(repos, o.repoConcurrency, async (r) => void (await fetchRepo(r, o.limit))));
  if (run("build")) {
    await timed("build", async () => {
      await pool(repos, o.repoConcurrency, async (r) => void (await buildRepo(r, o)));
      const corpus = await writeCorpus();
      log(`corpus.json: ${corpus.repos.length} repos, ${corpus.prs.length} PRs, ${corpus.excluded.length} excluded`);
    });
  }
  if (run("label")) {
    await timed("label", async () => {
      const file = join(HERE, "labels.json");
      const labels = (await readJson<LabelsFile>(file)) ?? { windowDays: WINDOW_DAYS, lineWindow: LINE_WINDOW, prs: {} };
      await pool(repos, o.repoConcurrency, async (r) => {
        const build = await readJson<RepoBuild>(buildFile(r.slug));
        if (!build) throw new Error(`${r.slug}: run build first (no ${buildFile(r.slug)})`);
        Object.assign(labels.prs, await labelRepo(r, build, o));
      });
      await writeJson(file, labels);
      log(`labels.json: ${Object.keys(labels.prs).length} PRs`);
    });
  }
  if (run("eval")) {
    await timed("eval", async () => {
      const results = await evalCorpus(o);
      console.log(renderResults(results));
    });
  }
  if (!o.keepClones && (run("build") || run("label"))) {
    for (const r of repos) await rm(cloneDir(r.slug), { recursive: true, force: true });
    log("clones deleted (--keep-clones to keep them)");
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(errorMessage(e));
    process.exit(1);
  },
);
