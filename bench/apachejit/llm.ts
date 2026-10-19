/**
 * ApacheJIT LLM benchmark: judge a seeded sample of the replayed commits with the structured LLM
 * judge, then evaluate the models with and without the llm.* signals, and the requireSafe gate.
 * Needs the row cache and clones of a full run.ts run, a build, and ANTHROPIC_API_KEY; see README.md.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultConfig, type OpendrsConfig } from "../../dist/domain/config.js";
import { LLM_RISK_CATEGORIES, OpendrsError } from "../../dist/domain/types.js";
import type { LlmJudgeInput, LlmJudgement, LlmProvider, ScoringContext, Signal } from "../../dist/domain/types.js";
import { loadDiff } from "../../dist/git/diff.js";
import { buildDiffText, buildMessages } from "../../dist/llm/prompt.js";
import { createLlmProvider } from "../../dist/llm/provider.js";
import { JUDGEMENT_SCHEMA } from "../../dist/llm/schema.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { fitLogistic, mulberry32 } from "../../dist/model/fit.js";
import { scoreSignals, sigmoid } from "../../dist/model/logistic.js";
import { mapLimit, type ReplayRow } from "../../dist/model/replay.js";
import { llmSignals } from "../../dist/signals/llm.js";
import { VERSION } from "../../dist/version.js";
import { PROJECTS, categoryStats, evaluateModel, gateStats, kameiFeatures, renderLlmReport, sample } from "./lib.ts";
import type { JitRow, JudgedCommit, LlmReport, ModelMetrics, Split } from "./lib.ts";
import { ALSO_IN, TEST_FROM, ensureDataset, git, negativeWeight, readCache } from "./run.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Its rows have no positives, and the full benchmark reports pooled results without it too. */
const EXCLUDED = "hadoop";
const GATE_CONFIDENCES = [8, 6, 9];
/** $ per million input / output tokens, for the spend cap. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-5": [2, 10],
  "claude-opus-5": [5, 25],
  "claude-fable-5-1": [10, 50],
};
/** Rough upper bounds for one judgement: ~3.5 characters per input token, and output with thinking. */
const CHARS_PER_TOKEN = 3.5;
const PROMPT_CHARS = 9_000;
const OUTPUT_TOKENS = 4_000;

interface Options {
  workDir: string;
  model: string;
  train: number;
  test: number;
  concurrency: number;
  out: string;
  /** Stop starting judgements once their estimated cost reaches this many dollars. */
  maxUsd: number;
}

/** A replayed, labelled commit and the clone its diff is read from. */
interface Commit {
  row: ReplayRow;
  jit: JitRow;
  repoDir: string;
}

/** One line of the judgement cache. */
type Judged = { sha: string; judgement: LlmJudgement } | { sha: string; error: string };

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseOptions(args: string[]): Options {
  const { values } = parseArgs({
    args,
    options: {
      "work-dir": { type: "string", default: join(homedir(), ".cache/opendrs/apachejit") },
      model: { type: "string", default: "claude-sonnet-5" },
      train: { type: "string", default: "800" },
      test: { type: "string", default: "800" },
      "max-usd": { type: "string", default: "80" },
      concurrency: { type: "string", default: "16" },
      out: { type: "string", default: fileURLToPath(new URL("results-llm.md", import.meta.url)) },
    },
  });
  const positiveInt = (flag: "train" | "test" | "concurrency") => {
    const n = Number(values[flag]);
    return Number.isInteger(n) && n > 0 ? n : usageError(`--${flag} must be a positive integer, got "${values[flag]}"`);
  };
  if (!PRICES[values.model]) usageError(`--model must be one of ${Object.keys(PRICES).join(", ")} (needed for the spend cap)`);
  const maxUsd = Number(values["max-usd"]);
  if (!(maxUsd > 0)) usageError(`--max-usd must be a positive number, got "${values["max-usd"]}"`);
  return {
    workDir: values["work-dir"],
    model: values.model,
    train: positiveInt("train"),
    test: positiveInt("test"),
    concurrency: positiveInt("concurrency"),
    out: values.out,
    maxUsd,
  };
}

