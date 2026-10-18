import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpendrsConfig } from "./domain/config.js";
import type { DependencyGraph, DiffInfo, HistoryIndex, LlmProvider, ModelWeights, ScoreResult, ScoringContext, Signal } from "./domain/types.js";
import { OpendrsError } from "./domain/types.js";
import { buildBrief } from "./brief/build.js";
import { createBlobReader } from "./git/blobs.js";
import { git } from "./git/exec.js";
import { EMPTY_TREE, loadDiff } from "./git/diff.js";
import { buildHistoryIndex } from "./git/history.js";
import { buildDependencyGraph } from "./graph/graph.js";
import { buildDiffText } from "./llm/prompt.js";
import { createLlmProvider } from "./llm/provider.js";
import { DEFAULT_WEIGHTS } from "./model/defaults.js";
import { scoreSignals } from "./model/logistic.js";
import { decide, type GateInput } from "./policy/gate.js";
import { agentPatterns, classifyPr } from "./policy/source.js";
import { SIGNAL_PROVIDERS } from "./signals/index.js";
import { VERSION } from "./version.js";

export interface ScoreOptions {
  repoDir: string;
  base: string;
  head: string;
  config: OpendrsConfig;
  /** Override the model; otherwise config.model is loaded when present, else DEFAULT_WEIGHTS. */
  model?: ModelWeights;
  /** Reuse across many scorings (calibrate/backtest). */
  history?: HistoryIndex;
  /**
   * History at the base branch's tip, which per-source dailyCap/trackRecord count landed commits
   * from; `history` is cut at the merge-base. Built when needed if absent.
   */
  baseHistory?: HistoryIndex;
  graph?: DependencyGraph | null;
  llm?: LlmProvider | null;
  asOf?: number;
  pr?: GateInput["pr"];
  /** False when CI could not tie the head commit's author to the PR account. Default true. */
  authorVerified?: boolean;
  /** The GitHub account that opened the PR (CI only); its `type` is "Bot" for a GitHub App. */
  account?: { login: string; type?: string };
  title?: string;
  description?: string;
  /** Epoch ms for freeze windows. Default: Date.now(). */
  now?: number;
  /** Build a review brief (ScoreResult.brief). maxTokens defaults to config.brief.maxTokens. */
  brief?: { maxTokens?: number; now?: number; llm?: boolean };
}

/** Load the calibrated model if config.model exists in the repo; else the default priors. */
export async function loadModel(repoDir: string, config: OpendrsConfig): Promise<{ model: ModelWeights; kind: "default" | "calibrated" }> {
  try {
    const parsed = JSON.parse(await readFile(join(repoDir, config.model), "utf8")) as ModelWeights;
    if (parsed.version === 1 && typeof parsed.intercept === "number") return { model: parsed, kind: "calibrated" };
  } catch {
    // missing or unreadable model file: fall back to priors
  }
  return { model: DEFAULT_WEIGHTS, kind: "default" };
}

const FIELD = "\x1f";
const SHA = /^([0-9a-f]{40}|[0-9a-f]{64})$/;

/** The PR's own commits, newest first, without merges: what `classifyPr` reads and the gate excludes from "landed". */
async function prCommits(repoDir: string, base: string, head: string, maxCommits: number) {
  const range = base === EMPTY_TREE ? head : `${base}..${head}`;
  // Records start with NUL, which a commit message cannot contain, so a message cannot forge a record.
  const out = await git(repoDir, ["log", `-n${maxCommits}`, "--no-merges", "--no-show-signature", `--format=%x00%H${FIELD}%an${FIELD}%ae${FIELD}%B`, "--end-of-options", range]);
  return out.split("\0").flatMap((record) => {
    const [sha = "", authorName = "", authorEmail = "", ...message] = record.trim().split(FIELD);
    return SHA.test(sha) ? [{ sha, authorName, authorEmail, message: message.join(FIELD) }] : [];
  });
}

/** Compute every signal for a diff. Exported for calibrate/backtest, which fit weights on these. */
export async function computeSignals(ctx: ScoringContext): Promise<Signal[]> {
  const batches = await Promise.all(SIGNAL_PROVIDERS.map((p) => p(ctx)));
  return batches.flat();
}

