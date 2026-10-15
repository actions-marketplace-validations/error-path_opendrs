import type { Contribution, ModelWeights, Signal } from "../domain/types.js";

/** Numerically stable logistic: never evaluates exp() of a large positive number. */
export function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/**
 * score = sigmoid(intercept + Σ w·x). A missing or `unknown` signal takes `model.priors[id]`
 * (falling back to the emitted value, else 0): providers cannot see the model's priors.
 * Contributions omit zero weights and are sorted by |w·x| desc (ties by id).
 */
export function scoreSignals(signals: Signal[], model: ModelWeights): { score: number; logit: number; contributions: Contribution[] } {
  const values = featureValues(signals, model.priors);
  const contributions: Contribution[] = [];
  let logit = model.intercept;
  for (const [id, weight] of Object.entries(model.weights)) {
    if (weight === 0) continue;
    const value = values.get(id) ?? model.priors?.[id] ?? 0;
    if (!values.has(id) && value === 0) continue;
    const contribution = weight * value;
    logit += contribution;
    contributions.push({ id, value, weight, contribution });
  }
  contributions.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { score: sigmoid(logit), logit, contributions };
}

/** Per-signal x as the model sees it: an `unknown` signal takes its prior when one exists. */
export function featureValues(signals: Signal[], priors: Record<string, number> | undefined): Map<string, number> {
  return new Map(signals.map((s) => [s.id, s.status === "unknown" ? (priors?.[s.id] ?? s.value) : s.value]));
}
