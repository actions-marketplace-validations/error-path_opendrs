// Pure helpers for the ApacheJIT benchmark. No imports: Node strips this file's types natively,
// so only erasable TS syntax is used here (see run.ts, which does the real work).

/** The 12 Kamei et al. commit-level metrics, in ApacheJIT CSV column order. */
export const KAMEI_IDS = ["la", "ld", "nf", "nd", "ns", "ent", "ndev", "age", "nuc", "aexp", "arexp", "asexp"] as const;
export type KameiId = (typeof KAMEI_IDS)[number];

/** One parsed row of an ApacheJIT CSV. */
export interface JitRow {
  sha: string;
  project: string;
  buggy: 0 | 1;
  time: number;
  kamei: Record<KameiId, number>;
}

export type Split = "total" | "train" | "test_large";

/** One ApacheJIT dataset file, pinned by sha256. */
export interface DatasetFile {
  split: Split;
  file: string;
  url: string;
  sha256: string;
}

/** The three ApacheJIT CSV files this benchmark downloads and verifies. */
export const DATASET: DatasetFile[] = [
  {
    split: "total",
    file: "apachejit_total.csv",
    url: "https://zenodo.org/records/5907002/files/apachejit_total.csv?download=1",
    sha256: "5097cbbbab8c4611a709b3cf95ac5c9fe5f62e619bab081911a2a247ddbed4e0",
  },
  {
    split: "train",
    file: "apachejit_train.csv",
    url: "https://zenodo.org/records/5907002/files/apachejit_train.csv?download=1",
    sha256: "7425b77e98ed30270e1d17ce3d179800539cc46a656c927e88e6609cd9b893d2",
  },
  {
    split: "test_large",
    file: "apachejit_test_large.csv",
    url: "https://zenodo.org/records/5907002/files/apachejit_test_large.csv?download=1",
    sha256: "2f21e858026fa625f51f4f6639d845c22c24595e212a3b03d8a5df93bde43ea2",
  },
];

/** One Apache project ApacheJIT draws commits from. */
export interface Project {
  project: string;
  name: string;
  url: string;
  /** Pinned replay head: the default branch at the dataset's end (late 2019, or 1 Jan 2020 UTC). */
  head: string;
}

const HEADS: Record<string, string> = {
  activemq: "d41658715bba77aaa56f46b4b2a0c0adc1107961",
  camel: "a2847950c77a9d97adf59e627bad5b2391347adc",
  cassandra: "39866333322ec702a2a28485c3bbb84560597f40",
  flink: "e1340a006e3f76b71323dc87f61063fedfdc7f3b",
  groovy: "060cbc80b6a798ae2fb5853ce3f1d38289950acb",
  hadoop: "074050ca595a81927c867951e48cef132a0284be",
  "hadoop-hdfs": "b2d2a3262c587638db04c2991d48656b3d06275c",
  "hadoop-mapreduce": "307cb5b316e10defdbbc228d8cdcdb627191ea15",
  hbase: "06eff551c367d2b939d0b345bc8ce65af71cc1b1",
  hive: "01faca2f9d7dcb0f5feabfcb07fa5ea12b79c5b9",
  ignite: "66593af03aeac37d0e76b6c010e8386f6f0c36c7",
  kafka: "3453e9e2eee1400901ef8e1965d657b825d5d64a",
  spark: "ce7a49f7fa30b4f252af09f9428cffc1055ef7c7",
  zeppelin: "7a472fe0fd63493e933d0549a808e21db38d68d8",
  zookeeper: "d784e4dc8e042bd622500f861163bb315fa856fe",
};

/** All 15 ApacheJIT project values, sorted by name. `hadoop-hdfs` and `hadoop-mapreduce` are separate archived mirrors. */
export const PROJECTS: Project[] = Object.keys(HEADS).map((name) => ({
  project: `apache/${name}`,
  name,
  url: `https://github.com/apache/${name}.git`,
  head: HEADS[name]!,
}));

const HEADER = "commit_id,project,buggy,fix,year,author_date,la,ld,nf,nd,ns,ent,ndev,age,nuc,aexp,arexp,asexp";
const SHA_RE = /^[0-9a-f]{40}$/;

