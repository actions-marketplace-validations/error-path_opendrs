/**
 * ApacheJIT benchmark: replay each project's labelled commits with opendrs's signals, fit and
 * evaluate the models, and write the report. Run `npm run build` first; see README.md.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { defaultConfig } from "../../dist/domain/config.js";
import type { Signal } from "../../dist/domain/types.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { fitLogistic } from "../../dist/model/fit.js";
import { scoreSignals, sigmoid } from "../../dist/model/logistic.js";
import { mapLimit, replayHistory, type ReplayRow } from "../../dist/model/replay.js";
import { VERSION } from "../../dist/version.js";
import { DATASET, PROJECTS, evaluateModel, kameiFeatures, parseApacheJit, renderReport } from "./lib.ts";
import type { JitRow, Project, ProjectResult, Split } from "./lib.ts";

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/**
 * The hdfs and mapreduce mirrors stop when those subprojects moved into apache/hadoop (2011), so
 * most of their labelled commits live in the hadoop repository.
 */
const ALSO_IN: Record<string, string> = { "hadoop-hdfs": "hadoop", "hadoop-mapreduce": "hadoop" };
/** Start of the test years: rows before it give each project's real training-period positive rate. */
const TEST_FROM = Date.UTC(2017, 0, 1) / 1000;

interface Options {
  workDir: string;
  projects: Project[];
  maxPerProject?: number;
  concurrency: number;
  out: string;
  /** Hash of the built dist/: cached rows are only reused by the code that produced them. */
  build: string;
}

/** Labelled CSV rows of one project (or several, pooled) and the rows replayed for them. */
interface Group {
  train: JitRow[];
  test: JitRow[];
  rows: ReplayRow[];
  /** All dataset rows of the same projects from before the test years, at their real positive rate. */
  pre: JitRow[];
}

type CachedRow = Omit<ReplayRow, "signals"> & { signals: Pick<Signal, "id" | "value" | "status">[] };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: 1 << 30 });
  return stdout.trim();
}

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

async function buildHash(): Promise<string> {
  const dist = join(REPO_ROOT, "dist");
  const files = (await readdir(dist, { recursive: true })).filter((f) => f.endsWith(".js")).sort();
  const hash = createHash("sha256");
  for (const f of files) hash.update(f).update(await readFile(join(dist, f)));
  return hash.digest("hex").slice(0, 12);
}

function parseOptions(args: string[], build: string): Options {
  const { values } = parseArgs({
    args,
    options: {
      "work-dir": { type: "string", default: join(homedir(), ".cache/opendrs/apachejit") },
      projects: { type: "string" },
      "max-per-project": { type: "string" },
      concurrency: { type: "string", default: "2" },
      out: { type: "string", default: fileURLToPath(new URL("results.md", import.meta.url)) },
    },
  });
  const positiveInt = (flag: string, value: string) => {
    const n = Number(value);
    return Number.isInteger(n) && n > 0 ? n : usageError(`--${flag} must be a positive integer, got "${value}"`);
  };
  const valid = PROJECTS.map((p) => p.name);
  const names = values.projects?.split(",").map((s) => s.trim()) ?? valid;
  const unknown = names.filter((n) => !valid.includes(n));
  if (unknown.length > 0) usageError(`Unknown project(s): ${unknown.join(", ")}. Valid: ${valid.join(", ")}`);
  return {
    workDir: values["work-dir"],
    projects: PROJECTS.filter((p) => names.includes(p.name)),
    maxPerProject: values["max-per-project"] === undefined ? undefined : positiveInt("max-per-project", values["max-per-project"]),
    concurrency: positiveInt("concurrency", values.concurrency),
    out: values.out,
    build,
  };
}

