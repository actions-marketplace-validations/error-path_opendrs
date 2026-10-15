import type { BacktestMetrics, ModelWeights } from "../domain/types.js";
import type { HistoryRunOptions } from "./calibrate.js";
import { DEFAULT_WEIGHTS } from "./defaults.js";
import { timeSplit } from "./fit.js";
import { scoreSignals } from "./logistic.js";
import { captureCurve, evaluate } from "./metrics.js";
import { GRAPH_APPROXIMATION_NOTE, replayHistory, type ReplayRow } from "./replay.js";

export interface BacktestReport {
  default: BacktestMetrics;
  /** Present when a calibrated model was supplied. Evaluated on the newest 20 % only. */
  calibrated?: BacktestMetrics;
  /** (share gated, share of positives captured) points for the default model, 0..1 in 5 % steps. */
  curve: Array<[number, number]>;
  /** Caveats a reader of the numbers should know. */
  notes: string[];
}

/** Replay history point-in-time and report capture@{5,10,50}% and AUC (spec §5). */
export async function backtest(opts: HistoryRunOptions & { model?: ModelWeights }): Promise<BacktestReport> {
  const report = backtestRows(await replayHistory(opts), opts.model);
  if (opts.config.graph.enabled) report.notes.push(GRAPH_APPROXIMATION_NOTE);
  return report;
}

/** Default priors on every commit; a calibrated model only on the newest 20 % (its held-out window). */
export function backtestRows(rows: ReplayRow[], model?: ModelWeights): BacktestReport {
  const labels = rows.map((r) => r.label);
  const scores = rows.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score);
  const report: BacktestReport = {
    default: evaluate(scores, labels),
    curve: captureCurve(scores, labels),
    notes: ["Labels of the newest commits are incomplete: recent regressions may not be reverted or fixed yet."],
  };
  if (model) {
    const { test } = timeSplit(rows);
    report.calibrated = evaluate(
      test.map((r) => scoreSignals(r.signals, model).score),
      test.map((r) => r.label),
    );
  }
  return report;
}