/** Parses an ApacheJIT CSV. Throws on a wrong header, or a malformed row naming its 1-based line number. */
export function parseApacheJit(text: string): JitRow[] {
  const lines = text.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines[0] !== HEADER) throw new Error(`ApacheJIT header mismatch: ${lines[0]}`);
  const rows: JitRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const lineNumber = i + 1;
    const fields = lines[i]!.split(",");
    if (fields.length !== 18) throw new Error(`ApacheJIT line ${lineNumber}: expected 18 fields, got ${fields.length}`);
    const [sha, project, buggyStr, , , authorDateStr, ...kameiStrs] = fields;
    if (!SHA_RE.test(sha!)) throw new Error(`ApacheJIT line ${lineNumber}: bad sha "${sha}"`);
    if (buggyStr !== "True" && buggyStr !== "False") throw new Error(`ApacheJIT line ${lineNumber}: bad buggy value "${buggyStr}"`);
    const time = Number(authorDateStr);
    if (!Number.isFinite(time)) throw new Error(`ApacheJIT line ${lineNumber}: bad author_date "${authorDateStr}"`);
    const kamei = {} as Record<KameiId, number>;
    for (let k = 0; k < KAMEI_IDS.length; k++) {
      const id = KAMEI_IDS[k]!;
      const value = Number(kameiStrs[k]);
      if (!Number.isFinite(value)) throw new Error(`ApacheJIT line ${lineNumber}: bad ${id} value "${kameiStrs[k]}"`);
      kamei[id] = value;
    }
    rows.push({ sha: sha!, project: project!, buggy: buggyStr === "True" ? 1 : 0, time, kamei });
  }
  return rows;
}

const positivesOf = (labels: number[]) => labels.reduce((n, y) => n + (y === 1 ? 1 : 0), 0);

/**
 * ROC-AUC via the Mann-Whitney U statistic with average ranks for ties (same algorithm as
 * opendrs's `auc`, duplicated so this file stays import-free). Null if a class is absent.
 */
export function aucOf(scores: number[], labels: number[]): number | null {
  const positives = positivesOf(labels);
  const negatives = labels.length - positives;
  if (positives === 0 || negatives === 0) return null;
  const order = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let positiveRankSum = 0;
  for (let start = 0; start < order.length; ) {
    let end = start;
    while (end < order.length && scores[order[end]!] === scores[order[start]!]) end++;
    const averageRank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++) if (labels[order[i]!] === 1) positiveRankSum += averageRank;
    start = end;
  }
  return (positiveRankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/**
 * Share of all positives in the riskiest `pct`% by score, a tie group straddling the cut
 * credited by expected share (same algorithm as opendrs's `capturedAt`). 0 when no positives.
 */
export function recallAt(scores: number[], labels: number[], pct: number): number {
  const totalPositives = positivesOf(labels);
  if (totalPositives === 0) return 0;
  const order = scores.map((_, i) => i).sort((a, b) => scores[b]! - scores[a]!);
  let slots = (scores.length * pct) / 100;
  let captured = 0;
  for (let start = 0; start < order.length && slots > 0; ) {
    let end = start;
    let groupPositives = 0;
    while (end < order.length && scores[order[end]!] === scores[order[start]!]) {
      if (labels[order[end]!] === 1) groupPositives++;
      end++;
    }
    const size = end - start;
    captured += groupPositives * Math.min(1, slots / size);
    slots -= size;
    start = end;
  }
  return captured / totalPositives;
}

export interface Prf {
  precision: number;
  recall: number;
  f1: number;
}

function prfAt(scores: number[], labels: number[], threshold: number, negativeWeight = 1): Prf {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < scores.length; i++) {
    const predicted = scores[i]! >= threshold;
    const actual = labels[i] === 1;
    if (predicted && actual) tp++;
    else if (predicted) fp += negativeWeight;
    else if (actual) fn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1 };
}

/** Precision/recall/F1 at a fixed score threshold; `score >= threshold` is predicted positive. */
export function f1At(scores: number[], labels: number[], threshold: number): Prf {
  return prfAt(scores, labels, threshold);
}

/**
 * The distinct score maximizing F1; ties favor the higher threshold. `Infinity` with no positives.
 * `negativeWeight` counts each negative that many times, so a threshold chosen on a resampled set
 * can be chosen as if at the real base rate.
 */
export function bestF1Threshold(scores: number[], labels: number[], negativeWeight = 1): number {
  if (positivesOf(labels) === 0) return Infinity;
  const candidates = Array.from(new Set(scores)).sort((a, b) => b - a);
  let best = Infinity;
  let bestF1 = -1;
  for (const t of candidates) {
    const { f1 } = prfAt(scores, labels, t, negativeWeight);
    if (f1 > bestF1) {
      bestF1 = f1;
      best = t;
    }
  }
  return best;
}

