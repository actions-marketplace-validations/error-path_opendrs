import { describe, expect, it } from "vitest";
import { backtestRows } from "../../src/model/backtest.js";
import { fitModel } from "../../src/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../src/model/defaults.js";
import { scoreSignals } from "../../src/model/logistic.js";
import { evaluate } from "../../src/model/metrics.js";
import { syntheticRows } from "./synthetic.js";

describe("backtestRows", () => {
  const rows = syntheticRows(1000, 2);

  it("reports default-model metrics and capture curve over every commit", () => {
    const report = backtestRows(rows);
    const scores = rows.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score);
    expect(report.default).toEqual(evaluate(scores, rows.map((r) => r.label)));
    expect(report.curve).toHaveLength(21);
    expect(report.calibrated).toBeUndefined();
  });

  it("default priors already beat random on churn/tests-driven risk", () => {
    const report = backtestRows(rows);
    expect(report.default.auc).toBeGreaterThan(0.6);
    expect(report.default.capturedAt["50"]).toBeGreaterThan(0.5);
  });

  it("evaluates a calibrated model on the newest 20% only", () => {
    const model = fitModel(rows);
    const report = backtestRows(rows, model);
    const newest = rows.slice(800);
    const scores = newest.map((r) => scoreSignals(r.signals, model).score);
    expect(report.calibrated).toEqual(evaluate(scores, newest.map((r) => r.label)));
    expect(report.calibrated!.commits).toBe(200);
  });
});
