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
}

/** All 15 ApacheJIT project values, sorted by name. `hadoop-hdfs` and `hadoop-mapreduce` are separate archived mirrors. */
export const PROJECTS: Project[] = [
  "activemq",
  "camel",
  "cassandra",
  "flink",
  "groovy",
  "hadoop",
  "hadoop-hdfs",
  "hadoop-mapreduce",
  "hbase",
  "hive",
  "ignite",
  "kafka",
  "spark",
  "zeppelin",
  "zookeeper",
].map((name) => ({ project: `apache/${name}`, name, url: `https://github.com/apache/${name}.git` }));

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

function renderModelsTable(models: Partial<Record<ModelName, ModelMetrics | null>>): string[] {
  const header = "| Model | Rows | Positives | AUC | Recall@5% | Recall@10% | Recall@30% | Recall@50% | Precision | Recall | F1 |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|---|";
  const rows = MODEL_ORDER.filter((name) => name in models).map((name) => modelRow(MODEL_LABELS[name], models[name]));
  return [header, sep, ...rows];
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
