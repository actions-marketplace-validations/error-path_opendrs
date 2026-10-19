/**
 * Fit experiment: does `calibrate`'s fit (L2 choice, pull toward the priors, negative resampling)
 * explain the gap to the Kamei LR? Refits on the cached replay rows of build 0ea8800cbfb8, so no
 * clones are needed. Run `npm run build` first, then `node bench/apachejit/fit-experiment.ts`.
 * Pooled over every project except apache/hadoop, on the dataset's own train/test_large split.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelWeights, Signal } from "../../dist/domain/types.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { fitLogistic, resampleNegatives, timeSplit } from "../../dist/model/fit.js";
import { featureValues, scoreSignals, sigmoid } from "../../dist/model/logistic.js";
import type { ReplayRow } from "../../dist/model/replay.js";
import { aucOf, kameiFeatures, parseApacheJit, recallAt } from "./lib.ts";

const WORK_DIR = join(homedir(), ".cache", "opendrs", "apachejit");
const BUILD = "0ea8800cbfb8";
const L2S = [10, 1, 0.1, 0.01];
const OUT = new URL("./fit-experiment.md", import.meta.url);

async function loadRows(): Promise<ReplayRow[]> {
  const dir = join(WORK_DIR, "rows");
  const files = (await readdir(dir)).filter((f) => f.includes(BUILD) && !f.includes(".max") && !f.startsWith("hadoop."));
  const rows: ReplayRow[] = [];
  for (const file of files) {
    const [, ...lines] = (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean);
    for (const line of lines) {
      const row = JSON.parse(line) as ReplayRow;
      rows.push({ ...row, signals: row.signals.map((s: Signal) => ({ ...s, summary: "", evidence: [] })) });
    }
  }
  return rows;
}

const csv = async (name: string) => parseApacheJit(await readFile(join(WORK_DIR, "data", name), "utf8")).filter((r) => r.project !== "apache/hadoop");

/** The same feature vector calibrate.ts fits on (featureVector there is not exported). */
const vector = (signals: Signal[], ids: string[]) => {
  const values = featureValues(signals, DEFAULT_WEIGHTS.priors);
  return ids.map((id) => values.get(id) ?? DEFAULT_WEIGHTS.priors?.[id] ?? 0);
};

interface Variant {
  l2: number;
  priors: boolean;
  resample: boolean;
}

function fit(rows: ReplayRow[], ids: string[], v: Variant): ModelWeights {
  const sample = v.resample ? resampleNegatives(rows, (r) => r.label === 1, 5, 1) : rows;
  const f = fitLogistic(
    sample.map((r) => vector(r.signals, ids)),
    sample.map((r) => r.label),
    { l2: v.l2, priorWeights: ids.map((id) => (v.priors ? (DEFAULT_WEIGHTS.weights[id] ?? 0) : 0)) },
  );
  return { version: 1, intercept: f.intercept, weights: Object.fromEntries(ids.map((id, j) => [id, f.weights[j]!])), priors: DEFAULT_WEIGHTS.priors };
}

const metrics = (rows: ReplayRow[], model: ModelWeights) => {
  const scores = rows.map((r) => scoreSignals(r.signals, model).score);
  const labels = rows.map((r) => r.label);
  return { auc: aucOf(scores, labels) ?? NaN, r10: recallAt(scores, labels, 10), r30: recallAt(scores, labels, 30) };
};

