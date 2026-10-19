import type { BacktestMetrics, ModelWeights, ScoreResult } from "../domain/types.js";
import { buildBrief } from "../brief/build.js";
import { candidateHunks } from "../brief/rank.js";
import { computeSignals, makeContext } from "../engine.js";
import { changedLines, loadDiff } from "../git/diff.js";
import { git } from "../git/exec.js";
import { buildHistoryIndex } from "../git/history.js";
import { decide } from "../policy/gate.js";
import type { HistoryRunOptions } from "./calibrate.js";
import { DEFAULT_WEIGHTS } from "./defaults.js";
import { timeSplit } from "./fit.js";
import { blamedLinesBySha, labelCommits, loadIncidents } from "./label.js";
import { scoreSignals } from "./logistic.js";
import { captureCurve, evaluate } from "./metrics.js";
import { GRAPH_APPROXIMATION_NOTE, replayHistory, windowedCommits, type ReplayRow } from "./replay.js";
import { VERSION } from "../version.js";

export interface BacktestReport {
  default: BacktestMetrics;
  /** Present when a calibrated model was supplied: evaluated only on commits newer than its training window. */
  calibrated?: BacktestMetrics;
  /** The default priors on the same held-out commits as `calibrated`, for a like-for-like comparison. */
  defaultOnHeldOut?: BacktestMetrics;
  /**
   * When no replayed commit is newer than the model's training window: calibrate's own held-out
   * evaluation (`model.metrics`), from its fit on the oldest 80 % scored on the newest 20 %.
   */
  recorded?: BacktestMetrics;
  /** (share gated, share of positives captured) points for the default model, 0..1 in 5 % steps. */
  curve: Array<[number, number]>;
  /** Caveats a reader of the numbers should know. */
  notes: string[];
  /** Report-only (spec §10.2): never gates anything. Populated only when opts.brief is true. */
  focusHitRate?: FocusHitRate;
}

/** Replay history point-in-time and report capture@{5,10,50}% and AUC (spec §5). */
export async function backtest(opts: HistoryRunOptions & { model?: ModelWeights; brief?: boolean }): Promise<BacktestReport> {
  const { rows, warnings } = await replayHistory(opts);
  const report = backtestRows(rows, opts.model);
  if (opts.config.graph.enabled) report.notes.push(GRAPH_APPROXIMATION_NOTE);
  report.notes.push(...warnings);
  if (opts.brief) report.focusHitRate = await focusHitRate(opts);
  return report;
}

export interface FocusHitRate {
  commits: number;
  hits: number;
  hitRate: number;
  changedLineShare: number;
  /** SZZ-labelled commits in the window whose diff or scoring failed, so they are not in `commits`. */
  skipped: number;
}

/**
 * Spec §10.2: free, report-only measurement of the brief's ranking. For every SZZ-lite-labelled
 * buggy commit, did its "Review first" hunks (built asOf that commit, judge off) contain at least
 * one of the lines a later fix blamed on it?
 */