/** Download the CSVs that are absent, verify every sha256, and parse them. */
async function ensureDataset(workDir: string): Promise<{ jit: Record<Split, JitRow[]>; hashes: Record<string, string> }> {
  const dir = join(workDir, "data");
  await mkdir(dir, { recursive: true });
  const jit = {} as Record<Split, JitRow[]>;
  const hashes: Record<string, string> = {};
  for (const { split, file, url, sha256 } of DATASET) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      console.error(`downloading ${file}`);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${file}: download failed with HTTP ${res.status}`);
      await writeFile(`${path}.part`, Buffer.from(await res.arrayBuffer()));
      await rename(`${path}.part`, path);
    }
    const bytes = await readFile(path);
    const got = createHash("sha256").update(bytes).digest("hex");
    if (got !== sha256) throw new Error(`${file}: sha256 ${got}, expected ${sha256}`);
    jit[split] = parseApacheJit(bytes.toString("utf8"));
    hashes[file] = got;
  }
  return { jit, hashes };
}

/** Full clone into <work-dir>/repos/<name> unless that directory exists; returns the replay head or why the project is skipped. */
function ensureClone(workDir: string, project: Project): Promise<{ repoDir: string; head: string } | { skipped: string }> {
  // apache/hadoop is also needed by hadoop-hdfs and hadoop-mapreduce: share one clone, never race two.
  let clone = clones.get(project.name);
  if (!clone) clones.set(project.name, (clone = cloneOnce(workDir, project)));
  return clone;
}
const clones = new Map<string, ReturnType<typeof cloneOnce>>();

async function cloneOnce(workDir: string, project: Project): Promise<{ repoDir: string; head: string } | { skipped: string }> {
  const repoDir = join(workDir, "repos", project.name);
  if (!existsSync(repoDir)) {
    // Clone beside the target and rename, so an interrupted clone is never taken for a complete one.
    const partial = `${repoDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(repoDir), { recursive: true });
    console.error(`${project.name}: cloning ${project.url}`);
    try {
      await git(workDir, ["clone", "-q", "--no-checkout", project.url, partial]);
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

/** A project's rows of one split, keeping only the newest `max` when set. */
function projectRows(rows: JitRow[], project: string, max: number | undefined): JitRow[] {
  const mine = rows.filter((r) => r.project === project);
  return max === undefined ? mine : mine.sort((a, b) => b.time - a.time).slice(0, max);
}

/** Identifies a replay: the same head and the same labelled shas give the same rows. */
function cacheKey(head: string, labels: Map<string, 0 | 1>): string {
  const entries = [...labels].map(([sha, label]) => `${sha}:${label}`).sort();
  return createHash("sha256").update([head, ...entries].join("\n")).digest("hex");
}

/**
 * The rows and warnings of an earlier replay with the same key, or undefined. Line 1 holds the key,
 * the row count and the warnings; a file that fails to parse or is short of rows is deleted.
 */
async function readCache(path: string, key: string): Promise<{ rows: ReplayRow[]; warnings: string[] } | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const [first, ...lines] = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    const meta = JSON.parse(first ?? "") as { key: string; rows: number; warnings: string[] };
    if (meta.key !== key) return undefined;
    if (meta.rows !== lines.length) throw new Error("truncated");
    const rows = lines.map((line): ReplayRow => {
      const row = JSON.parse(line) as CachedRow;
      return { ...row, signals: row.signals.map((s) => ({ ...s, summary: "", evidence: [] })) };
    });
    return { rows, warnings: meta.warnings };
  } catch {
    await rm(path, { force: true });
    return undefined;
  }
}

async function writeCache(path: string, key: string, rows: ReplayRow[], warnings: string[]): Promise<void> {
  const lines = [
    JSON.stringify({ key, rows: rows.length, warnings }),
    ...rows.map(({ signals, ...row }) => JSON.stringify({ ...row, signals: signals.map(({ id, value, status }) => ({ id, value, status })) })),
  ];
  await mkdir(dirname(path), { recursive: true });
  // Write then rename: a killed run leaves no half-written cache behind.
  await writeFile(`${path}.tmp`, `${lines.join("\n")}\n`);
  await rename(`${path}.tmp`, path);
}