async function main() {
  const [rows, train, test] = await Promise.all([loadRows(), csv("apachejit_train.csv"), csv("apachejit_test_large.csv")]);
  const trainShas = new Set(train.map((r) => r.sha));
  const testShas = new Set(test.map((r) => r.sha));
  const trainRows = rows.filter((r) => trainShas.has(r.sha));
  const testRows = rows.filter((r) => testShas.has(r.sha));
  const ids = [...new Set([...Object.keys(DEFAULT_WEIGHTS.weights), ...rows.flatMap((r) => r.signals.map((s) => s.id))])].sort();
  const { train: inner, test: validation } = timeSplit(trainRows);
  const resampled = resampleNegatives(trainRows, (r) => r.label === 1, 5, 1).length;
  console.error(`train ${trainRows.length} (resampled ${resampled}), test ${testRows.length}, inner ${inner.length}, validation ${validation.length}`);

  const lines: string[] = [];
  const row = (name: string, v: Variant | undefined, val: number | undefined, chosen: string, m: ReturnType<typeof metrics>) =>
    lines.push(
      `| ${name} | ${v ? v.l2 : "—"} | ${v ? (v.priors ? "on" : "off") : "—"} | ${v ? (v.resample ? "5:1" : "none") : "—"} | ${val === undefined ? "—" : val.toFixed(3)} | ${chosen} | ${m.auc.toFixed(3)} | ${(m.r10 * 100).toFixed(1)} % | ${(m.r30 * 100).toFixed(1)} % |`,
    );

  // (a) calibrate as today.
  const today = fitModel(trainRows, DEFAULT_WEIGHTS, "pooled");
  row("(a) fitModel as today", undefined, today.calibration?.validationAuc.fitted, `fit chose ${today.calibration?.chosen ?? "fitted"}`, metrics(testRows, today));
  row("default priors, no fit", undefined, metrics(validation, DEFAULT_WEIGHTS).auc, "—", metrics(testRows, DEFAULT_WEIGHTS));
  console.error("(a) done");

  // (b), (c) and the priors-on grid: each L2 fitted on the inner split (validation AUC), then on all of train (test AUC).
  const families: Array<{ name: string; priors: boolean; resample: boolean }> = [
    { name: "priors on, resampled (today's family)", priors: true, resample: true },
    { name: "(b) priors off, resampled", priors: false, resample: true },
    { name: "(c) priors on, no resampling", priors: true, resample: false },
    { name: "(b+c) priors off, no resampling", priors: false, resample: false },
  ];
  for (const fam of families) {
    const results = L2S.map((l2) => {
      const v = { l2, priors: fam.priors, resample: fam.resample };
      const val = metrics(validation, fit(inner, ids, v)).auc;
      const m = metrics(testRows, fit(trainRows, ids, v));
      console.error(`${fam.name} l2=${l2}: validation ${val.toFixed(3)}, test ${m.auc.toFixed(3)}`);
      return { v, val, m };
    });
    // calibrate's rule: the strongest penalty wins unless a weaker one beats it by 0.005 on validation.
    let pick = results[0]!;
    for (const r of results) if (r.val > pick.val + 0.005) pick = r;
    for (const r of results) row(fam.name, r.v, r.val, r === pick ? "**chosen by validation**" : "", r.m);
  }

  // (d) what fitModel does: hold out the newest 20 % of the rows it is given for its metrics, choose
  // L2 on a split of the oldest 80 %, and fit the final model on that 80 % only. Then the same
  // choice refitted on every training commit, which is the change proposed in the report.
  const { train: older } = timeSplit(trainRows);
  const { train: olderInner, test: olderValidation } = timeSplit(older);
  const today80 = L2S.map((l2) => {
    const v = { l2, priors: true, resample: true };
    return { v, val: metrics(olderValidation, fit(olderInner, ids, v)).auc, m: metrics(testRows, fit(older, ids, v)) };
  });
  let pick80 = today80[0]!;
  for (const r of today80) if (r.val > pick80.val + 0.005) pick80 = r;
  for (const r of today80) row("(d) as fitModel: final fit on the oldest 80 % only", r.v, r.val, r === pick80 ? "**chosen by validation**" : "", r.m);
  row("(d') same choice, refit on all training commits", pick80.v, pick80.val, "proposed", metrics(testRows, fit(trainRows, ids, pick80.v)));
  console.error("(d) done");

  // Reference: the bench's Kamei LR on the same CSV rows.
  const k = fitLogistic(train.map(kameiFeatures), train.map((r) => r.buggy), { l2: 0.01 });
  const kScores = test.map((r) => sigmoid(kameiFeatures(r).reduce((z, x, j) => z + k.weights[j]! * x, k.intercept)));
  const kLabels = test.map((r) => r.buggy);
  row("Kamei LR (all CSV rows, l2 0.01)", undefined, undefined, "—", { auc: aucOf(kScores, kLabels) ?? NaN, r10: recallAt(kScores, kLabels, 10), r30: recallAt(kScores, kLabels, 30) });

  const report = [
    "# Fit experiment: calibrate's fit vs a free fit (ApacheJIT, pooled excluding apache/hadoop)",
    "",
    `Generated by \`bench/apachejit/fit-experiment.ts\` from the cached rows of build ${BUILD}. Train ${trainRows.length} replayed commits ` +
      `(${trainRows.filter((r) => r.label === 1).length} positive; 5:1 resampling keeps ${resampled}), test ${testRows.length} ` +
      `(${testRows.filter((r) => r.label === 1).length} positive). Validation AUC is on the newest 20 % of the training commits ` +
      `(${validation.length}), fitted on the oldest 80 %; test AUC is from a refit on all training commits. Only validation picks a row.`,
    "",
    "| Variant | L2 | Priors pull | Resampling | Validation AUC | Choice | Test AUC | Recall@10 % | Recall@30 % |",
    "|---|---:|---|---|---:|---|---:|---:|---:|",
    ...lines,
    "",
    "## Reading",
    "",
    "- Resampling is a no-op here: ApacheJIT's training split is about half positive, so 5:1 keeps every negative, and the (c) rows equal their resampled twins.",
    "- The priors pull is not the gap: at the L2 that validation picks (0.01), priors on and off are within 0.001 test AUC, and the strong penalties (10, 1) are never chosen.",
    "- The (d) rows reproduce (a) exactly. `fitModel` first holds out the newest 20 % of the rows it is given (its `metrics`), chooses L2 on a split of the oldest 80 %, and fits the returned weights on that 80 % only. The newest fifth of the history never reaches the model.",
    "- (d') keeps that choice, made without the newest 20 % or the test years, and only refits on every training commit. That is the whole gain over the Kamei LR.",
    "",
    "## Proposed change to `src/model/calibrate.ts` (not made in this round)",
    "",
    "In `fitModel`, keep the time split for choosing L2, for the prior-vs-fit decision and for the reported `metrics`, then refit the chosen L2 on all rows for the returned weights. The intercept correction uses the base rate of all rows. In outline:",
    "",
    "```ts",
    "const choice = chooseL2(train, ids, prior, fitOn);",
    "const held = fitOn(train, choice.l2);            // scored on `test` for metrics, as today",
    "const { sample, fit } = fitOn(rows, choice.l2);  // returned weights: every labelled commit",
    "// positives and the correction then count all rows, not just `train`",
    "```",
    "",
    "The reported `metrics` then describe a model fitted on less data than the one returned, so they slightly understate it. That is the usual refit-after-selection trade-off.",
    "",
  ].join("\n");
  await writeFile(OUT, report);
  process.stdout.write(report);
}

await main();
