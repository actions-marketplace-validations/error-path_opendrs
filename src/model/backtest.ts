import type { BacktestMetrics, ModelWeights } from "../domain/types.js";
import type { HistoryRunOptions } from "./calibrate.js";
import { DEFAULT_WEIGHTS } from "./defaults.js";
import { timeSplit } from "./fit.js";
import { scoreSignals } from "./logistic.js";
import { captureCurve, evaluate } from "./metrics.js";
import { GRAPH_APPROXIMATION_NOTE, replayHistory, type ReplayRow } from "./replay.js";

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
}

/** Replay history point-in-time and report capture@{5,10,50}% and AUC (spec §5). */
export async function backtest(opts: HistoryRunOptions & { model?: ModelWeights }): Promise<BacktestReport> {
  const { rows, warnings } = await replayHistory(opts);
  const report = backtestRows(rows, opts.model);
  if (opts.config.graph.enabled) report.notes.push(GRAPH_APPROXIMATION_NOTE);
  report.notes.push(...warnings);
  return report;
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
