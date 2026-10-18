import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { OpendrsError } from "../../src/domain/types.js";
import { backtest } from "../../src/model/backtest.js";
import { calibrate, fitModel } from "../../src/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../src/model/defaults.js";
import { scoreSignals } from "../../src/model/logistic.js";
import { evaluate } from "../../src/model/metrics.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { syntheticRows } from "./synthetic.js";

describe("fitModel", () => {
  const rows = syntheticRows(3000, 1);

  it("learns the generating signs and ranks the held-out newest 20% well", () => {
    const model = fitModel(rows);
    expect(model.weights["size.churn"]).toBeGreaterThan(0.3);
    expect(model.weights["tests.missing"]).toBeGreaterThan(0.5);
    expect(model.weights["expertise.author_commits"]).toBeLessThan(-0.2);
    expect(Math.abs(model.weights["noise.feature"]!)).toBeLessThan(0.5);
    expect(model.metrics!.commits).toBe(600);
    expect(model.metrics!.auc).toBeGreaterThan(0.75);
    expect(model.metrics!.capturedAt["50"]).toBeGreaterThan(0.7);
  });

  it("records the training window (every row, after the refit), history percentiles and priors", () => {
    const model = fitModel(rows, DEFAULT_WEIGHTS, "acme/api");
    expect(model.version).toBe(1);
    expect(model.trainedOn).toEqual({
      repo: "acme/api",
      commits: 3000,
      positives: rows.filter((r) => r.label === 1).length,
      from: new Date(rows[0]!.time * 1000).toISOString(),
      to: new Date(rows[2999]!.time * 1000).toISOString(),
    });
    expect(Object.keys(model.percentiles!)).toEqual(["50", "75", "90", "95", "99"]);
    expect(model.percentiles!["50"]).toBeLessThan(model.percentiles!["99"]!);
    expect(model.priors).toEqual(DEFAULT_WEIGHTS.priors);
  });

  it("refits the chosen setting on every row, newest 20 % included", () => {
    // A feature that only varies in the newest 20 %, where it marks every positive. A fit on the
    // oldest 80 % never sees it vary; the refit on every row must give it weight.
    const late = rows.map((r, i) =>
      i < 2400 ? r : { ...r, signals: [...r.signals, { id: "late.feature", value: r.label, status: "derived" as const, summary: "", evidence: [] }] },
    );
    expect(fitModel(late).weights["late.feature"]).toBeGreaterThan(0.5);
  });

  it("still reports metrics from the held-out newest 20 %, scored by the fit on the oldest 80 %", () => {
    const late = rows.map((r, i) =>
      i < 2400 ? r : { ...r, signals: [...r.signals, { id: "late.feature", value: r.label, status: "derived" as const, summary: "", evidence: [] }] },
    );
    const model = fitModel(late);
    const newest = late.slice(2400);
    // The returned model has seen the newest rows and ranks them almost perfectly; the recorded
    // metrics come from the oldest-80 % fit, which never saw late.feature vary.
    const inSample = evaluate(newest.map((r) => scoreSignals(r.signals, model).score), newest.map((r) => r.label));
    expect(model.metrics!.commits).toBe(600);
    expect(inSample.auc).toBeGreaterThan(0.99);
    expect(model.metrics!.auc).toBeLessThan(0.95);
  });

  it("keeps prior weights for features absent from history (e.g. llm.semantic)", () => {
    const model = fitModel(rows);
    expect(model.weights["llm.semantic"]).toBe(0.8);
    expect(model.weights["paths.critical"]).toBe(DEFAULT_WEIGHTS.weights["paths.critical"]);
  });

  it("is deterministic and independent of input order", () => {
    expect(fitModel([...rows].reverse())).toEqual(fitModel(rows));
  });

  it("refuses to fit without positives in the training window", () => {
    const negatives = rows.map((r) => ({ ...r, label: 0 as const }));
    expect(() => fitModel(negatives)).toThrow(OpendrsError);
  });
});

