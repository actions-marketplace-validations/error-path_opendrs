import { describe, expect, it } from "vitest";
import type { ModelWeights, Signal } from "../../src/domain/types.js";
import { scoreSignals, sigmoid } from "../../src/model/logistic.js";

const sig = (id: string, value: number, status: Signal["status"] = "observed"): Signal => ({
  id,
  value,
  status,
  summary: id,
  evidence: [],
});

describe("sigmoid", () => {
  it("is 0.5 at zero and symmetric", () => {
    expect(sigmoid(0)).toBe(0.5);
    expect(sigmoid(2) + sigmoid(-2)).toBeCloseTo(1, 12);
  });

  it("stays finite and in [0,1] for extreme logits", () => {
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(Number.isNaN(sigmoid(-1e308))).toBe(false);
    expect(sigmoid(-745)).toBeGreaterThanOrEqual(0);
  });
});

describe("scoreSignals", () => {
  const model: ModelWeights = { version: 1, intercept: -1, weights: { a: 2, b: -0.5, c: 0 } };

  it("computes logit = intercept + sum(w*x) and score = sigmoid(logit)", () => {
    const r = scoreSignals([sig("a", 1), sig("b", 2)], model);
    expect(r.logit).toBeCloseTo(-1 + 2 - 1, 12);
    expect(r.score).toBeCloseTo(sigmoid(0), 12);
  });

  it("ignores signals with no weight and omits zero-weight signals from contributions", () => {
    const r = scoreSignals([sig("a", 1), sig("c", 5), sig("z", 9)], model);
    expect(r.logit).toBeCloseTo(1, 12);
    expect(r.contributions.map((c) => c.id)).toEqual(["a"]);
  });

  it("uses the model prior for a missing signal, defaulting to 0", () => {
    const withPrior: ModelWeights = { ...model, priors: { b: 4 } };
    const r = scoreSignals([sig("a", 1)], withPrior);
    expect(r.logit).toBeCloseTo(-1 + 2 - 2, 12);
    expect(r.contributions).toContainEqual({ id: "b", value: 4, weight: -0.5, contribution: -2 });
    expect(scoreSignals([], model).logit).toBe(-1);
    expect(scoreSignals([], model).contributions).toEqual([]);
  });

  it("uses an unknown signal's own value (already the neutral prior)", () => {
    const withPrior: ModelWeights = { ...model, priors: { a: 10 } };
    const r = scoreSignals([sig("a", 0.25, "unknown")], withPrior);
    expect(r.logit).toBeCloseTo(-1 + 0.5, 12);
  });

  it("sorts contributions by |contribution| descending, ties by id", () => {
    const m: ModelWeights = { version: 1, intercept: 0, weights: { a: 1, b: -3, c: 1, d: 0.5 } };
    const r = scoreSignals([sig("a", 1), sig("b", 1), sig("c", 1), sig("d", 1)], m);
    expect(r.contributions.map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
    expect(r.contributions[0]).toEqual({ id: "b", value: 1, weight: -3, contribution: -3 });
  });
});