/** Replayed rows for the labels: from the row cache when it matches, else a fresh replay that refills it. */
async function replayRows(o: Options, cacheName: string, repoDir: string, head: string, labels: Map<string, 0 | 1>) {
  // A capped run gets its own file so a smoke run never overwrites the full run's cache.
  const cap = o.maxPerProject === undefined ? "" : `.max${o.maxPerProject}`;
  const path = join(o.workDir, "rows", `${cacheName}.${VERSION}-${o.build}${cap}.jsonl`);
  const key = cacheKey(head, labels);
  const cached = await readCache(path, key);
  if (cached) {
    console.error(`${cacheName}: ${cached.rows.length} rows from cache`);
    return cached;
  }
  const config = defaultConfig();
  config.history.maxCommits = 1_000_000;
  const onProgress = (done: number, total: number) => {
    if (done % 250 === 0 || done === total) console.error(`${cacheName}: ${done}/${total}`);
  };
  const { rows, warnings } = await replayHistory({ repoDir, config, head, labels, onProgress });
  await writeCache(path, key, rows, warnings);
  return { rows, warnings };
}

/**
 * Weight per training negative that brings the training rows to the real pre-2017 positive rate,
 * so the F1 threshold is chosen as if on unresampled data. 1 when either rate is undefined.
 */
function negativeWeight(trainLabels: number[], pre: JitRow[]): number {
  const odds = (labels: number[]) => {
    const pos = labels.filter((y) => y === 1).length;
    return pos === 0 || pos === labels.length ? undefined : (labels.length - pos) / pos;
  };
  const real = odds(pre.map((r) => r.buggy));
  const train = odds(trainLabels);
  return real === undefined || train === undefined ? 1 : real / train;
}

function coverage(g: Group): ProjectResult["coverage"] {
  const replayed = new Set(g.rows.map((r) => r.sha));
  const of = (split: JitRow[]) => ({ labelled: split.length, replayed: split.filter((r) => replayed.has(r.sha)).length });
  return { train: of(g.train), test: of(g.test) };
}