describe("calibrate + backtest on a real repo", () => {
  let repo: TestRepo | undefined;
  afterEach(() => repo?.cleanup());

  it("fits a model that beats a random baseline on its own history", async () => {
    repo = makeRepo();
    const r = repo;
    const veteran = { name: "Vera", email: "vera@example.com" };
    const newbie = { name: "Ned", email: "ned@example.com" };
    r.commit({ "src/core.ts": "export const core = 1;\n", "tests/core.test.ts": "test\n" }, "init", veteran);
    for (let i = 0; i < 120; i++) {
      if (i % 6 === 5) {
        // Big untested change by a newcomer across many files; reverted later.
        const files: Record<string, string> = {};
        for (let f = 0; f < 8; f++) {
          files[`src/feature${i}/mod${f}.ts`] = Array.from({ length: 80 }, (_, k) => `if (x${k}) { y(${k}); }`).join("\n");
        }
        const sha = r.commit(files, `feat: big change ${i}`, newbie);
        const undo: Record<string, null> = {};
        for (const path of Object.keys(files)) undo[path] = null;
        r.commit(undo, `Revert "feat: big change ${i}"\n\nThis reverts commit ${sha}.`, veteran);
      } else {
        r.commit(
          { [`docs/note${i}.md`]: `note ${i}\n`, "tests/core.test.ts": `test ${i}\n` },
          `docs: note ${i}`,
          veteran,
        );
      }
    }
    const config = defaultConfig();
    config.history.labelHorizonDays = 0; // the whole history spans days, inside the default horizon
    const { model, warnings } = await calibrate({ repoDir: r.dir, config });
    expect(warnings).toEqual([]);
    expect(model.trainedOn!.positives).toBeGreaterThan(0);
    expect(model.metrics!.auc).toBeGreaterThan(0.5);

    const report = await backtest({ repoDir: r.dir, config, model });
    expect(report.default.capturedAt["50"]).toBeGreaterThan(0.5);
    // calibrate refits on every replayed commit, so backtest shows calibrate's recorded held-out metrics.
    expect(report.calibrated).toBeUndefined();
    expect(report.recorded).toEqual(model.metrics);
  }, 180_000);
});

describe("fitModel: llm.semantic stays raise-only", () => {
  it("clamps a negative fitted llm.semantic weight to 0", () => {
    // Positives have LOW llm values, so an unconstrained fit would go negative.
    const rows = Array.from({ length: 300 }, (_, i) => {
      const label = (i % 5 === 0 ? 1 : 0) as 0 | 1;
      return {
        sha: String(i),
        time: i,
        label,
        signals: [{ id: "llm.semantic", value: label ? 0 : 2, status: "inferred" as const, summary: "", evidence: [] }],
      };
    });
    expect(fitModel(rows).weights["llm.semantic"]).toBe(0);
  });

  it("clamps a negative fitted llm.risk.* weight to 0 too", () => {
    const rows = Array.from({ length: 300 }, (_, i) => {
      const label = (i % 5 === 0 ? 1 : 0) as 0 | 1;
      return {
        sha: String(i),
        time: i,
        label,
        signals: [{ id: "llm.risk.logic_bug", value: label ? 0 : 1, status: "inferred" as const, summary: "", evidence: [] }],
      };
    });
    expect(fitModel(rows).weights["llm.risk.logic_bug"]).toBe(0);
  });
});

describe("fitModel: keeps the priors when the fit cannot beat them", () => {
  const row = (i: number, churn: number, label: 0 | 1) => ({
    sha: String(i),
    time: i,
    label,
    signals: [{ id: "size.churn", value: churn, status: "derived" as const, summary: "", evidence: [] }],
  });

  it("keeps the priors when they already rank validation commits as well as the fit", () => {
    // Bigger change = bug, exactly what the priors already say (size.churn has a positive prior).
    const rows = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? row(i, 6 + (i % 3), 1) : row(i, 1 + (i % 3), 0)));
    const m = fitModel(rows);
    expect(m.calibration?.chosen).toBe("priors");
    expect(m.weights["size.churn"]).toBe(DEFAULT_WEIGHTS.weights["size.churn"]);
    expect(m.intercept).toBe(DEFAULT_WEIGHTS.intercept);
    // Nothing is refitted when the priors are kept: the window and held-out metrics stay as before.
    expect(m.trainedOn!.commits).toBe(320);
    expect(m.metrics!.commits).toBe(80);
  });

  it("uses the fit when the history contradicts the priors", () => {
    // Small changes are the buggy ones here, so the priors rank them backwards.
    const rows = Array.from({ length: 400 }, (_, i) => (i % 5 === 0 ? row(i, 1 + (i % 3), 1) : row(i, 6 + (i % 3), 0)));
    const m = fitModel(rows);
    expect(m.calibration?.chosen).toBe("fitted");
    expect(m.weights["size.churn"]).toBeLessThan(0);
  });
});