export function makeContext(
  repoDir: string,
  diff: DiffInfo,
  config: OpendrsConfig,
  history: HistoryIndex,
  graph: DependencyGraph | undefined,
  asOf?: number,
  trust: ScoringContext["trust"] = { authorVerified: true, historyComplete: true },
): ScoringContext {
  const read = createBlobReader(repoDir);
  return {
    repoDir,
    diff,
    config,
    history,
    graph,
    asOf,
    trust,
    readBase: (path) => read(diff.base, path),
    readHead: (path) => read(diff.head, path),
  };
}

export async function scoreDiff(opts: ScoreOptions): Promise<ScoreResult> {
  const { repoDir, config } = opts;
  const diff = await loadDiff(repoDir, opts.base, opts.head, config);
  if (opts.title !== undefined) diff.title = opts.title;
  if (opts.description !== undefined) diff.description = opts.description;

  const [history, graph] = await Promise.all([
    opts.history ?? buildHistoryIndex(repoDir, diff.base, config),
    opts.graph !== undefined
      ? Promise.resolve(opts.graph ?? undefined)
      : config.graph.enabled
        ? buildDependencyGraph(repoDir, diff.base, config).catch(() => undefined)
        : Promise.resolve(undefined),
  ]);

  const shallow = (await git(repoDir, ["rev-parse", "--is-shallow-repository"])).trim() === "true";
  const ctx = makeContext(repoDir, diff, config, history, graph, opts.asOf, {
    authorVerified: opts.authorVerified ?? true,
    historyComplete: !shallow,
  });

  try {
    // A misconfigured judge (e.g. missing key) becomes an unknown signal, which routes to a human.
    const llm = opts.llm === null ? undefined : (opts.llm ?? createLlmProvider(config));
    if (llm) {
      const { text, hunks, truncated } = buildDiffText(diff, config.llm.maxDiffChars);
      const judgement = await llm.judge({
        title: diff.title,
        description: config.llm.includeDescription ? diff.description : undefined,
        diff: text,
        files: diff.files.filter((f) => !f.ignored).map((f) => f.path),
        hunks,
        truncated,
      });
      ctx.llm = { judgement };
    }
  } catch (e) {
    ctx.llm = { error: e instanceof OpendrsError ? e.message : `LLM judge failed: ${(e as Error).message}` };
  }

  const signals = await computeSignals(ctx);
  const commits = await prCommits(repoDir, diff.base, diff.head, config.history.maxCommits);
  // Landed commits include everything on the base branch, not only what is below the merge-base.
  const countsLanded = Object.values(config.sources).some((s) => s.dailyCap !== undefined || s.trackRecord !== undefined);
  const baseHistory = opts.baseHistory ?? (countsLanded ? await buildHistoryIndex(repoDir, opts.base, config) : history);
  const source = classifyPr(commits, opts.account, agentPatterns(config));
  const { model, kind } = opts.model ? { model: opts.model, kind: "calibrated" as const } : await loadModel(repoDir, config);
  const { score, logit, contributions } = scoreSignals(signals, model);
  const policy = decide({
    score,
    logit,
    signals,
    contributions,
    diff,
    config,
    model,
    history: baseHistory,
    pr: opts.pr,
    llmFailed: Boolean(ctx.llm?.error),
    llm: ctx.llm?.judgement,
    now: opts.now,
    source,
    prCommits: commits.map((c) => c.sha),
  });

  const counted = diff.files.filter((f) => !f.ignored);
  const result: ScoreResult = {
    score,
    tier: policy.tier,
    signals,
    contributions,
    unknowns: signals.filter((s) => s.status === "unknown").map((s) => s.id),
    policy,
    llm: ctx.llm?.judgement,
    source,
    diff: {
      base: diff.base,
      head: diff.head,
      files: counted.length,
      added: counted.reduce((n, f) => n + f.added, 0),
      deleted: counted.reduce((n, f) => n + f.deleted, 0),
    },
    model: kind,
    version: VERSION,
  };
  if (opts.brief) {
    result.brief = await buildBrief(result, ctx, {
      maxTokens: opts.brief.maxTokens ?? config.brief.maxTokens,
      now: opts.brief.now ?? opts.now,
      llm: opts.brief.llm,
    });
  }
  return result;
}
