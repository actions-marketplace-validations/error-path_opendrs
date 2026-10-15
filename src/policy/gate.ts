import { createHash } from "node:crypto";
import { matchGlob } from "../git/glob.js";
import type { HistoryIndex, ModelWeights, PolicyOutcome, Signal, DiffInfo, Contribution, Tier, Decision } from "../domain/types.js";
import { defaultConfig, type OpendrsConfig } from "../domain/config.js";
import { featureValues, sigmoid } from "../model/logistic.js";
import { suggestReviewers } from "./reviewers.js";

export interface GateInput {
  score: number;
  logit: number;
  signals: Signal[];
  contributions: Contribution[];
  diff: DiffInfo;
  config: OpendrsConfig;
  model: ModelWeights;
  history: HistoryIndex;
  /** Present in CI: what the PR currently has. Absent locally (AI-review rule then reports "unknown"). */
  pr?: { labels: string[]; successfulChecks: string[]; number?: number; samplingKey?: string };
  llmFailed: boolean;
}

/**
 * Plausible [low, high] feature values (~10th/90th percentile of real diffs). Rule 4 asks whether
 * the unknown signals, all at the riskier end of their ranges at once, would change the tier.
 */
const PLAUSIBLE_RANGE: Record<string, [number, number]> = {
  "size.churn": [0, Math.log1p(1000)],
  "size.relative": [0, Math.log1p(1)],
  "size.new_files_only": [0, 1],
  "diffusion.files": [Math.log1p(1), Math.log1p(20)],
  "diffusion.dirs": [Math.log1p(1), Math.log1p(8)],
  "diffusion.authors": [0, Math.log1p(20)],
  "history.prior_fixes": [0, Math.log1p(10)],
  "history.incident": [0, 1],
  "history.churn": [0, Math.log1p(100)],
  "expertise.author_commits": [0, Math.log1p(1000)],
  "expertise.owner_ratio": [0, 1],
  "complexity.touched": [0, Math.log1p(300)],
  "blast.dependents": [0, Math.log1p(200)],
  "blast.public_surface": [0, 1],
  "paths.critical": [0, 1],
  "paths.blocked": [0, 1],
  "tests.missing": [0, 1],
  "llm.semantic": [0, Math.log(0.9 / 0.1) - Math.log(0.2 / 0.8)],
};

const rangeOf = (id: string): [number, number] | undefined => PLAUSIBLE_RANGE[id] ?? (id.startsWith("lang.") ? [0, 1] : undefined);

interface Thresholds {
  green: number;
  yellow: number;
  red: number;
}

/** Deterministic uniform value in [0,1) from the head sha (48 bits of sha256). */
export function sampleValue(head: string): number {
  return createHash("sha256").update(head).digest().readUIntBE(0, 6) / 2 ** 48;
}