export async function focusHitRate(opts: HistoryRunOptions & { maxTokens?: number }): Promise<FocusHitRate> {
  const { repoDir, config } = opts;
  const head = (await git(repoDir, ["rev-parse", "--verify", `${opts.head ?? "HEAD"}^{commit}`])).trim();
  const history = await buildHistoryIndex(repoDir, head, config);
  const incidents = await loadIncidents(repoDir);
  const labelled = await labelCommits(repoDir, history, config, incidents);
  const szzShas = new Set(labelled.filter((l) => l.label === 1 && l.source === "szz").map((l) => l.sha));
  const bySha = await blamedLinesBySha(repoDir, history, config);

  // Same window replayHistory uses (since/maxCommits), applied before the SZZ filter: a commit
  // outside the window must not be measured just because an older commit inside it is not labelled.
  const commits = (await windowedCommits(repoDir, head, history, config, opts)).filter((c) => szzShas.has(c.sha));
  let evaluated = 0;
  let hits = 0;
  let shareSum = 0;
  let skipped = 0;

  for (const c of commits) {
    const lines = bySha.get(c.sha);
    if (!lines || lines.length === 0) continue;
    try {
      const diff = await loadDiff(repoDir, c.parents[0]!, c.sha, config, { resolved: true });
      const ctx = makeContext(repoDir, diff, config, history, undefined, c.time);
      const signals = await computeSignals(ctx);
      const { score, logit, contributions } = scoreSignals(signals, DEFAULT_WEIGHTS);
      const policy = decide({ score, logit, signals, contributions, diff, config, model: DEFAULT_WEIGHTS, history, llmFailed: false, now: c.time * 1000 });
      const result: ScoreResult = {
        score, tier: policy.tier, signals, contributions, unknowns: [], policy,
        source: { kind: "human", name: "human", evidence: [], verified: false },
        diff: { base: diff.base, head: diff.head, files: diff.files.length, added: 0, deleted: 0 },
        model: "default", version: VERSION,
      };
      const brief = await buildBrief(result, ctx, { maxTokens: opts.maxTokens ?? 2_500, llm: false });
      evaluated++;

      const inFocus = (path: string, line: number) =>
        brief.reviewFirst.some((f) => f.file === path && f.hunks.some((h) => line >= h.newStart && line < h.newStart + h.newLines));
      if (lines.some((l) => inFocus(l.path, l.line))) hits++;

      const totalChanged = diff.files.filter((f) => !f.ignored).reduce((n, f) => n + f.added + f.deleted, 0);
      // Changed (+/-) lines of the focus hunks, looked up by id: a hunk's newLines counts its context too.
      const byId = new Map(candidateHunks(ctx).map((c) => [c.id, c.hunk]));
      const focusChanged = brief.reviewFirst.reduce((n, f) => n + f.hunks.reduce((m, h) => m + [...changedLines(byId.get(h.id)!)].length, 0), 0);
      if (totalChanged > 0) shareSum += focusChanged / totalChanged;
    } catch {
      // one unreadable commit must not abort the whole measurement, but it must not vanish either
      skipped++;
    }
  }
  return { commits: evaluated, hits, hitRate: evaluated > 0 ? hits / evaluated : 0, changedLineShare: evaluated > 0 ? shareSum / evaluated : 0, skipped };
}

/**
 * Default priors on every commit. A calibrated model only on the commits after its training window
 * (`trainedOn.to`; the newest 20 % when the model does not record one), with the default priors
 * evaluated on those same commits.
 */
export function backtestRows(rows: ReplayRow[], model?: ModelWeights): BacktestReport {
  const labels = rows.map((r) => r.label);
  const scores = rows.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score);
  const report: BacktestReport = {
    default: evaluate(scores, labels),
    curve: captureCurve(scores, labels),
    notes: ["Labels of the newest commits are incomplete: recent regressions may not be reverted or fixed yet."],
  };
  if (model) {
    const trainedTo = model.trainedOn ? Date.parse(model.trainedOn.to) / 1000 : undefined;
    const heldOut = trainedTo === undefined ? timeSplit(rows).test : rows.filter((r) => r.time > trainedTo);
    if (heldOut.length === 0 && model.metrics) {
      report.recorded = model.metrics;
      report.notes.push(
        `No replayed commit is newer than the calibrated model's training window (up to ${model.trainedOn?.to}), ` +
          "so the calibrated row shows calibrate's own held-out evaluation: a fit on the oldest 80 % of that window, scored on the newest 20 %, before the refit on every commit.",
      );
    } else if (heldOut.length === 0) {
      report.notes.push(
        `No replayed commit is newer than the calibrated model's training window (up to ${model.trainedOn?.to}), so it has no held-out metrics.`,
      );
    } else {
      const heldOutLabels = heldOut.map((r) => r.label);
      report.calibrated = evaluate(heldOut.map((r) => scoreSignals(r.signals, model).score), heldOutLabels);
      report.defaultOnHeldOut = evaluate(heldOut.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score), heldOutLabels);
    }
  }
  return report;
}
