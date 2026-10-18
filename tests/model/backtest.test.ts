import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { backtest, backtestRows, focusHitRate } from "../../src/model/backtest.js";
import { fitModel } from "../../src/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../src/model/defaults.js";
import { scoreSignals } from "../../src/model/logistic.js";
import { evaluate } from "../../src/model/metrics.js";
import { makeRepo } from "../helpers/repo.js";
import { syntheticRows } from "./synthetic.js";

// Real loadDiff, wrapped so a test can make one commit's measurement fail without touching git.
vi.mock("../../src/git/diff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/git/diff.js")>();
  return { ...actual, loadDiff: vi.fn(actual.loadDiff) };
});
const { loadDiff } = await import("../../src/git/diff.js");
const realLoadDiff = (await vi.importActual<typeof import("../../src/git/diff.js")>("../../src/git/diff.js")).loadDiff;
afterEach(() => vi.mocked(loadDiff).mockImplementation(realLoadDiff));

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

describe("focusHitRate", () => {
  it("counts a hit when the buggy commit's Review first hunks contain the fix-blamed line", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nBUG\n3\n" }, "introduce bug");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug");
    const config = defaultConfig();
    const result = await focusHitRate({ repoDir: repo.dir, config });
    expect(result.commits).toBeGreaterThan(0);
    expect(result.hitRate).toBeGreaterThanOrEqual(0);
    expect(result.hitRate).toBeLessThanOrEqual(1);
    repo.cleanup();
  });

  it("measures changedLineShare over changed lines, not context: 1.0 when the one focus hunk is the whole diff", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nBUG\n3\n" }, "introduce bug");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug");
    const result = await focusHitRate({ repoDir: repo.dir, config: defaultConfig() });
    expect(result.commits).toBe(1);
    expect(result.changedLineShare).toBe(1);
    repo.cleanup();
  });

  it("excludes an ignored file's lines from totalChanged, so a lockfile bump does not dilute changedLineShare", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n", "pkg-lock.json": '{"v":1}\n' }, "base");
    repo.commit({ "a.ts": "1\nBUG\n3\n", "pkg-lock.json": '{"v":2}\n' }, "introduce bug");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug");
    const config = defaultConfig();
    config.paths.ignore.push("pkg-lock.json");
    const result = await focusHitRate({ repoDir: repo.dir, config });
    expect(result.commits).toBe(1);
    expect(result.changedLineShare).toBe(1);
    repo.cleanup();
  });

  it("reports 0 commits (not NaN) when there are no SZZ-labelled commits", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    const result = await focusHitRate({ repoDir: repo.dir, config: defaultConfig() });
    expect(result.commits).toBe(0);
    expect(result.hitRate).toBe(0);
    repo.cleanup();
  });

  it("applies maxCommits to the same newest-first window as replayHistory, before the SZZ filter", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nBUG\n3\n" }, "introduce bug"); // SZZ-labelled, but outside the 1-commit window
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug");
    repo.commit({ "a.ts": "1\nFIXED\n3\nmore\n" }, "unrelated newest change"); // the only commit in the window
    const config = defaultConfig();
    // Filtering to SZZ-labelled commits before windowing would still find "introduce bug" here.
    const result = await focusHitRate({ repoDir: repo.dir, config, maxCommits: 1 });
    expect(result.commits).toBe(0);
    repo.cleanup();
  });

  it("applies since to the same window as replayHistory, before the SZZ filter", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base", undefined, 1_700_000_000);
    repo.commit({ "a.ts": "1\nBUG\n3\n" }, "introduce bug", undefined, 1_700_001_000); // SZZ-labelled, but before `since`
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug", undefined, 1_700_002_000);
    repo.commit({ "a.ts": "1\nFIXED\n3\nmore\n" }, "unrelated newest change", undefined, 1_700_100_000); // after `since`
    const config = defaultConfig();
    const since = new Date(1_700_050_000 * 1000).toISOString();
    // Ignoring `since` would still find "introduce bug" here.
    const result = await focusHitRate({ repoDir: repo.dir, config, since });
    expect(result.commits).toBe(0);
    repo.cleanup();
  });

  it("counts a commit whose measurement fails as skipped, instead of silently dropping it from the denominator", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nBUG\n3\n" }, "introduce bug");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: the bug");
    vi.mocked(loadDiff).mockImplementation(async () => {
      throw new Error("boom");
    });

    const result = await focusHitRate({ repoDir: repo.dir, config: defaultConfig() });
    expect(result.commits).toBe(0);
    expect(result.hitRate).toBe(0);
    expect(result.skipped).toBe(1);
    repo.cleanup();
  });
});

describe("backtest --brief wiring", () => {
  it("adds focusHitRate to the report only when opts.brief is true", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n" }, "base");
    repo.commit({ "a.ts": "1\nBUG\n" }, "introduce bug");
    repo.commit({ "a.ts": "1\nFIXED\n" }, "fix: the bug");
    const config = defaultConfig();
    const plain = await backtest({ repoDir: repo.dir, config });
    expect(plain.focusHitRate).toBeUndefined();
    const withBrief = await backtest({ repoDir: repo.dir, config, brief: true });
    expect(withBrief.focusHitRate).toBeDefined();
    repo.cleanup();
  });
});
