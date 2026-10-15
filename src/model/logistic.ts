import type { Contribution, ModelWeights, Signal } from "../domain/types.js";

/** score = sigmoid(intercept + Σ w·x). Missing weights contribute 0; contributions sorted by |c| desc. */
export function scoreSignals(_signals: Signal[], _model: ModelWeights): { score: number; logit: number; contributions: Contribution[] } {
  throw new Error("not implemented: workstream C");
}