/**
 * The newest full-run row cache written for `cacheName`, whatever build wrote it: the signals it
 * holds do not change with the LLM work, and the llm.* signals are added here.
 */
async function newestRowCache(workDir: string, cacheName: string): Promise<string | undefined> {
  const dir = join(workDir, "rows");
  if (!existsSync(dir)) return undefined;
  const names = (await readdir(dir)).filter((f) => f.startsWith(`${cacheName}.`) && f.endsWith(".jsonl") && !f.includes(".max"));
  const files = await Promise.all(names.map(async (f) => ({ path: join(dir, f), mtime: (await stat(join(dir, f))).mtimeMs })));
  return files.sort((a, b) => b.mtime - a.mtime)[0]?.path;
}

/** The rows of a cache file under its own key (line 1), so no replay head or label set is checked here. */
async function cachedRows(path: string): Promise<ReplayRow[]> {
  const first = (await readFile(path, "utf8")).split("\n", 1)[0] ?? "";
  const { key } = JSON.parse(first) as { key: string };
  return (await readCache(path, key))?.rows ?? [];
}

/** Every replayed commit of the dataset's train and test_large splits, except apache/hadoop's. */
async function loadCommits(o: Options, jit: Record<Split, JitRow[]>): Promise<{ train: Commit[]; test: Commit[]; notes: string[] }> {
  const notes: string[] = [];
  const train: Commit[] = [];
  const test: Commit[] = [];
  const bySha = new Map<string, { jit: JitRow; into: Commit[] }>();
  for (const r of jit.train) bySha.set(r.sha, { jit: r, into: train });
  for (const r of jit.test_large) bySha.set(r.sha, { jit: r, into: test });

  for (const project of PROJECTS.filter((p) => p.name !== EXCLUDED)) {
    const fallback = ALSO_IN[project.name];
    const sources = [[project.name, project.name], ...(fallback ? [[`${project.name}-in-${fallback}`, fallback]] : [])];
    for (const [cacheName, repoName] of sources) {
      const path = await newestRowCache(o.workDir, cacheName!);
      const repoDir = join(o.workDir, "repos", repoName!);
      if (!path) {
        notes.push(`${cacheName}: no row cache under ${join(o.workDir, "rows")}; run run.ts first`);
        continue;
      }
      if (!existsSync(repoDir)) {
        notes.push(`${cacheName}: no clone at ${repoDir}; run run.ts first`);
        continue;
      }
      const rows = await cachedRows(path);
      for (const row of rows) {
        const hit = bySha.get(row.sha);
        if (hit) hit.into.push({ row, jit: hit.jit, repoDir });
      }
      notes.push(`${cacheName}: ${rows.length} rows from ${basename(path)}`);
    }
  }
  return { train, test, notes };
}

/** Estimated dollars still allowed; each judgement reserves its estimate before calling the API. */
interface Budget {
  left: number;
  price: [number, number];
}

const BUDGET_EXHAUSTED = "spend cap reached (--max-usd)";

async function judgeOne(c: Commit, provider: LlmProvider, config: OpendrsConfig, budget: Budget): Promise<Judged> {
  const sha = c.row.sha;
  try {
    const diff = await loadDiff(c.repoDir, `${sha}^`, sha, config, { resolved: true });
    const { text, hunks, truncated } = buildDiffText(diff, config.llm.maxDiffChars);
    const files = diff.files.filter((f) => !f.ignored).map((f) => f.path);
    const cost = (((PROMPT_CHARS + text.length) / CHARS_PER_TOKEN) * budget.price[0] + OUTPUT_TOKENS * budget.price[1]) / 1e6;
    if (cost > budget.left) return { sha, error: BUDGET_EXHAUSTED };
    budget.left -= cost;
    const judgement = await provider.judge({ title: diff.title, diff: text, files, hunks, truncated });
    return { sha, judgement };
  } catch (e) {
    return { sha, error: errorMessage(e) };
  }
}

/**
 * Judgements for every commit, from the cache file where present. A cached error is retried once
 * per run; a retried sha gets a second line, and the last line of a sha wins on the next load.
 */
