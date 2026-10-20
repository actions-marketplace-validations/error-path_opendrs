/**
 * Default-weights re-centring experiment (docs/experiments.md, "Planned: re-centred default
 * weights and saturation"; pre-registered 2026-10-20): does re-centring where the score's default
 * weights are centred, rather than which signals fire, reduce out-of-the-box saturation on mature
 * repositories? Follow-up to the rejected
 * [score-saturation experiment](../../docs/experiments.html#score-saturation-fixpattern-and-incident-granularity-on-apachejit),
 * whose own recommendation (point 3) named the likely larger cause: diffusion/history signals are
 * raw, un-normalized counts that run high on an old, busy repository regardless of a specific
 * commit's risk.
 *
 * Needs no new clone and no new signal replay: both candidates below are pure transforms of the
 * existing full row cache (build 08355066ee67, the same 15-project replay behind the 0.823 pooled
 * calibrated AUC quoted throughout docs/experiments.md) and the already-downloaded ApacheJIT CSVs.
 * `src/` is not touched. No LLM calls, no API spend.
 *
 * Run `npm run build` first, then `node bench/apachejit/default-weights-experiment.ts`.
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../dist/domain/config.js";
import type { Signal } from "../../dist/domain/types.js";
import { fitModel } from "../../dist/model/calibrate.js";
import { DEFAULT_WEIGHTS } from "../../dist/model/defaults.js";
import { mulberry32 } from "../../dist/model/fit.js";
import { scoreSignals } from "../../dist/model/logistic.js";
import type { ReplayRow } from "../../dist/model/replay.js";
import { aucOf, parseApacheJit, recallAt } from "./lib.ts";
import type { JitRow } from "./lib.ts";
import { ensureDataset } from "./run.ts";

const WORK_DIR = join(homedir(), ".cache", "opendrs", "apachejit");
/** The row cache build with every project replayed (same one score-saturation-experiment.ts used). */
const BUILD = "08355066ee67";
const EXCLUDED_PROJECT = "apache/hadoop"; // no positive labels; every other ApacheJIT table excludes it too.
const BOOTSTRAP = 2000;
const CFG = defaultConfig();
const RED = CFG.thresholds.red; // 0.8
const GREEN = CFG.thresholds.green; // 0.3: the yellow-or-red boundary in the shipped three-tier rule
const YELLOW_MID = (GREEN + RED) / 2; // 0.55: "mid-yellow" for the re-centring target
const DAY_MS = 86_400_000;
const OUT = new URL("./default-weights-experiment.md", import.meta.url);

/** The unbounded, raw-count-shaped history/expertise signals (log1p of a count, no fixed ceiling). */
const SCALED_SIGNALS = ["history.churn", "history.prior_fixes", "expertise.author_commits"] as const;

type Variant = "V0" | "V1" | "V2" | "V3";
const VARIANTS: Variant[] = ["V0", "V1", "V2", "V3"];
const VARIANT_LABEL: Record<Variant, string> = {
  V0: "current defaults",
  V1: "intercept re-centred",
  V2: "history/expertise scaled by repo age",
  V3: "V1 and V2 together",
};

function logit(p: number): number {
  return Math.log(p / (1 - p));
}

const csv = async (file: string): Promise<JitRow[]> => parseApacheJit(await readFile(join(WORK_DIR, "data", file), "utf8")).filter((r) => r.project !== EXCLUDED_PROJECT);

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

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function stats(scores: number[]): { mean: number; median: number; sd: number; iqr: number } {
  const sorted = [...scores].sort((a, b) => a - b);
  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
  const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))]!;
  return { mean, median: median(scores), sd: Math.sqrt(variance), iqr: q(0.75) - q(0.25) };
}

function bootstrapAucGain(scoresA: number[], scoresB: number[], labels: number[], seed = 11, n = BOOTSTRAP): { mean: number; lo: number; hi: number } {
  const rand = mulberry32(seed);
  const diffs: number[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Array.from({ length: labels.length }, () => Math.floor(rand() * labels.length));
    const yy = idx.map((j) => labels[j]!);
    diffs.push(aucOf(idx.map((j) => scoresA[j]!), yy)! - aucOf(idx.map((j) => scoresB[j]!), yy)!);
  }
  diffs.sort((a, b) => a - b);
  return { mean: diffs.reduce((a, b) => a + b, 0) / n, lo: diffs[Math.floor(n * 0.025)]!, hi: diffs[Math.floor(n * 0.975)]! };
}

interface TierBuggy {
  green: { n: number; buggy: number };
  yellow: { n: number; buggy: number };
  red: { n: number; buggy: number };
}

