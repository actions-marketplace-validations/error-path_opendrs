import { describe, expect, it } from "vitest";
import { fitLogistic, mulberry32, resampleNegatives, timeSplit } from "../../src/model/fit.js";
import { sigmoid } from "../../src/model/logistic.js";

/** Synthetic data on raw (unstandardized) scales with a known generating model. */
function synthetic(n: number, seed: number, truth: { b: number; w: number[] }) {
  const rand = mulberry32(seed);
  const X: number[][] = [];
  const y: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = [rand() * 10, 100 + rand() * 100, rand() < 0.3 ? 1 : 0];
    const z = truth.b + truth.w.reduce((s, w, j) => s + w * x[j]!, 0);
    X.push(x);
    y.push(rand() < sigmoid(z) ? 1 : 0);
  }
  return { X, y };
}

describe("fitLogistic", () => {
  const truth = { b: 1, w: [0.6, -0.03, 1.2] };

  it("recovers known weights on raw feature scales (weights are de-standardized)", () => {
    const { X, y } = synthetic(20_000, 7, truth);
    const fit = fitLogistic(X, y, { l2: 1e-4 });
    expect(fit.intercept).toBeCloseTo(truth.b, 0);
    expect(fit.weights[0]).toBeCloseTo(truth.w[0]!, 1);
    expect(fit.weights[1]).toBeCloseTo(truth.w[1]!, 2);
    expect(fit.weights[2]).toBeCloseTo(truth.w[2]!, 0);
  });

  it("shrinks weights toward zero as l2 grows", () => {
    const { X, y } = synthetic(2_000, 3, truth);
    const loose = fitLogistic(X, y, { l2: 1e-4 });
    const tight = fitLogistic(X, y, { l2: 1 });
    expect(Math.abs(tight.weights[0]!)).toBeLessThan(Math.abs(loose.weights[0]!));
    expect(Math.abs(tight.weights[2]!)).toBeLessThan(Math.abs(loose.weights[2]!));
  });

  it("keeps the prior weight for a feature with no variation and folds it out of the intercept", () => {
    const { X, y } = synthetic(2_000, 5, truth);
    const withConst = X.map((x) => [...x, 3]);
    const base = fitLogistic(X, y, {});
    const fit = fitLogistic(withConst, y, { priorWeights: [0, 0, 0, 0.7] });
    expect(fit.weights[3]).toBe(0.7);
    expect(fit.intercept + 0.7 * 3).toBeCloseTo(base.intercept, 6);
    expect(fit.weights.slice(0, 3)).toEqual(base.weights);
  });

  it("stays finite on perfectly separable data", () => {
    const X = [[0], [1], [2], [3], [4], [5]];
    const y = [0, 0, 0, 1, 1, 1];
    const fit = fitLogistic(X, y, {});
    expect(Number.isFinite(fit.intercept)).toBe(true);
    expect(fit.weights[0]).toBeGreaterThan(0);
    expect(Number.isFinite(fit.weights[0]!)).toBe(true);
  });

  it("is deterministic", () => {
    const { X, y } = synthetic(500, 11, truth);
    expect(fitLogistic(X, y, {})).toEqual(fitLogistic(X, y, {}));
  });
});

describe("mulberry32", () => {
  it("is a deterministic uniform PRNG in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeCloseTo(0.5, 1);
  });
});

describe("resampleNegatives", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ id: i, label: i % 20 === 0 ? 1 : 0 }));
  const isPositive = (r: { label: number }) => r.label === 1;

  it("keeps every positive and 5 negatives per positive, in original order", () => {
    const out = resampleNegatives(rows, isPositive, 5, 1);
    expect(out.filter(isPositive)).toHaveLength(5);
    expect(out.filter((r) => !isPositive(r))).toHaveLength(25);
    expect(out.map((r) => r.id)).toEqual([...out.map((r) => r.id)].sort((a, b) => a - b));
  });

  it("is deterministic per seed and differs across seeds", () => {
    const ids = (seed: number) => resampleNegatives(rows, isPositive, 5, seed).map((r) => r.id);
    expect(ids(1)).toEqual(ids(1));
    expect(ids(1)).not.toEqual(ids(2));
  });

  it("keeps all rows when negatives are already scarce", () => {
    const few = rows.slice(0, 4); // 1 positive, 3 negatives
    expect(resampleNegatives(few, isPositive, 5, 1)).toEqual(few);
  });
});

describe("timeSplit", () => {
  it("trains on the oldest 80% and tests on the newest 20%, without mutating input", () => {
    const rows = [5, 1, 9, 3, 7, 2, 8, 4, 10, 6].map((time) => ({ time }));
    const copy = [...rows];
    const { train, test } = timeSplit(rows);
    expect(train.map((r) => r.time)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(test.map((r) => r.time)).toEqual([9, 10]);
    expect(rows).toEqual(copy);
  });
});
