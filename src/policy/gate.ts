import type { HistoryIndex, ModelWeights, PolicyOutcome, Signal, DiffInfo, Contribution } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

export interface GateInput {
  score: number;
  logit: number;
  signals: Signal[];
  contributions: Contribution[];
  diff: DiffInfo;
  config: OpendrsConfig;
  model: ModelWeights;
  history: HistoryIndex;
  /** Present in CI: what the PR currently has. Absent locally (AI-review rule then reports "unknown"). */
  pr?: { labels: string[]; successfulChecks: string[]; number?: number };
  llmFailed: boolean;
}

/** Spec §6 decision order. Pure and deterministic (sampling is hashed from diff.head). */
export function decide(_input: GateInput): PolicyOutcome {
  throw new Error("not implemented: workstream C");
}
