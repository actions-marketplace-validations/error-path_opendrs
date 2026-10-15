export interface FitOptions {
  /** L2 penalty on standardized weights (the intercept is not penalized). */
  l2?: number;
  maxIterations?: number;
  /** Weight to use for a column with no variation (the data cannot inform it). Default 0. */
  priorWeights?: number[];
}

export interface FitResult {
  intercept: number;
  /** On the raw feature scale, so `scoreSignals` can use them directly. */
  weights: number[];
}

/**
 * L2-regularized logistic regression by batch gradient descent on standardized features.
 * Minimizes mean log-loss + (l2/2)·‖w‖². Deterministic: no randomness inside.
 */
export function fitLogistic(X: number[][], y: number[], opts: FitOptions = {}): FitResult {
  const l2 = opts.l2 ?? 0.01;
  const maxIterations = opts.maxIterations ?? 5000;
  const n = X.length;
  const d = X[0]?.length ?? 0;

  const mean = Array.from({ length: d }, (_, j) => X.reduce((s, x) => s + x[j]!, 0) / n);
  const std = Array.from({ length: d }, (_, j) => Math.sqrt(X.reduce((s, x) => s + (x[j]! - mean[j]!) ** 2, 0) / n));
  const active = mean.map((_, j) => j).filter((j) => std[j]! > 1e-12);
  const Z = X.map((x) => active.map((j) => (x[j]! - mean[j]!) / std[j]!));

  // Standardized columns have unit variance, so the loss gradient is Lipschitz with L ≤ k/4 + l2;
  // a 1/L step always converges without tuning.
  const k = active.length;
  const step = 1 / (k / 4 + l2 + 0.25);
  const base = y.reduce((s, v) => s + v, 0) / n;
  let b = Math.log(Math.max(base, 1e-6) / Math.max(1 - base, 1e-6));
  const w = new Array<number>(k).fill(0);

  for (let iter = 0; iter < maxIterations; iter++) {
    const gw = w.map((wj) => l2 * wj);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = Z[i]!;
      let logit = b;
      for (let j = 0; j < k; j++) logit += w[j]! * z[j]!;
      const err = (logit >= 0 ? 1 / (1 + Math.exp(-logit)) : Math.exp(logit) / (1 + Math.exp(logit))) - y[i]!;
      gb += err / n;
      for (let j = 0; j < k; j++) gw[j]! += (err * z[j]!) / n;
    }
    b -= step * gb;
    let maxGrad = Math.abs(gb);
    for (let j = 0; j < k; j++) {
      w[j]! -= step * gw[j]!;
      maxGrad = Math.max(maxGrad, Math.abs(gw[j]!));
    }
    if (maxGrad < 1e-8) break;
  }

  const weights = new Array<number>(d).fill(0);
  let intercept = b;
  active.forEach((j, a) => {
    weights[j] = w[a]! / std[j]!;
    intercept -= weights[j]! * mean[j]!;
  });
  for (let j = 0; j < d; j++) {
    if (active.includes(j)) continue;
    weights[j] = opts.priorWeights?.[j] ?? 0;
    intercept -= weights[j]! * mean[j]!;
  }
  return { intercept, weights };
}

/** Small seeded PRNG (mulberry32): uniform in [0,1), deterministic per seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Keep every positive and at most `ratio` negatives per positive (Meta trains at 5:1), chosen
 * by a seeded shuffle. Output keeps the input order. Scores from a model fit on this sample are
 * relative to the resampled base rate, not the raw one; percentile thresholds absorb that.
 */
export function resampleNegatives<T>(rows: T[], isPositive: (row: T) => boolean, ratio = 5, seed = 1): T[] {
  const negatives = rows.flatMap((r, i) => (isPositive(r) ? [] : [i]));
  const keep = (rows.length - negatives.length) * ratio;
  if (negatives.length <= keep) return rows.slice();
  const rand = mulberry32(seed);
  for (let i = negatives.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [negatives[i], negatives[j]] = [negatives[j]!, negatives[i]!];
  }
  const kept = new Set(negatives.slice(0, keep));
  return rows.filter((r, i) => isPositive(r) || kept.has(i));
}

/** Time-ordered split: train on the oldest share, test on the newest rest (no future leakage). */
export function timeSplit<T extends { time: number }>(rows: T[], trainShare = 0.8): { train: T[]; test: T[] } {
  const sorted = [...rows].sort((a, b) => a.time - b.time);
  const cut = Math.round(sorted.length * trainShare);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}