async function judgeAll(o: Options, commits: Commit[], provider: LlmProvider, config: OpendrsConfig, cachePath: string): Promise<Map<string, Judged>> {
  const cache = new Map<string, Judged>();
  if (existsSync(cachePath)) {
    for (const line of (await readFile(cachePath, "utf8")).split("\n").filter(Boolean)) {
      let entry: Judged;
      try {
        entry = JSON.parse(line) as Judged;
      } catch {
        continue; // a line torn by a killed run; that sha is judged again
      }
      cache.set(entry.sha, entry);
    }
  }
  const todo = commits.filter((c) => {
    const hit = cache.get(c.row.sha);
    return hit === undefined || "error" in hit;
  });
  console.error(`${cache.size} judgements cached, ${todo.length} to judge`);
  await mkdir(dirname(cachePath), { recursive: true });
  // Appends are chained so two judgements never interleave in the file.
  let writes = Promise.resolve();
  const onDone = (done: number) => {
    if (done % 50 === 0 || done === todo.length) console.error(`judged ${done}/${todo.length}`);
  };
  const budget: Budget = { left: o.maxUsd, price: PRICES[o.model]! };
  await mapLimit(
    todo,
    o.concurrency,
    async (c) => {
      const entry = await judgeOne(c, provider, config, budget);
      cache.set(c.row.sha, entry);
      // A skipped judgement is not a failure: leave it out of the cache so a later run judges it.
      if ("error" in entry && entry.error === BUDGET_EXHAUSTED) return;
      writes = writes.then(() => appendFile(cachePath, `${JSON.stringify(entry)}\n`));
    },
    onDone,
  );
  await writes;
  console.error(`estimated spend this run: $${(o.maxUsd - budget.left).toFixed(2)} of $${o.maxUsd}`);
  return cache;
}

/** The row's signals plus the llm.* signals its judgement yields (a failed judge gives the unknown `llm.semantic`). */
async function withLlmSignals(row: ReplayRow, judged: Judged | undefined): Promise<Signal[]> {
  const llm = judged && "judgement" in judged ? { judgement: judged.judgement } : { error: judged?.error ?? "not judged" };
  // llmSignals reads nothing but ctx.llm.
  return [...row.signals, ...(await llmSignals({ llm } as ScoringContext))];
}

function judgedCommit(c: Commit, judged: Judged | undefined): JudgedCommit {
  return { buggy: c.row.label, ...(judged && "judgement" in judged ? { judgement: judged.judgement } : {}) };
}

