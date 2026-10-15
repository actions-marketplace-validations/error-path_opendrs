// Shared contracts. Every module depends on this file; it depends on nothing.
// Changing a type here is an interface change: update the spec (docs/specs) too.

/** How a value was obtained (REA-style provenance). `unknown` is never "zero risk". */
export type Provenance = "observed" | "derived" | "inferred" | "unknown";

export interface Evidence {
  file?: string;
  line?: number;
  detail: string;
}

/** One feature value produced by a SignalProvider. Weights live in the model, not here. */
export interface Signal {
  /** Stable id, e.g. "size.churn". Must match a key in model weights to affect the score. */
  id: string;
  /** Feature value x (already transformed, e.g. log1p). For `unknown`, the neutral prior. */
  value: number;
  status: Provenance;
  /** One line a reviewer can read, e.g. "412 lines changed across 9 files". */
  summary: string;
  evidence: Evidence[];
}

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Raw hunk body lines including leading "+", "-", " " markers. */
  lines: string[];
}

export interface ChangedFile {
  /** Path at head (for deleted files, the old path). Repo-relative, forward slashes. */
  path: string;
  oldPath?: string;
  status: FileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  hunks: Hunk[];
  /** True when the file matched `paths.ignore` (lockfiles, generated, vendored). */
  ignored: boolean;
}

export interface DiffInfo {
  base: string; // resolved base commit sha (merge-base when scoring a branch)
  head: string; // resolved head commit sha
  files: ChangedFile[];
  author?: { name: string; email: string };
  title?: string; // commit subject or PR title (untrusted)
  description?: string; // PR body (untrusted; only used when llm.includeDescription)
}

/** One commit as seen by the history index. */
export interface CommitInfo {
  sha: string;
  parents: string[];
  authorName: string;
  authorEmail: string;
  /** Unix seconds (committer date: rebases and cherry-picks keep old author dates). */
  time: number;
  subject: string;
  /** Changed paths (post-rename names). */
  files: string[];
  isFix: boolean; // subject matches history.fixPattern
  isRevert: boolean;
  /** sha named in "This reverts commit <sha>", when present. */
  revertsSha?: string;
}

/**
 * Point-in-time view of repository history. All queries only see commits with
 * time < `asOf` (unix seconds) when `asOf` is given, so backtests do not leak the future.
 */
export interface HistoryIndex {
  commits: CommitInfo[]; // newest first
  fileCommits(path: string, asOf?: number): CommitInfo[];
  /** Email of the author of the commit that added `path`, if known before asOf. */
  fileCreator(path: string, asOf?: number): string | undefined;
  authorCommitCount(email: string, asOf?: number): number;
}

export interface Incident {
  inducing?: string; // sha of the change that caused it (strongest label)
  fix?: string; // sha of the change that fixed it (blamed via SZZ)
  paths?: string[]; // files/folders implicated
  note?: string;
}

/** Reverse dependency graph over repo files. */
export interface DependencyGraph {
  /** Files that import `path` directly. */
  dependentsOf(path: string): string[];
  /** BFS over dependents up to maxDepth; excludes `path` itself. */
  transitiveDependents(path: string, maxDepth: number): Set<string>;
  /** True when the file's language has an import extractor. */
  supports(path: string): boolean;
  fileCount: number;
}

export interface LlmJudgement {
  /** Probability in [0,1] that the change causes an incident. */
  risk: number;
  rationale: string;
  riskySnippets: Array<{ file: string; line?: number; reason: string }>;
}

export interface LlmProvider {
  name: string;
  judge(input: { title?: string; description?: string; diff: string; files: string[] }): Promise<LlmJudgement>;
}

export interface ScoringContext {
  repoDir: string;
  diff: DiffInfo;
  config: import("./config.js").OpendrsConfig;
  history: HistoryIndex;
  /** Absent when graph build failed or was disabled; blast signals then report `unknown`. */
  graph?: DependencyGraph;
  /** Result of the optional LLM judge, run once by the engine before signals. */
  llm?: { judgement?: LlmJudgement; error?: string };
  /** Point-in-time cutoff (unix seconds) used by backtests; undefined = now. */
  asOf?: number;
  /**
   * What the engine could verify. `authorVerified: false` (CI could not tie the head commit's
   * author email to the PR's account) and `historyComplete: false` (shallow clone) make the
   * signals that depend on them report `unknown` instead of a reassuring value.
   */
  trust: { authorVerified: boolean; historyComplete: boolean };
  /** Read a file's contents at base (undefined when the file did not exist). */
  readBase(path: string): Promise<string | undefined>;
  /** Read a file's contents at head (undefined when deleted). */
  readHead(path: string): Promise<string | undefined>;
}

export type SignalProvider = (ctx: ScoringContext) => Promise<Signal[]>;

export interface ModelWeights {
  version: 1;
  intercept: number;
  weights: Record<string, number>;
  /** Neutral value used for a feature whose signal is missing. Default 0. */
  priors?: Record<string, number>;
  /** Present after calibration: score percentiles of history (keys "50","90",...). */
  percentiles?: Record<string, number>;
  trainedOn?: { repo?: string; commits: number; positives: number; from: string; to: string };
  metrics?: BacktestMetrics;
}

export interface Contribution {
  id: string;
  value: number;
  weight: number;
  /** weight * value: this signal's push on the logit. */
  contribution: number;
}

export type Tier = "green" | "yellow" | "red";

export type Decision = "auto-approve" | "waiting-ai-review" | "human-review";

export interface PolicyOutcome {
  tier: Tier;
  decision: Decision;
  /** Why the decision was made, one entry per rule that fired (first is decisive). */
  reasons: string[];
  hardBlocked: boolean;
  sampled: boolean;
  mergeMethod: "queue" | "auto-merge" | "none";
  suggestedReviewers: string[];
}

export interface ScoreResult {
  score: number; // [0,1]
  tier: Tier;
  signals: Signal[];
  contributions: Contribution[]; // sorted by |contribution| desc
  unknowns: string[]; // ids of signals with status "unknown"
  policy: PolicyOutcome;
  llm?: LlmJudgement;
  diff: { base: string; head: string; files: number; added: number; deleted: number };
  model: "default" | "calibrated";
  version: string;
}

export interface BacktestMetrics {
  commits: number;
  positives: number;
  baseRate: number;
  /** Share of positives captured when gating the top X% riskiest commits. Keys "5","10","50". */
  capturedAt: Record<string, number>;
  auc: number;
}

/** Labelled commit for calibration/backtest. */
export interface LabelledCommit {
  sha: string;
  label: 0 | 1;
  /** Why it is positive: "revert" | "szz" | "incident". */
  source?: "revert" | "szz" | "incident";
}

/** Engine-level error with a user-printable message. */
export class OpendrsError extends Error {
  constructor(
    message: string,
    readonly code: "git" | "config" | "llm" | "io" | "usage",
  ) {
    super(message);
    this.name = "OpendrsError";
  }
}