/** `log1p` of every Kamei column but `ent`, in `KAMEI_IDS` order. */
export function kameiFeatures(row: JitRow): number[] {
  return KAMEI_IDS.map((id) => (id === "ent" ? row.kamei[id] : Math.log1p(row.kamei[id])));
}

export const RECALL_KS = ["5", "10", "30", "50"] as const;

export interface ModelMetrics {
  rows: number;
  positives: number;
  auc: number | null;
  /** null when the test rows have no positives: recall is undefined, not 0. */
  recallAt: Record<(typeof RECALL_KS)[number], number | null>;
  prf: Prf | null;
}

/**
 * F1 threshold fit on `train` (negatives weighted by `negativeWeight`), then AUC, recall@k and
 * precision/recall/F1 scored on `test`.
 */
export function evaluateModel(
  train: { scores: number[]; labels: number[] },
  test: { scores: number[]; labels: number[] },
  negativeWeight = 1,
): ModelMetrics {
  const positives = positivesOf(test.labels);
  const threshold = bestF1Threshold(train.scores, train.labels, negativeWeight);
  const recallAtK = {} as Record<(typeof RECALL_KS)[number], number | null>;
  for (const k of RECALL_KS) recallAtK[k] = positives === 0 ? null : recallAt(test.scores, test.labels, Number(k));
  return {
    rows: test.scores.length,
    positives,
    auc: aucOf(test.scores, test.labels),
    recallAt: recallAtK,
    prf: positives === 0 ? null : f1At(test.scores, test.labels, threshold),
  };
}

export type ModelName = "default" | "calibrated" | "kamei" | "kameiReplayed";

export const MODEL_LABELS: Record<ModelName, string> = {
  default: "opendrs, default priors",
  calibrated: "opendrs, calibrated",
  kamei: "Kamei LR (all CSV rows)",
  kameiReplayed: "Kamei LR (replayed rows)",
};

const MODEL_ORDER: ModelName[] = ["default", "calibrated", "kamei", "kameiReplayed"];

export interface Coverage {
  labelled: number;
  replayed: number;
}

export interface ProjectResult {
  project: string;
  head?: string;
  coverage: { train: Coverage; test: Coverage };
  models: Partial<Record<ModelName, ModelMetrics | null>>;
  calibration?: "fitted" | "priors";
  skipped?: string;
  warnings: string[];
}

export interface Report {
  meta: { version: string; commit: string; date: string; hashes: Record<string, string> };
  pooled: ProjectResult[];
  projects: ProjectResult[];
}

export const DRS_OSS: { auc: number; f1: number; recallAt: { "5": number; "10": number; "30": number } } = {
  auc: 0.895,
  f1: 0.641,
  recallAt: { "5": 0.315, "10": 0.503, "30": 0.864 },
};

export const CAVEATS: string[] = [
  "**Different split from DRS-OSS.** DRS-OSS used its own chronological 80/10/10 split and reads diffs and messages with a fine-tuned LLM. Its numbers are a reference, not a like-for-like comparison.",
  "**Graph approximation.** The import graph is built once per project at the end of 2019, so a 2010 commit sees 2019 dependents. This is the same approximation `backtest` already reports.",
  "**Labels are SZZ with JIRA links.** They are noisy in the ways SZZ is noisy (reformatting, wide fixes), and they differ from opendrs's own labels.",
  "**Java-only.** ApacheJIT exercises the language-agnostic signals and the Java import extractor, not the other languages' extractors.",
  "**`apache/hadoop` has no positives**, hence the pooled table with and without it.",
  "**Balanced training file.** `train` is undersampled to about 50/50 overall (from 5 % to 85 % positive per project), so `fitModel`'s 5:1 resample keeps every row and its prior correction centres scores on the training file's rate, not the real one. AUC and recall@k do not depend on that, but F1 does. The F1 threshold is therefore chosen on training scores with each negative weighted so the training set has the real pre-2017 positive rate of the same projects (from `apachejit_total.csv`); test rows never choose it.",
];

/** Caveats specific to the LLM report, on top of the benchmark's own (which `renderLlmReport` does not repeat). */
export const LLM_CAVEATS: string[] = [
  "**Memorization.** The judged commits are public 2003–2019 Apache commits that the model has most likely seen in training, fixes included. The LLM rows may therefore overstate performance on unseen code; treat them as an upper bound, not an estimate for your repository.",
];

function fmtNum(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(3);
}

