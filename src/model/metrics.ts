import type { BacktestMetrics } from "../domain/types.js";

const positivesOf = (labels: number[]) => labels.reduce((n, y) => n + (y === 1 ? 1 : 0), 0);

/**
 * Meta's metric: the share of all positives that fall in the top `pct`% of commits by score.
 * The cut is n·pct/100 slots (may be fractional). A tie group straddling the cut is credited
 * its expected share under random tie-breaking, so the result is deterministic and a model
 * gets no credit for ties (a constant model captures exactly pct%).
 */
export function capturedAt(scores: number[], labels: number[], pct: number): number {
  const totalPositives = positivesOf(labels);
  if (totalPositives === 0) return 0;
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  let slots = (scores.length * pct) / 100;
  let captured = 0;
  for (let start = 0; start < order.length && slots > 0; ) {
    let end = start;
    let groupPositives = 0;
    while (end < order.length && scores[order[end]!] === scores[order[start]!]) {
      if (labels[order[end]!] === 1) groupPositives++;
      end++;
    }
    const size = end - start;
    captured += groupPositives * Math.min(1, slots / size);
    slots -= size;
    start = end;
  }
  return captured / totalPositives;
}

/** ROC-AUC via the Mann-Whitney U statistic with average ranks for ties. 0.5 if a class is absent. */
export function auc(scores: number[], labels: number[]): number {
  const positives = positivesOf(labels);
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return 0.5;
  const order = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let positiveRankSum = 0;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end < order.length && scores[order[end]!] === scores[order[start]!]) end++;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) if (labels[order[i]!] === 1) positiveRankSum += averageRank;
    start = end;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** (share gated, share of positives captured) from 0 to 1 in 5 % steps. */
export function captureCurve(scores: number[], labels: number[]): Array<[number, number]> {
  return Array.from({ length: 21 }, (_, i): [number, number] => [i / 20, i === 0 ? 0 : capturedAt(scores, labels, i * 5)]);
}

const PERCENTILE_KEYS = [50, 75, 90, 95, 99];

/** Score distribution of history (linear interpolation between order statistics). */
export function percentiles(scores: number[]): Record<string, number> {
  if (scores.length === 0) return {};
  const sorted = [...scores].sort((a, b) => a - b);
  const out: Record<string, number> = {};
  for (const p of PERCENTILE_KEYS) {
    const pos = ((sorted.length - 1) * p) / 100;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    out[String(p)] = sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
  }
  return out;
}

export function evaluate(scores: number[], labels: number[]): BacktestMetrics {
  const positives = positivesOf(labels);
  return {
    commits: scores.length,
    positives,
    baseRate: scores.length === 0 ? 0 : positives / scores.length,
    capturedAt: {
      "5": capturedAt(scores, labels, 5),
      "10": capturedAt(scores, labels, 10),
      "50": capturedAt(scores, labels, 50),
    },
    auc: auc(scores, labels),
  };
}