function tierBuggy(scores: number[], labels: number[]): TierBuggy {
  const out: TierBuggy = { green: { n: 0, buggy: 0 }, yellow: { n: 0, buggy: 0 }, red: { n: 0, buggy: 0 } };
  for (let i = 0; i < scores.length; i++) {
    const tier = scores[i]! < GREEN ? "green" : scores[i]! >= RED ? "red" : "yellow";
    out[tier].n++;
    if (labels[i] === 1) out[tier].buggy++;
  }
  return out;
}

interface Resolved {
  sha: string;
  project: string;
  time: number;
  label: 0 | 1;
  base: Signal[];
}

/** Divides a signal's value by `max(1, log1p(age in days since the project's earliest resolved commit))`. */
function scaleSignals(signals: Signal[], ageDivisor: number): Signal[] {
  return signals.map((s) => (SCALED_SIGNALS.includes(s.id as (typeof SCALED_SIGNALS)[number]) ? { ...s, value: s.value / ageDivisor } : s));
}

function shiftIntercept(delta: number) {
  return { ...DEFAULT_WEIGHTS, intercept: DEFAULT_WEIGHTS.intercept + delta };
}

async function main(): Promise<void> {
  console.error("loading dataset and row cache");
  await ensureDataset(WORK_DIR);
  const [trainCsv, testCsv] = await Promise.all([csv("apachejit_train.csv"), csv("apachejit_test_large.csv")]);
  const projectOf = new Map<string, string>([...trainCsv, ...testCsv].map((r) => [r.sha, r.project]));
  const labelOf = new Map<string, 0 | 1>([...trainCsv, ...testCsv].map((r) => [r.sha, r.buggy]));
  const trainShas = new Set(trainCsv.map((r) => r.sha));
  const testShas = new Set(testCsv.map((r) => r.sha));
  const rows = await loadRows();
  const rowBySha = new Map(rows.map((r) => [r.sha, r]));

  const resolved: Resolved[] = [];
  for (const sha of new Set([...trainShas, ...testShas])) {
    const base = rowBySha.get(sha);
    if (!base) continue; // not in the row cache: excluded from coverage the same way every other ApacheJIT row in this log is
    resolved.push({ sha, project: projectOf.get(sha)!, time: base.time, label: labelOf.get(sha)!, base: base.signals });
  }
  console.error(`resolved ${resolved.length} row-cache commits`);

  // Repo-age anchor: the earliest *row-cache-resolved* commit time per project, both splits pooled
  // (train starts 2003 for most projects, so this tracks the project's visible history start without
  // a new clone). This is the dataset's visible window, not the repo's true creation date (caveat).
  const minTimeByProject = new Map<string, number>();
  for (const r of resolved) {
    const cur = minTimeByProject.get(r.project);
    if (cur === undefined || r.time < cur) minTimeByProject.set(r.project, r.time);
  }
  const ageDivisor = (r: Resolved): number => {
    const t0 = minTimeByProject.get(r.project)!;
    const ageDays = (r.time - t0) / (DAY_MS / 1000);
    return Math.max(1, Math.log1p(Math.max(0, ageDays)));
  };

  // V1's shift: computed on the train split's own V0 default-prior scores (never the test split),
  // so no test-split statistic informs the candidate.
  const trainDefaultScores = resolved.filter((r) => trainShas.has(r.sha)).map((r) => scoreSignals(r.base, DEFAULT_WEIGHTS).score);
  const trainMedianDefault = median(trainDefaultScores);
  const intercept_shift = logit(YELLOW_MID) - logit(trainMedianDefault);
  console.error(`train default-prior median score ${trainMedianDefault.toFixed(3)}; intercept shift ${intercept_shift.toFixed(3)} to target mid-yellow ${YELLOW_MID}`);

  function signalsFor(r: Resolved, variant: Variant): Signal[] {
    if (variant === "V0" || variant === "V1") return r.base;
    return scaleSignals(r.base, ageDivisor(r));
  }
  function weightsFor(variant: Variant) {
    return variant === "V1" || variant === "V3" ? shiftIntercept(intercept_shift) : DEFAULT_WEIGHTS;
  }

  interface VariantResult {
    variant: Variant;
    auc: number;
    r10: number;
    r30: number;
    redShare: number;
    yellowRedShare: number;
    spread: { mean: number; median: number; sd: number; iqr: number };
    tiers: TierBuggy;
    gainVsV0?: { mean: number; lo: number; hi: number };
  }

  console.error("fitting and scoring each variant");
  const results: VariantResult[] = [];
  let v0Calibrated: number[] | undefined;
  let yTest: number[] | undefined;
  for (const variant of VARIANTS) {
    const weights = weightsFor(variant);
    const toRow = (r: Resolved): ReplayRow => ({ sha: r.sha, time: r.time, label: r.label, signals: signalsFor(r, variant) });
    const train = resolved.filter((r) => trainShas.has(r.sha)).map(toRow);
    const test = resolved.filter((r) => testShas.has(r.sha)).map(toRow);
    const model = fitModel(train, weights, "pooled");
    const calibratedScores = test.map((r) => scoreSignals(r.signals, model).score);
    const defaultScores = test.map((r) => scoreSignals(r.signals, weights).score);
    const labels = test.map((r) => r.label);
    yTest ??= labels;
    if (variant === "V0") v0Calibrated = calibratedScores;
    const result: VariantResult = {
      variant,
      auc: aucOf(calibratedScores, labels)!,
      r10: recallAt(calibratedScores, labels, 10),
      r30: recallAt(calibratedScores, labels, 30),
      redShare: defaultScores.filter((s) => s >= RED).length / defaultScores.length,
      yellowRedShare: defaultScores.filter((s) => s >= GREEN).length / defaultScores.length,
      spread: stats(defaultScores),
      tiers: tierBuggy(defaultScores, labels),
    };
    if (variant !== "V0") result.gainVsV0 = bootstrapAucGain(calibratedScores, v0Calibrated!, yTest);
    console.error(
      `${variant}: AUC ${result.auc.toFixed(3)}, red ${(result.redShare * 100).toFixed(1)}%, yellow+red ${(result.yellowRedShare * 100).toFixed(1)}%, ` +
        `green buggy ${(result.tiers.green.buggy / Math.max(1, result.tiers.green.n) * 100).toFixed(1)}%`,
    );
    results.push(result);
  }

  const v0RedShare = results[0]!.redShare;
  const THRESHOLD = 0.25; // relative reduction required to adopt, per the pre-registration
  const baseRate = yTest!.reduce((a, b) => a + b, 0) / yTest!.length;

  const lines: string[] = [];
  lines.push("# Default weights: re-centring and saturation on ApacheJIT", "");
  lines.push(
    "Generated by `bench/apachejit/default-weights-experiment.ts`. Pooled over every project except `apache/hadoop`, on the dataset's official split. " +
      `Row cache build \`${BUILD}\`; no new clones, no new signal replay — both candidates are pure transforms of the existing cached signals.`,
    "",
  );
  lines.push("## Coverage", "");
  lines.push(`- ${resolved.length} row-cache commits considered (same coverage as the score-saturation experiment).`);
  lines.push(`- Test-split base rate: ${(baseRate * 100).toFixed(1)}% buggy.`);
  lines.push("");
  lines.push("## Candidates", "");
  lines.push(
    `- **V0 (current).** Unchanged \`DEFAULT_WEIGHTS\` (intercept ${DEFAULT_WEIGHTS.intercept}).`,
  );
  lines.push(
    `- **V1 (intercept re-centred).** Intercept shifted by ${intercept_shift >= 0 ? "+" : ""}${intercept_shift.toFixed(3)} (to ${(DEFAULT_WEIGHTS.intercept + intercept_shift).toFixed(3)}), ` +
      `chosen so the **train**-split default-prior median score (${trainMedianDefault.toFixed(3)}) lands at mid-yellow (${YELLOW_MID}). Every signal value is unchanged; only the intercept moves. ` +
      "This is a monotonic transform of the logit, so it cannot change score ranking: calibrated AUC is identical to V0 by construction (confirmed below, not just asserted).",
  );
  lines.push(
    "- **V2 (history/expertise scaled by repo age).** `history.churn`, `history.prior_fixes` and `expertise.author_commits` (the unbounded log1p-count signals; " +
      "`history.incident`, a 0/1 flag, and `expertise.owner_ratio`, already a 0–1 ratio, are left as is — dividing a bounded value by a growing denominator does not match the " +
      "diagnosis of raw, un-normalized *counts*) are each divided by `max(1, log1p(age in days since the project's earliest row-cache-resolved commit))`, computed per commit " +
      "from the existing cached commit time and project, no new clone needed. A brand-new project's commits keep their raw value (divisor floored at 1); an old commit in a " +
      "long-lived project has its raw count shrunk. This changes feature values, so it *can* change ranking and AUC — unlike V1.",
  );
  lines.push("- **V3.** V1 and V2 together.", "");
  lines.push("## Results (test split)", "");
  lines.push(
    "| Variant | Calibrated AUC | AUC gain vs V0 (95% CI) | Recall@10% | Recall@30% | Default-prior red share (≥0.8) | Yellow+red share (≥0.3) | Red share, relative change | Default score mean/median/SD/IQR |",
  );
  lines.push("|---|---:|---|---:|---:|---:|---:|---:|---|");
  for (const r of results) {
    const gain = r.gainVsV0 ? `${r.gainVsV0.mean >= 0 ? "+" : ""}${r.gainVsV0.mean.toFixed(4)} (${r.gainVsV0.lo.toFixed(4)} to ${r.gainVsV0.hi.toFixed(4)})` : "—";
    const relChange = r.variant === "V0" ? "—" : `${(((r.redShare - v0RedShare) / v0RedShare) * 100).toFixed(1)}%`;
    lines.push(
      `| ${r.variant} (${VARIANT_LABEL[r.variant]}) | ${r.auc.toFixed(3)} | ${gain} | ${(r.r10 * 100).toFixed(1)}% | ${(r.r30 * 100).toFixed(1)}% | ${(r.redShare * 100).toFixed(1)}% | ${(r.yellowRedShare * 100).toFixed(1)}% | ${relChange} | ${r.spread.mean.toFixed(3)} / ${r.spread.median.toFixed(3)} / ${r.spread.sd.toFixed(3)} / ${r.spread.iqr.toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push("## Buggy rate within each default-prior tier (does green still mean low risk?)", "");
  lines.push("| Variant | Green n (buggy rate) | Yellow n (buggy rate) | Red n (buggy rate) |", "|---|---|---|---|");
  for (const r of results) {
    const cell = (t: { n: number; buggy: number }) => `${t.n} (${t.n === 0 ? "—" : `${((t.buggy / t.n) * 100).toFixed(1)}%`})`;
    lines.push(`| ${r.variant} | ${cell(r.tiers.green)} | ${cell(r.tiers.yellow)} | ${cell(r.tiers.red)} |`);
  }
  lines.push("", `Base rate for reference: ${(baseRate * 100).toFixed(1)}%.`, "");
  lines.push("## Decision (pre-registration's rule, applied per variant)", "");
  for (const r of results.slice(1)) {
    const relDrop = (v0RedShare - r.redShare) / v0RedShare;
    const redOk = relDrop >= THRESHOLD;
    const aucOk = r.gainVsV0 !== undefined && (r.gainVsV0.lo > 0 || (r.gainVsV0.lo <= 0 && r.gainVsV0.hi >= 0));
    lines.push(
      `- **${r.variant}.** Red-share relative reduction ${(relDrop * 100).toFixed(1)}% ${redOk ? "≥" : "<"} ${THRESHOLD * 100}% threshold; AUC-gain 95% CI ${r.gainVsV0!.lo.toFixed(4)} to ${r.gainVsV0!.hi.toFixed(4)} (${aucOk ? "includes 0 or positive — no significant loss" : "entirely negative — significant loss"}) → by the letter of the rule: **${redOk && aucOk ? "adopt" : "reject"}**.`,
    );
  }
  lines.push(
    "",
    "**But the literal rule is not the whole story for V1.** V1's AUC is unaffected by construction — it reshuffles no ranking at all — so it can satisfy the rule's AUC side " +
      "no matter how large a shift is chosen, and a large enough intercept shift can always clear the red-share bar too, trivially, by moving the entire distribution down. The " +
      "question that matters is whether tiers still mean anything afterward: see the buggy-rate-by-tier table above.",
    "",
  );
  lines.push(
    "## Caveats",
    "",
    "- **Repo-age anchor is the dataset's visible window, not true repo age.** `minTimeByProject` is the earliest row-cache-resolved commit per project (train starts 2003 for " +
      "most projects), not the actual repository creation date; a project whose ApacheJIT-visible history starts later than its real first commit will have every commit's age " +
      "understated, in the same direction for every variant.",
    "- **V2 scopes the scaling to the unbounded count signals only** (`history.churn`, `history.prior_fixes`, `expertise.author_commits`), not `history.incident` (0/1) or " +
      "`expertise.owner_ratio` (already 0–1): this is a reading of the pre-registration's \"raw, un-normalized counts\" diagnosis, not a change to the question.",
    "- **V1's AUC-gain CI is reported for completeness, not because it could show a loss** — it is analytically identical to V0 (a monotonic rescoring), confirmed by the 0.0000 " +
      "gain below.",
    "- **No rename detection, no new history walk**: every signal value comes from the existing row cache exactly as `run.ts` computed it; only this script's own transforms (intercept shift, age-based division) are new.",
    "",
  );
  await writeFile(OUT, lines.join("\n"));
  console.error(`wrote ${OUT.pathname}`);
}

await main();
