/**
 * ApacheJIT benchmark: replay each project's labelled commits with opendrs's signals, fit and
 * evaluate the models, and write the report. Run `npm run build` first; see README.md.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
/** The dataset ends in 2019: each project is replayed from its last commit before this date. */
const HEAD_BEFORE = "2020-01-01";

interface Options {
  workDir: string;
  projects: Project[];
  maxPerProject?: number;
  concurrency: number;
  out: string;
}

/** Labelled CSV rows of one project (or several, pooled) and the rows replayed for them. */
interface Group {
  train: JitRow[];
  test: JitRow[];
  rows: ReplayRow[];
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

function parseOptions(args: string[]): Options {
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
async function ensureClone(workDir: string, project: Project): Promise<{ repoDir: string; head: string } | { skipped: string }> {
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
  const head = await git(repoDir, ["rev-list", "-1", `--before=${HEAD_BEFORE}`, "HEAD"]);
  return head ? { repoDir, head } : { skipped: `no commit before ${HEAD_BEFORE} on the default branch` };
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
async function replayRows(o: Options, project: Project, repoDir: string, head: string, labels: Map<string, 0 | 1>) {
  // A capped run gets its own file so a smoke run never overwrites the full run's cache.
  const cap = o.maxPerProject === undefined ? "" : `.max${o.maxPerProject}`;
  const path = join(o.workDir, "rows", `${project.name}.${VERSION}${cap}.jsonl`);
  const key = cacheKey(head, labels);
  const cached = await readCache(path, key);
  if (cached) {
    console.error(`${project.name}: ${cached.rows.length} rows from cache`);
    return cached;
  }
  const config = defaultConfig();
  config.history.maxCommits = 1_000_000;
  const onProgress = (done: number, total: number) => {
    if (done % 250 === 0 || done === total) console.error(`${project.name}: ${done}/${total}`);
  };
  const { rows, warnings } = await replayHistory({ repoDir, config, head, labels, onProgress });
  await writeCache(path, key, rows, warnings);
  return { rows, warnings };
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
    return evaluateModel(scored(train), scored(test));
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
  models.kamei = evaluateModel(kamei(g.train), kamei(g.test));
  models.kameiReplayed = evaluateModel(kamei(g.train.filter(wasReplayed)), kamei(g.test.filter(wasReplayed)));
  return { models, calibration, warnings };
}

/** Clone, replay and evaluate one project; `group` is absent when the project was skipped. */
async function runProject(o: Options, jit: Record<Split, JitRow[]>, project: Project): Promise<{ result: ProjectResult; group?: Group }> {
  const train = projectRows(jit.train, project.project, o.maxPerProject);
  const test = projectRows(jit.test_large, project.project, o.maxPerProject);
  const clone = await ensureClone(o.workDir, project);
  if ("skipped" in clone) {
    console.error(`${project.name}: skipped, ${clone.skipped}`);
    return { result: { project: project.project, coverage: coverage({ train, test, rows: [] }), models: {}, skipped: clone.skipped, warnings: [] } };
  }
  const labels = new Map<string, 0 | 1>([...train, ...test].map((r) => [r.sha, r.buggy]));
  const { rows, warnings } = await replayRows(o, project, clone.repoDir, clone.head, labels);
  const group = { train, test, rows };
  const evaluated = evaluateGroup(group, project.name);
  const result = { project: project.project, head: clone.head, coverage: coverage(group), ...evaluated };
  return { result: { ...result, warnings: [...warnings, ...evaluated.warnings] }, group };
}

function pooledResult(name: string, groups: Group[]): ProjectResult {
  const g = { train: groups.flatMap((x) => x.train), test: groups.flatMap((x) => x.test), rows: groups.flatMap((x) => x.rows) };
  return { project: name, coverage: coverage(g), ...evaluateGroup(g, name) };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const { jit, hashes } = await ensureDataset(o.workDir);
  const done = await mapLimit(o.projects, o.concurrency, (p) => runProject(o, jit, p));
  const ran = done.flatMap((d) => (d.group ? [{ project: d.result.project, group: d.group }] : []));
  const pools: [string, Group[]][] = [
    ["pooled", ran.map((r) => r.group)],
    ["pooled (excluding apache/hadoop)", ran.filter((r) => r.project !== "apache/hadoop").map((r) => r.group)],
  ];
  const report = renderReport({
    meta: { version: VERSION, commit: await git(REPO_ROOT, ["rev-parse", "--short", "HEAD"]), date: new Date().toISOString().slice(0, 10), hashes },
    pooled: pools.filter(([, groups]) => groups.length > 0).map(([name, groups]) => pooledResult(name, groups)),
    projects: done.map((d) => d.result),
  });
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, report);
  process.stdout.write(report.slice(report.indexOf("## Pooled"), report.indexOf("## Per project")));
  return done.some((d) => d.result.skipped) ? 1 : 0;
}

process.exitCode = await main();
