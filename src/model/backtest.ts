import type { BacktestMetrics, ModelWeights } from "../domain/types.js";
import type { HistoryRunOptions } from "./calibrate.js";

export interface BacktestReport {
  default: BacktestMetrics;
  /** Present when a calibrated model was supplied. Evaluated on the newest 20 % only. */
  calibrated?: BacktestMetrics;
  /** (share gated, share of positives captured) points for the default model, 0..1 in 5 % steps. */
  curve: Array<[number, number]>;
}

/** Replay history point-in-time and report capture@{5,10,50}% and AUC (spec §5). Workstream C. */
export async function backtest(_opts: HistoryRunOptions & { model?: ModelWeights }): Promise<BacktestReport> {
  throw new Error("not implemented: workstream C");
}