function fmtPct(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(1)} %`;
}

function modelRow(label: string, m: ModelMetrics | null | undefined): string {
  if (!m) return `| ${label} | — | — | — | — | — | — | — | — | — | — |`;
  return [
    `| ${label}`,
    m.rows,
    m.positives,
    fmtNum(m.auc),
    fmtPct(m.recallAt["5"]),
    fmtPct(m.recallAt["10"]),
    fmtPct(m.recallAt["30"]),
    fmtPct(m.recallAt["50"]),
    fmtNum(m.prf?.precision),
    fmtNum(m.prf?.recall),
    `${fmtNum(m.prf?.f1)} |`,
  ].join(" | ");
}

function drsOssRow(): string {
  return `| DRS-OSS (published) | — | — | ${fmtNum(DRS_OSS.auc)} | ${fmtPct(DRS_OSS.recallAt["5"])} | ${fmtPct(DRS_OSS.recallAt["10"])} | ${fmtPct(DRS_OSS.recallAt["30"])} | — | — | — | ${fmtNum(DRS_OSS.f1)} |`;
}

const MODELS_HEADER = "| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |";
const MODELS_SEP = "|---|---|---|---|---|---|---|---|---|---|---|";

function renderModelsTable(models: Partial<Record<ModelName, ModelMetrics | null>>): string[] {
  const rows = MODEL_ORDER.filter((name) => name in models).map((name) => modelRow(MODEL_LABELS[name], models[name]));
  return [MODELS_HEADER, MODELS_SEP, ...rows];
}

function renderPooledResult(result: ProjectResult): string[] {
  return [`### ${result.project}`, "", `Calibration: ${calibrationText(result)}.`, "", ...renderModelsTable(result.models), drsOssRow(), ""];
}

/** Whether `fitModel` kept its fit or fell back to the priors (then the two opendrs rows match). */
function calibrationText(r: ProjectResult): string {
  if (r.calibration === "priors") return "kept the default priors (the fit did not beat them on validation)";
  if (r.calibration === "fitted") return "fitted";
  return "—";
}

function perProjectRow(r: ProjectResult): string {
  const head = r.head ? r.head.slice(0, 12) : "—";
  const train = `${r.coverage.train.replayed}/${r.coverage.train.labelled}`;
  const test = `${r.coverage.test.replayed}/${r.coverage.test.labelled}`;
  const project = r.skipped ? `${r.project} (skipped: ${r.skipped})` : r.project;
  const modelCells = MODEL_ORDER.map((name) => `${fmtNum(r.models[name]?.auc)} | ${fmtPct(r.models[name]?.recallAt["10"])}`).join(" | ");
  const calibration = r.calibration ?? "—";
  return `| ${project} | ${head} | ${train} | ${test} | ${calibration} | ${modelCells} |`;
}

function renderPerProjectTable(projects: ProjectResult[]): string[] {
  const modelHeaders = MODEL_ORDER.map((name) => `${MODEL_LABELS[name]} AUC | ${MODEL_LABELS[name]} Recall@10%`).join(" | ");
  const header = `| Project | Head | Train replayed/labelled | Test replayed/labelled | Calibration | ${modelHeaders} |`;
  const sep = `|${"---|".repeat(5 + MODEL_ORDER.length * 2)}`;
  return [header, sep, ...projects.map(perProjectRow)];
}