/** opendrs default and calibrated on the replayed rows; Kamei LR on all CSV rows and on the replayed ones. */
function evaluateGroup(g: Group, repo: string): Pick<ProjectResult, "models" | "calibration" | "warnings"> {
  const warnings: string[] = [];
  const models: ProjectResult["models"] = {};
  const replayedIn = (split: JitRow[]) => {
    const shas = new Set(split.map((r) => r.sha));
    return g.rows.filter((r) => shas.has(r.sha));
  };
  const train = replayedIn(g.train);
  const test = replayedIn(g.test);
  const opendrs = (score: (r: ReplayRow) => number) => {
    const scored = (rows: ReplayRow[]) => ({ scores: rows.map(score), labels: rows.map((r) => r.label) });
    return evaluateModel(scored(train), scored(test), negativeWeight(train.map((r) => r.label), g.pre));
  };

  models.default = opendrs((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score);
  let calibration: ProjectResult["calibration"];
  try {
    const model = fitModel(train, DEFAULT_WEIGHTS, repo);
    calibration = model.calibration?.chosen ?? "fitted";
    models.calibrated = opendrs((r) => scoreSignals(r.signals, model).score);
  } catch (e) {
    models.calibrated = null;
    warnings.push(`calibrated model not fitted: ${errorMessage(e)}`);
  }

  const fit = fitLogistic(g.train.map(kameiFeatures), g.train.map((r) => r.buggy), { l2: 0.01 });
  const kamei = (rows: JitRow[]) => ({
    scores: rows.map((r) => sigmoid(kameiFeatures(r).reduce((z, x, j) => z + fit.weights[j]! * x, fit.intercept))),
    labels: rows.map((r) => r.buggy),
  });
  const replayed = new Set(g.rows.map((r) => r.sha));
  const wasReplayed = (r: JitRow) => replayed.has(r.sha);
  const evaluateKamei = (trainRows: JitRow[], testRows: JitRow[]) =>
    evaluateModel(kamei(trainRows), kamei(testRows), negativeWeight(trainRows.map((r) => r.buggy), g.pre));
  models.kamei = evaluateKamei(g.train, g.test);
  models.kameiReplayed = evaluateKamei(g.train.filter(wasReplayed), g.test.filter(wasReplayed));
  return { models, calibration, warnings };
}

/** Clone, replay and evaluate one project; `group` is absent when the project was skipped. */
async function runProject(o: Options, jit: Record<Split, JitRow[]>, project: Project): Promise<{ result: ProjectResult; group?: Group }> {
  const train = projectRows(jit.train, project.project, o.maxPerProject);
  const test = projectRows(jit.test_large, project.project, o.maxPerProject);
  const pre = jit.total.filter((r) => r.project === project.project && r.time < TEST_FROM);
  const clone = await ensureClone(o.workDir, project);
  if ("skipped" in clone) {
    console.error(`${project.name}: skipped, ${clone.skipped}`);
    return { result: { project: project.project, coverage: coverage({ train, test, rows: [], pre }), models: {}, skipped: clone.skipped, warnings: [] } };
  }
  const labels = new Map<string, 0 | 1>([...train, ...test].map((r) => [r.sha, r.buggy]));
  const { rows, warnings } = await replayRows(o, project.name, clone.repoDir, clone.head, labels);
  const fallback = PROJECTS.find((p) => p.name === ALSO_IN[project.name]);
  if (fallback) {
    warnings.forEach((w, i) => w.includes("not found") && (warnings[i] = `${w} (looked up in ${fallback.project} next)`));
    const replayed = new Set(rows.map((r) => r.sha));
    const rest = new Map([...labels].filter(([sha]) => !replayed.has(sha)));
    const other = await ensureClone(o.workDir, fallback);
    if ("skipped" in other) warnings.push(`${fallback.name}: ${other.skipped}`);
    else {
      const more = await replayRows(o, `${project.name}-in-${fallback.name}`, other.repoDir, other.head, rest);
      rows.push(...more.rows);
      warnings.push(`${more.rows.length} rows replayed in ${fallback.project} at ${other.head.slice(0, 12)}`);
      warnings.push(...more.warnings.map((w) => `in ${fallback.project}: ${w}`));
    }
  }
  const group = { train, test, rows, pre };
  const evaluated = evaluateGroup(group, project.name);
  const result = { project: project.project, head: clone.head, coverage: coverage(group), ...evaluated };
  return { result: { ...result, warnings: [...warnings, ...evaluated.warnings] }, group };
}

function pooledResult(name: string, groups: Group[]): ProjectResult {
  const g = {
    train: groups.flatMap((x) => x.train),
    test: groups.flatMap((x) => x.test),
    rows: groups.flatMap((x) => x.rows),
    pre: groups.flatMap((x) => x.pre),
  };
  return { project: name, coverage: coverage(g), ...evaluateGroup(g, name) };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2), await buildHash());
  const { jit, hashes } = await ensureDataset(o.workDir);
  const done = await mapLimit(o.projects, o.concurrency, (p) => runProject(o, jit, p));
  const ran = done.flatMap((d) => (d.group ? [{ project: d.result.project, group: d.group }] : []));
  const pools: [string, Group[]][] = [
    ["pooled", ran.map((r) => r.group)],
    ["pooled (excluding apache/hadoop)", ran.filter((r) => r.project !== "apache/hadoop").map((r) => r.group)],
  ];
  const report = renderReport({
    meta: { version: `${VERSION} (build ${o.build})`, commit: await git(REPO_ROOT, ["rev-parse", "--short", "HEAD"]), date: new Date().toISOString().slice(0, 10), hashes },
    pooled: pools.filter(([, groups]) => groups.length > 0).map(([name, groups]) => pooledResult(name, groups)),
    projects: done.map((d) => d.result),
  });
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, report);
  process.stdout.write(report.slice(report.indexOf("## Pooled"), report.indexOf("## Per project")));
  return done.some((d) => d.result.skipped) ? 1 : 0;
}

process.exitCode = await main();
