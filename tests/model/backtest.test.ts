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

  it("evaluates a calibrated model on the commits after its training window", () => {
    const model = fitModel(rows.slice(0, 800)); // refitted on rows 0..799
    const report = backtestRows(rows, model);
    const newest = rows.slice(800);
    const scores = newest.map((r) => scoreSignals(r.signals, model).score);
    expect(report.calibrated).toEqual(evaluate(scores, newest.map((r) => r.label)));
    expect(report.calibrated!.commits).toBe(200);
  });

  it("evaluates the calibrated model only on commits after its training window, next to the default on the same commits", () => {
    const model = fitModel(rows.slice(0, 800)); // refitted on rows 0..799
    const report = backtestRows(rows.slice(0, 900), model);
    const heldOut = rows.slice(800, 900);
    const labels = heldOut.map((r) => r.label);
    expect(report.calibrated).toEqual(evaluate(heldOut.map((r) => scoreSignals(r.signals, model).score), labels));
    expect(report.defaultOnHeldOut).toEqual(evaluate(heldOut.map((r) => scoreSignals(r.signals, DEFAULT_WEIGHTS).score), labels));
    expect(report.calibrated!.commits).toBe(100);
  });

  it("shows calibrate's recorded held-out metrics when no replayed commit is newer than the training window", () => {
    const model = fitModel(rows);
    const report = backtestRows(rows, model);
    expect(report.calibrated).toBeUndefined();
    expect(report.defaultOnHeldOut).toBeUndefined();
    expect(report.recorded).toEqual(model.metrics);
    const notes = report.notes.join("\n");
    expect(notes).toMatch(/no replayed commit is newer than the calibrated model's training window/i);
    expect(notes).toMatch(/oldest 80 %/);
  });

  it("says there are no held-out metrics when the model records none", () => {
    const { metrics: _, ...model } = fitModel(rows);
    const report = backtestRows(rows, model);
    expect(report.recorded).toBeUndefined();
    expect(report.notes.join("\n")).toMatch(/so it has no held-out metrics/);
  });
});