/** Spec §6 decision order. Pure and deterministic (sampling is hashed from diff.head). */
export function decide(input: GateInput): PolicyOutcome {
  const { config, diff, model } = input;
  const auto = config.autoApprove;
  const notes: string[] = [];
  const thresholds = resolveThresholds(config, model, notes);
  const tier = tierOf(input.score, thresholds);
  const fired: Array<{ decision: Decision; reason: string }> = [];

  // 1. hard block
  const blocked = diff.files
    .filter((f) => [f.path, f.oldPath].some((p) => p !== undefined && config.paths.block.some((g) => matchGlob(g, p))))
    .map((f) => f.path);
  const blockedSignal = input.signals.find((s) => s.id === "paths.blocked" && s.value >= 1);
  const hardBlocked = blocked.length > 0 || blockedSignal !== undefined;
  if (hardBlocked) {
    const what = blocked.length > 0 ? `${list(blocked)} ${blocked.length === 1 ? "matches" : "match"} paths.block` : blockedSignal!.summary;
    fired.push({ decision: "human-review", reason: `hard block: ${what}` });
  }

  // 1b. ignored or binary files: scored as low risk, but nothing reads their contents, so a human must
  const unread = diff.files.filter((f) => f.ignored || f.binary).map((f) => f.path);
  if (unread.length > 0) {
    fired.push({ decision: "human-review", reason: `ignored or binary files are never auto-approved: ${list(unread)}` });
  }
  // A moved submodule pointer pulls in code the diff does not show.
  const submodules = diff.files.filter((f) => f.submodule).map((f) => f.path);
  if (submodules.length > 0) {
    fired.push({ decision: "human-review", reason: `submodule changes are never auto-approved: ${list(submodules)}` });
  }

  // 2. size cap (a binary file counts as one line)
  const changedLines = diff.files.filter((f) => !f.ignored).reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);
  if (changedLines > auto.maxChangedLines) {
    fired.push({ decision: "human-review", reason: `${changedLines} changed lines exceeds autoApprove.maxChangedLines (${auto.maxChangedLines})` });
  }

  // 3. tier
  if (tier !== "green") {
    fired.push({
      decision: "human-review",
      reason: `tier ${tier}: score ${input.score.toFixed(2)} ≥ green threshold ${thresholds.green.toFixed(2)}`,
    });
  }

  // 4. LLM failure, or an unknown whose plausible worst case changes the tier
  if (input.llmFailed) fired.push({ decision: "human-review", reason: "LLM judge failed; its absence counts as risk" });
  // Unknowns can all be wrong at once, so their worst cases are summed before checking the tier.
  const used = featureValues(input.signals, model.priors);
  const lifts: Array<{ id: string; lift: number }> = [];
  for (const s of input.signals) {
    const weight = model.weights[s.id] ?? 0;
    if (s.status !== "unknown" || weight === 0) continue;
    const range = rangeOf(s.id);
    if (!range) {
      fired.push({ decision: "human-review", reason: `unknown ${s.id} has no known plausible range; treated as risk` });
      continue;
    }
    const value = used.get(s.id)!;
    const lift = Math.max(0, weight * (range[0] - value), weight * (range[1] - value));
    if (lift > 0) lifts.push({ id: s.id, lift });
  }
  const worst = sigmoid(input.logit + lifts.reduce((n, l) => n + l.lift, 0));
  const worstTier = tierOf(worst, thresholds);
  if (worstTier !== tier) {
    const alone = lifts
      .sort((a, b) => b.lift - a.lift)
      .map((l) => `${l.id} → ${sigmoid(input.logit + l.lift).toFixed(2)}`)
      .join(", ");
    const reason =
      lifts.length === 1
        ? `unknown ${lifts[0]!.id} could raise the score to ${worst.toFixed(2)} (${worstTier})`
        : `unknown signals could together raise the score to ${worst.toFixed(2)} (${worstTier}); alone: ${alone}`;
    fired.push({ decision: "human-review", reason });
  }

  // 5. AI review
  const { checks, labels } = auto.requireAiReview;
  if (checks.length + labels.length > 0) {
    if (!input.pr) {
      fired.push({ decision: "waiting-ai-review", reason: `AI review status unknown outside CI (requires ${requirement(checks, labels)})` });
    } else {
      const missingChecks = checks.filter((c) => !input.pr!.successfulChecks.includes(c));
      const missingLabels = labels.filter((l) => !input.pr!.labels.includes(l));
      if (missingChecks.length + missingLabels.length > 0) {
        fired.push({ decision: "waiting-ai-review", reason: `AI review pending: missing ${requirement(missingChecks, missingLabels)}` });
      }
    }
  }

  // 6. drift sample
  const sampled = sampleValue(input.pr?.samplingKey ?? diff.head) < auto.sampleRate;
  if (sampled) fired.push({ decision: "human-review", reason: `sampled for human review (${Math.round(auto.sampleRate * 100)}% drift check)` });

  // 7. auto-approve
  const decision = fired[0]?.decision ?? "auto-approve";
  if (decision === "auto-approve") {
    fired.push({
      decision,
      reason: `auto-approve: score ${input.score.toFixed(2)} < green ${thresholds.green.toFixed(2)} and every gate passed (merge: ${auto.mergeMethod})`,
    });
    if (!auto.enabled) notes.push("dry run: autoApprove.enabled=false");
  }

  return {
    tier,
    decision,
    reasons: [...fired.map((f) => f.reason), ...notes],
    hardBlocked,
    sampled,
    mergeMethod: decision === "auto-approve" ? auto.mergeMethod : "none",
    suggestedReviewers: suggestReviewers(
      input.history,
      diff.files.filter((f) => !f.ignored).map((f) => f.path),
      diff.author?.email,
    ),
  };
}

/**
 * Three tiers from three numbers: below `green` is green, at or above `red` is red, the rest is
 * yellow. `yellow` has no boundary of its own in a three-tier scheme (see report).
 */
function tierOf(score: number, t: Thresholds): Tier {
  if (score < t.green) return "green";
  return score >= t.red ? "red" : "yellow";
}

function resolveThresholds(config: OpendrsConfig, model: ModelWeights, notes: string[]): Thresholds {
  const t = config.thresholds;
  if (t.mode === "absolute") return t;
  const mapped = [t.green, t.yellow, t.red].map((p) => percentileScore(model.percentiles, p));
  if (mapped.every((v) => v !== undefined)) return { green: mapped[0]!, yellow: mapped[1]!, red: mapped[2]! };
  const d = defaultConfig().thresholds;
  notes.push(
    `percentile thresholds need a calibrated model with history percentiles covering ${t.green}/${t.yellow}/${t.red}; ` +
      `using absolute defaults ${d.green}/${d.yellow}/${d.red}`,
  );
  return d;
}

/** Score at percentile p, interpolating linearly between the model's recorded percentiles. */
function percentileScore(table: Record<string, number> | undefined, p: number): number | undefined {
  if (!table) return undefined;
  const points = Object.entries(table)
    .map(([k, v]) => [Number(k), v] as const)
    .sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < points.length; i++) {
    const [pk, vk] = points[i]!;
    if (pk === p) return vk;
    const prev = points[i - 1];
    if (prev && prev[0] < p && p < pk) return prev[1] + ((vk - prev[1]) * (p - prev[0])) / (pk - prev[0]);
  }
  return undefined;
}

const list = (paths: string[]) => (paths.length > 3 ? `${paths.slice(0, 3).join(", ")} (+${paths.length - 3} more)` : paths.join(", "));

function requirement(checks: string[], labels: string[]): string {
  return [checks.length ? `check ${checks.join(", ")}` : "", labels.length ? `label ${labels.join(", ")}` : ""].filter(Boolean).join("; ");
}
