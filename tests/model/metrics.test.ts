import { describe, expect, it } from "vitest";
import { auc, captureCurve, capturedAt, evaluate, percentiles } from "../../src/model/metrics.js";

describe("capturedAt", () => {
  it("is the share of all positives that fall in the top pct% by score", () => {
    const scores = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1, 0.0];
    const labels = [1, 0, 1, 0, 0, 0, 0, 0, 0, 1];
    expect(capturedAt(scores, labels, 10)).toBeCloseTo(1 / 3, 12);
    expect(capturedAt(scores, labels, 30)).toBeCloseTo(2 / 3, 12);
    expect(capturedAt(scores, labels, 100)).toBe(1);
    expect(capturedAt(scores, labels, 0)).toBe(0);
  });

  it("does not depend on input order", () => {
    const scores = [0.1, 0.9, 0.5, 0.7];
    const labels = [0, 1, 0, 1];
    expect(capturedAt(scores, labels, 50)).toBe(1);
    expect(capturedAt([...scores].reverse(), [...labels].reverse(), 50)).toBe(1);
  });

  it("gives ties at the cut their expected share, so a constant model captures exactly pct", () => {
    const scores = Array(20).fill(0.5);
    const labels = [1, 1, 1, 1, ...Array(16).fill(0)];
    expect(capturedAt(scores, labels, 5)).toBeCloseTo(0.05, 12);
    expect(capturedAt(scores, labels, 50)).toBeCloseTo(0.5, 12);
    expect(capturedAt(scores, [...labels].reverse(), 50)).toBeCloseTo(0.5, 12);
  });

  it("splits only the tie group that straddles the cut", () => {
    // top 50% of 4 = 2 slots: one clear winner (positive) then a 2-way tie with one positive.
    expect(capturedAt([0.9, 0.5, 0.5, 0.1], [1, 1, 0, 1], 50)).toBeCloseTo((1 + 0.5) / 3, 12);
  });

  it("returns 0 when there are no positives", () => {
    expect(capturedAt([0.2, 0.1], [0, 0], 50)).toBe(0);
    expect(capturedAt([], [], 50)).toBe(0);
  });
});

describe("auc", () => {
  it("is 1 for perfect ranking, 0 for inverted, 0.5 for all ties", () => {
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0])).toBe(0.5);
  });

  it("counts tied positive/negative pairs as half (Mann-Whitney)", () => {
    // pairs (pos,neg): (0.8,0.8)=0.5, (0.8,0.2)=1, (0.3,0.8)=0, (0.3,0.2)=1 → 2.5/4
    expect(auc([0.8, 0.3, 0.8, 0.2], [1, 1, 0, 0])).toBeCloseTo(0.625, 12);
  });

  it("is 0.5 when one class is absent", () => {
    expect(auc([0.1, 0.9], [0, 0])).toBe(0.5);
    expect(auc([0.1, 0.9], [1, 1])).toBe(0.5);
  });
});

describe("captureCurve", () => {
  it("returns 21 points from (0,0) to (1,1) in 5% steps", () => {
    const curve = captureCurve([0.9, 0.1, 0.5, 0.3], [1, 0, 0, 1]);
    expect(curve).toHaveLength(21);
    expect(curve[0]).toEqual([0, 0]);
    expect(curve[20]).toEqual([1, 1]);
    expect(curve[10]).toEqual([0.5, 0.5]);
    for (let i = 1; i < curve.length; i++) expect(curve[i]![1]).toBeGreaterThanOrEqual(curve[i - 1]![1]);
  });
});

describe("percentiles", () => {
  it("returns linearly interpolated percentiles keyed 50/75/90/95/99", () => {
    const scores = Array.from({ length: 101 }, (_, i) => i / 100).reverse();
    const p = percentiles(scores);
    expect(Object.keys(p)).toEqual(["50", "75", "90", "95", "99"]);
    expect(p["50"]).toBeCloseTo(0.5, 12);
    expect(p["90"]).toBeCloseTo(0.9, 12);
    expect(p["99"]).toBeCloseTo(0.99, 12);
  });

  it("returns {} for no scores", () => {
    expect(percentiles([])).toEqual({});
  });
});

describe("evaluate", () => {
  it("bundles commits, positives, base rate, capture@5/10/50 and AUC", () => {
    const scores = Array.from({ length: 20 }, (_, i) => (20 - i) / 20);
    const labels = scores.map((_, i) => (i === 0 || i === 15 ? 1 : 0));
    expect(evaluate(scores, labels)).toEqual({
      commits: 20,
      positives: 2,
      baseRate: 0.1,
      capturedAt: { "5": 0.5, "10": 0.5, "50": 0.5 },
      auc: auc(scores, labels),
    });
  });
});