/** Renders a `Report` as Markdown: metadata, pooled tables, the per-project table, caveats and warnings. */
export function renderReport(report: Report): string {
  const lines: string[] = ["# opendrs on ApacheJIT", ""];
  lines.push(`- version: ${report.meta.version}`, `- commit: ${report.meta.commit}`, `- date: ${report.meta.date}`);
  for (const [file, hash] of Object.entries(report.meta.hashes)) lines.push(`- ${file}: ${hash}`);
  lines.push("");

  lines.push("## Pooled", "");
  for (const pooled of report.pooled) lines.push(...renderPooledResult(pooled));

  lines.push("## Per project", "", ...renderPerProjectTable(report.projects), "");

  lines.push("## Caveats", "");
  for (const c of CAVEATS) lines.push(`- ${c}`);
  lines.push("");

  lines.push("## Warnings", "");
  for (const p of [...report.pooled, ...report.projects]) {
    if (!p.skipped && p.warnings.length === 0) continue;
    lines.push(`### ${p.project}`);
    if (p.skipped) lines.push(`- skipped: ${p.skipped}`);
    for (const w of p.warnings) lines.push(`- ${w}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---- LLM judge benchmark (llm.ts) ----

/** The first `n` of a seeded Fisher-Yates shuffle of `items`; `items` is left as is. */
export function sample<T>(items: T[], n: number, rand: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

/** What the gate and category tables read from a judged commit; `judgement` is absent when the judge failed. */
export interface JudgedCommit {
  buggy: 0 | 1;
  judgement?: {
    hunks: { category: string; safe: boolean; confidence: number }[];
    unclassified: unknown[];
    truncated: boolean;
  };
}

/** Whether `llm.requireSafe` at `minConfidence` lets the commit through: every shown hunk safe and confident enough, nothing unclassified or cut. */
export function passesGate(j: NonNullable<JudgedCommit["judgement"]>, minConfidence: number): boolean {
  return !j.truncated && j.unclassified.length === 0 && j.hunks.every((h) => h.safe && h.confidence >= minConfidence);
}

export interface GateStats {
  minConfidence: number;
  passed: number;
  buggy: number;
}

/** How many commits the gate would pass at `minConfidence`, and how many of those are buggy. A failed judge never passes. */
export function gateStats(commits: JudgedCommit[], minConfidence: number): GateStats {
  const passed = commits.filter((c) => c.judgement !== undefined && passesGate(c.judgement, minConfidence));
  return { minConfidence, passed: passed.length, buggy: passed.filter((c) => c.buggy === 1).length };
}

export interface CategoryStats {
  category: string;
  flagged: number;
  buggy: number;
}

/** Per category, the commits with at least one hunk in it, and how many of those are buggy. */
export function categoryStats(commits: JudgedCommit[], categories: readonly string[]): CategoryStats[] {
  return categories.map((category) => {
    const flagged = commits.filter((c) => c.judgement?.hunks.some((h) => h.category === category));
    return { category, flagged: flagged.length, buggy: flagged.filter((c) => c.buggy === 1).length };
  });
}

export interface SampleStats {
  rows: number;
  positives: number;
  /** Commits whose judgement failed (they score with an unknown `llm.semantic`). */
  judgeFailures: number;
}

export interface LlmReport {
  meta: { version: string; commit: string; date: string; model: string; promptHash: string; maxDiffChars: number };
  sample: { train: SampleStats; test: SampleStats };
  models: { label: string; metrics: ModelMetrics | null }[];
  gates: GateStats[];
  categories: CategoryStats[];
  notes: string[];
}

const rate = (part: number, whole: number) => (whole === 0 ? null : part / whole);

/** Renders an `LlmReport` as Markdown: metadata, the sample, the models table, the gate and category tables, notes. */
export function renderLlmReport(report: LlmReport): string {
  const { meta, sample: s } = report;
  const sampleLine = (name: string, x: SampleStats) => `- ${name}: ${x.rows} rows, ${x.positives} positives, ${x.judgeFailures} judge failures`;
  const lines: string[] = ["# opendrs LLM judge on ApacheJIT (sampled)", ""];
  lines.push(`- version: ${meta.version}`, `- commit: ${meta.commit}`, `- date: ${meta.date}`, `- model: ${meta.model}`, `- prompt hash: ${meta.promptHash}`);
  lines.push(sampleLine("train sample", s.train), sampleLine("test sample", s.test));
  lines.push(`- tokens: the provider reports no usage; each diff is cut to \`llm.maxDiffChars\` = ${meta.maxDiffChars} characters before it is sent`, "");

  lines.push("## Models", "", "Thresholds fit on the train sample, metrics on the test sample.", "");
  lines.push(MODELS_HEADER, MODELS_SEP, ...report.models.map((m) => modelRow(m.label, m.metrics)), "");

  lines.push("## Gate (`llm.requireSafe`)", "", `Base rate of the test sample: ${fmtPct(rate(s.test.positives, s.test.rows))}.`, "");
  lines.push("| Min confidence | Passed | Share of test sample | Buggy among passed | Buggy rate |", "|---|---|---|---|---|");
  for (const g of report.gates) lines.push(`| ${g.minConfidence} | ${g.passed} | ${fmtPct(rate(g.passed, s.test.rows))} | ${g.buggy} | ${fmtPct(rate(g.buggy, g.passed))} |`);
  lines.push("");

  lines.push("## Risk categories", "", "| Category | Flagged test commits | Buggy | Buggy rate |", "|---|---|---|---|");
  for (const c of report.categories) lines.push(`| ${c.category} | ${c.flagged} | ${c.buggy} | ${fmtPct(rate(c.buggy, c.flagged))} |`);
  lines.push("");

  lines.push("## Caveats", "");
  for (const c of LLM_CAVEATS) lines.push(`- ${c}`);
  lines.push("");

  lines.push("## Notes", "");
  for (const n of report.notes) lines.push(`- ${n}`);
  lines.push("");
  return lines.join("\n");
}