async function main(): Promise<number> {
  const o = parseOptions(process.argv.slice(2));
  const config = defaultConfig();
  config.llm.enabled = true;
  config.llm.provider = "anthropic";
  config.llm.model = o.model;
  let provider: LlmProvider | undefined;
  try {
    provider = createLlmProvider(config);
  } catch (e) {
    if (e instanceof OpendrsError) usageError(e.message);
    throw e;
  }
  if (!provider) usageError("LLM provider not created");

  // Everything that shapes a judgement besides the commit itself: both prompts, the reply schema and the diff cut.
  const empty: LlmJudgeInput = { diff: "", files: [], hunks: [], truncated: false };
  const { system, user } = buildMessages(empty);
  const promptHash = createHash("sha256")
    .update(system)
    .update(user)
    .update(JSON.stringify(JUDGEMENT_SCHEMA))
    .update(String(config.llm.maxDiffChars))
    .digest("hex")
    .slice(0, 12);
  const cachePath = join(o.workDir, "llm", `${o.model}.${promptHash}.jsonl`);

  const { jit } = await ensureDataset(o.workDir);
  const all = await loadCommits(o, jit);
  const rand = mulberry32(1);
  const train = sample(all.train, o.train, rand);
  const test = sample(all.test, o.test, rand);
  if (train.length === 0 || test.length === 0) usageError(`nothing to sample: ${all.train.length} train and ${all.test.length} test rows loaded`);
  console.error(`sampled ${train.length} of ${all.train.length} train and ${test.length} of ${all.test.length} test rows`);

  const judged = await judgeAll(o, [...train, ...test], provider, config, cachePath);
  // Commits the spend cap left unjudged are dropped from every model, so all rows compare the same commits.
  const unjudged = (c: Commit) => {
    const j = judged.get(c.row.sha);
    return j !== undefined && "error" in j && j.error === BUDGET_EXHAUSTED;
  };
  const capped = [...train, ...test].filter(unjudged).length;
  train.splice(0, train.length, ...train.filter((c) => !unjudged(c)));
  test.splice(0, test.length, ...test.filter((c) => !unjudged(c)));
  const llmRows = (commits: Commit[]) => Promise.all(commits.map(async (c) => ({ ...c.row, signals: await withLlmSignals(c.row, judged.get(c.row.sha)) })));
  const plain = { train: train.map((c) => c.row), test: test.map((c) => c.row) };
  const llm = { train: await llmRows(train), test: await llmRows(test) };

  const pre = jit.total.filter((r) => r.project !== `apache/${EXCLUDED}` && r.time < TEST_FROM);
  const weight = negativeWeight(plain.train.map((r) => r.label), pre);
  const scored = (rows: ReplayRow[], score: (r: ReplayRow) => number) => ({ scores: rows.map(score), labels: rows.map((r) => r.label) });
  const opendrs = (rows: { train: ReplayRow[]; test: ReplayRow[] }, score: (r: ReplayRow) => number) =>
    evaluateModel(scored(rows.train, score), scored(rows.test, score), weight);
  const notes = [...all.notes];
  if (capped > 0) notes.push(`${capped} sampled commits left out: the spend cap (--max-usd ${o.maxUsd}) stopped before judging them`);
  const calibrated = (rows: { train: ReplayRow[]; test: ReplayRow[] }, label: string): ModelMetrics | null => {
    try {
      const model = fitModel(rows.train, DEFAULT_WEIGHTS, "apachejit-sample");
      if (model.calibration?.chosen === "priors") notes.push(`${label}: the fit did not beat the priors on validation, so the priors were kept`);
      return opendrs(rows, (r) => scoreSignals(r.signals, model).score);
    } catch (e) {
      notes.push(`${label}: not fitted: ${errorMessage(e)}`);
      return null;
    }
  };
  const kameiFit = fitLogistic(train.map((c) => kameiFeatures(c.jit)), train.map((c) => c.jit.buggy), { l2: 0.01 });
  const kamei = (commits: Commit[]) => ({
    scores: commits.map((c) => sigmoid(kameiFeatures(c.jit).reduce((z, x, j) => z + kameiFit.weights[j]! * x, kameiFit.intercept))),
    labels: commits.map((c) => c.jit.buggy),
  });
  const models: LlmReport["models"] = [
    { label: "opendrs, default priors", metrics: opendrs(plain, (r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score) },
    { label: "opendrs, default priors + LLM signals", metrics: opendrs(llm, (r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score) },
    { label: "opendrs, calibrated", metrics: calibrated(plain, "opendrs, calibrated") },
    { label: "opendrs, calibrated + LLM signals", metrics: calibrated(llm, "opendrs, calibrated + LLM signals") },
    { label: "Kamei LR (sampled rows)", metrics: evaluateModel(kamei(train), kamei(test), weight) },
  ];

  const testJudged = test.map((c) => judgedCommit(c, judged.get(c.row.sha)));
  const sampleStats = (commits: Commit[]) => ({
    rows: commits.length,
    positives: commits.filter((c) => c.row.label === 1).length,
    judgeFailures: commits.filter((c) => !("judgement" in (judged.get(c.row.sha) ?? {}))).length,
  });
  const report = renderLlmReport({
    meta: {
      version: VERSION,
      commit: await git(REPO_ROOT, ["rev-parse", "--short", "HEAD"]),
      date: new Date().toISOString().slice(0, 10),
      model: o.model,
      promptHash,
      maxDiffChars: config.llm.maxDiffChars,
    },
    sample: { train: sampleStats(train), test: sampleStats(test) },
    models,
    gates: GATE_CONFIDENCES.map((c) => gateStats(testJudged, c)),
    categories: categoryStats(testJudged, LLM_RISK_CATEGORIES),
    notes,
  });
  await mkdir(dirname(o.out), { recursive: true });
  await writeFile(o.out, report);
  process.stdout.write(report.slice(report.indexOf("## Models"), report.indexOf("## Notes")));
  return 0;
}

process.exitCode = await main();
