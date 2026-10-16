import { createHash } from "node:crypto";
import { changedLines } from "../git/diff.js";
import { matchAny } from "../git/glob.js";
import type { Authorship, HistoryIndex, LlmJudgement, ModelWeights, PolicyOutcome, Signal, DiffInfo, Contribution, Tier, Decision } from "../domain/types.js";
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
  pr?: {
    successfulChecks: string[];
    number?: number;
    samplingKey?: string;
    draft?: boolean;
    /** Reviewers whose latest approve/request-changes/dismissal requests changes. */
    changesRequestedBy?: string[];
  };
  llmFailed: boolean;
  /** The judge's verdict when it ran and parsed; read only when llm.requireSafe is on. */
  llm?: LlmJudgement;
  /** Epoch ms the freeze windows and source history are checked against. Default: Date.now(). */
  now?: number;
  /** Who wrote the PR (policy/source.ts). Absent: no per-source rule applies. */
  source?: Authorship;
  /** Shas of the PR's own commits (base..head), which dailyCap and trackRecord do not count as landed. */
  prCommits?: string[];
}

const DAY_MS = 86_400_000;

/**
 * Plausible [low, high] feature values (~10th/90th percentile of real diffs). Rule 4 asks whether
 * the unknown signals, all at the riskier end of their ranges at once, would change the tier.
 */
const PLAUSIBLE_RANGE: Record<string, [number, number]> = {
  "size.churn": [0, Math.log1p(1000)],
  "size.relative": [0, Math.log1p(1)],
  "size.new_files_only": [0, 1],
  "size.comment_only": [0, 1],
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

const rangeOf = (id: string): [number, number] | undefined =>
  PLAUSIBLE_RANGE[id] ?? (id.startsWith("lang.") || id.startsWith("llm.risk.") ? [0, 1] : undefined);

interface Thresholds {
  green: number;
  yellow: number;
  red: number;
}

/** Deterministic uniform value in [0,1) from the head sha (48 bits of sha256). */
export function sampleValue(head: string): number {
  return createHash("sha256").update(head).digest().readUIntBE(0, 6) / 2 ** 48;
}

/** Spec §6 decision order. Pure and deterministic given `now` (sampling is hashed from diff.head). */
export function decide(input: GateInput): PolicyOutcome {
  const { config, diff, model } = input;
  const auto = config.autoApprove;
  const notes: string[] = [];
  const thresholds = resolveThresholds(config, model, notes);
  const tier = tierOf(input.score, thresholds);
  const fired: Array<{ decision: Decision; reason: string }> = [];

  // 1. hard block
  const blocked = diff.files
    .filter((f) => [f.path, f.oldPath].some((p) => p !== undefined && matchAny(config.paths.block, p, { ignoreCase: true })))
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
  // Control characters in a path are never legitimate and are how log and glob tricks start.
  const oddPaths = diff.files.flatMap((f) => [f.path, f.oldPath ?? ""]).filter((p) => /[\u0000-\u001f\u007f]/.test(p));
  if (oddPaths.length > 0) {
    fired.push({ decision: "human-review", reason: `paths with control characters are never auto-approved: ${list(oddPaths.map((p) => JSON.stringify(p)))}` });
  }
  // A moved submodule pointer pulls in code the diff does not show.
  const submodules = diff.files.filter((f) => f.submodule).map((f) => f.path);
  if (submodules.length > 0) {
    fired.push({ decision: "human-review", reason: `submodule changes are never auto-approved: ${list(submodules)}` });
  }
  // Removing tests removes the evidence a change is safe, and a calibrated model may not weigh it.
  const testsDeleted = input.signals.find((s) => s.id === "tests.deleted" && s.value >= 1);
  if (testsDeleted) fired.push({ decision: "human-review", reason: `test deletion: ${testsDeleted.summary}` });
  // Blocklisted code phrases on added lines (Meta's RADAR never auto-lands these).
  for (const [pattern, hits] of contentHits(diff, config.content.block)) {
    fired.push({ decision: "human-review", reason: `content.block /${pattern}/ matched ${list(hits)}` });
  }

  // 2. size cap (a binary file counts as one line)
  const changedLines = diff.files.filter((f) => !f.ignored).reduce((n, f) => n + (f.binary ? 1 : f.added + f.deleted), 0);
  if (changedLines > auto.maxChangedLines) {
    fired.push({ decision: "human-review", reason: `${changedLines} changed lines exceeds autoApprove.maxChangedLines (${auto.maxChangedLines})` });
  }

  // Commit text can raise the kind (a trailer makes it "agent") but never lower it, so the policy of
  // the trusted floor (the account type in CI, else human) applies as well.
  const kinds = input.source ? [...new Set([input.source.floor ?? "human", input.source.kind])] : [];

  // 3. tier, unless the PR is deferrable (RADAR's deferred review): in [green, below) with every
  // applicable source kind opted in, it lands now and a human reviews it after merge. Only this rule
  // is relaxed; every other rule still applies.
  const deferredReview = auto.deferredReview;
  const deferredBelow =
    deferredReview.enabled && deferredReview.below !== undefined
      ? config.thresholds.mode === "absolute"
        ? deferredReview.below
        : percentileScore(model.percentiles, deferredReview.below)
      : undefined;
  const deferrable =
    deferredBelow !== undefined &&
    input.score >= thresholds.green &&
    input.score < deferredBelow &&
    (kinds.length > 0 ? kinds : ["human" as const]).every((k) => deferredReview.sources.includes(k));
  if (tier !== "green" && !deferrable) {
    fired.push({
      decision: "human-review",
      reason: `tier ${tier}: score ${input.score.toFixed(2)} ≥ green threshold ${thresholds.green.toFixed(2)}`,
    });
  }

  // 3b. freeze windows: suspend auto-approval, or hold it to a stricter green; the tier stays
  const now = input.now ?? Date.now();
  for (const f of config.freezes.filter((w) => freezeActive(w, now))) {
    if (f.green === undefined) {
      fired.push({ decision: "human-review", reason: `freeze "${f.name}": auto-approval suspended` });
      continue;
    }
    const green = config.thresholds.mode === "absolute" ? f.green : percentileScore(model.percentiles, f.green);
    if (green === undefined) {
      fired.push({
        decision: "human-review",
        reason: `freeze "${f.name}": percentile green ${f.green} needs a calibrated model; auto-approval suspended`,
      });
    } else if (input.score >= green) {
      fired.push({ decision: "human-review", reason: `freeze "${f.name}": score ${input.score.toFixed(2)} ≥ freeze green ${green.toFixed(2)}` });
    }
  }

  // 3c. per-source policy (RADAR §2.5): the source's own stricter green, daily landing cap and track
  // record. Each only tightens; with no `sources` config or no classified source nothing changes.
  const inPr = new Set(input.prCommits ?? []);
  for (const kind of kinds) {
    const source = config.sources[kind];
    if (source.green !== undefined) {
      const green = config.thresholds.mode === "absolute" ? source.green : percentileScore(model.percentiles, source.green);
      if (green === undefined) {
        fired.push({
          decision: "human-review",
          reason: `source ${kind}: percentile green ${source.green} needs a calibrated model; auto-approval suspended`,
        });
      } else if (input.score >= green) {
        fired.push({ decision: "human-review", reason: `source ${kind}: score ${input.score.toFixed(2)} ≥ source green ${green.toFixed(2)}` });
      }
    }
    // Landed commits of this source in the last `ms`: in the index, at or before now, not in this PR.
    const landed = (ms: number) =>
      input.history.commits.filter((c) => c.source === kind && !inPr.has(c.sha) && c.time * 1000 > now - ms && c.time * 1000 <= now);
    if (source.dailyCap !== undefined) {
      const n = landed(DAY_MS).length;
      if (n >= source.dailyCap) fired.push({ decision: "human-review", reason: `source ${kind}: daily cap reached (${n} landed in 24h)` });
    }
    if (source.trackRecord) {
      const { days, minCommits, maxRevertRate } = source.trackRecord;
      const recent = landed(days * DAY_MS);
      if (recent.length < minCommits) {
        fired.push({ decision: "human-review", reason: `source ${kind}: track record too short (${recent.length} of ${minCommits} landed commits in ${days} days)` });
      } else if (recent.length > 0) {
        // A revert names its target by a possibly abbreviated sha; shorter than 7 chars is not a reference.
        const reverted = input.history.commits.map((c) => c.revertsSha).filter((s): s is string => s !== undefined && s.length >= 7);
        const n = recent.filter((c) => reverted.some((s) => c.sha.startsWith(s))).length;
        const rate = n / recent.length;
        if (rate > maxRevertRate) {
          const pct = (x: number) => `${Math.round(x * 100)}%`;
          fired.push({
            decision: "human-review",
            reason: `source ${kind}: ${n} of ${recent.length} landed commits in ${days} days reverted (${pct(rate)}) > ${pct(maxRevertRate)}`,
          });
        }
      }
    }
  }

  // 4. LLM failure, or an unknown whose plausible worst case changes the tier
  if (input.llmFailed) fired.push({ decision: "human-review", reason: "LLM judge failed; its absence counts as risk" });
  // 4a. requireSafe (RADAR §2.8): every hunk the judge saw must be in a safe category at or above
  // minConfidence, and it must have seen and classified all of them. The judge can only block here.
  // A source's own requireSafe (3c) turns the same rule on for that source.
  const safeKind = kinds.find((k) => config.sources[k].requireSafe);
  const requireSafe = config.llm.requireSafe ? "llm.requireSafe" : safeKind ? `sources.${safeKind}.requireSafe` : undefined;
  if (requireSafe && !input.llm && !input.llmFailed) {
    fired.push({ decision: "human-review", reason: `LLM judge did not run; ${requireSafe} needs its verdict` });
  }
  if (requireSafe && input.llm) {
    const { truncated, unclassified, hunks } = input.llm;
    if (truncated) fired.push({ decision: "human-review", reason: "LLM judge saw a truncated diff" });
    if (unclassified.length > 0) {
      const where = unclassified.map((h) => `${h.file}:${h.line}`);
      fired.push({ decision: "human-review", reason: `LLM judge did not classify ${unclassified.length} ${unclassified.length === 1 ? "hunk" : "hunks"}: ${list(where)}` });
    }
    const unsafe = hunks.filter((h) => !h.safe || h.confidence < config.llm.minConfidence);
    if (unsafe.length > 0) {
      const named = unsafe.slice(0, 3).map((h) => `${h.file}:${h.line} ${h.category} (confidence ${h.confidence})`);
      const rest = unsafe.length > 3 ? ` and ${unsafe.length - 3} more` : "";
      fired.push({ decision: "human-review", reason: `LLM judge: not all hunks safe: ${named.join(", ")}${rest}` });
    }
  }
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
  // A deferrable PR is held to its band the way a green one is held to its tier.
  if (worstTier !== tier || (deferrable && worst >= deferredBelow!)) {
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

  // 4b. PR state: a draft is work in progress, and a change request is an open objection
  if (input.pr?.draft) fired.push({ decision: "human-review", reason: "draft PR: never auto-approved while in draft" });
  const objectors = input.pr?.changesRequestedBy ?? [];
  if (objectors.length > 0) {
    fired.push({ decision: "human-review", reason: `changes requested by ${objectors.map((l) => `@${l}`).join(", ")}: never auto-approved until resolved` });
  }

  // 5. AI review: check runs on the head commit only (labels are not tied to a commit)
  const checks = auto.requireAiReview.checks.map((c) => (typeof c === "string" ? c : c.name));
  if (checks.length > 0) {
    if (!input.pr) {
      fired.push({ decision: "waiting-ai-review", reason: `AI review status unknown outside CI (requires check ${checks.join(", ")})` });
    } else {
      const missing = checks.filter((c) => !input.pr!.successfulChecks.includes(c));
      if (missing.length > 0) fired.push({ decision: "waiting-ai-review", reason: `AI review pending: missing check ${missing.join(", ")}` });
    }
  }

  // 6. drift sample
  const sampled = sampleValue(input.pr?.samplingKey ?? diff.head) < auto.sampleRate;
  if (sampled) fired.push({ decision: "human-review", reason: `sampled for human review (${Math.round(auto.sampleRate * 100)}% drift check)` });

  // 7. auto-approve, or deferred review when only the tier rule stood in the way
  const decision: Decision = fired[0]?.decision ?? (deferrable ? "deferred-review" : "auto-approve");
  const lands = decision === "auto-approve" || decision === "deferred-review";
  if (decision === "auto-approve") {
    fired.push({
      decision,
      reason: `auto-approve: score ${input.score.toFixed(2)} < green ${thresholds.green.toFixed(2)} and every gate passed (merge: ${auto.mergeMethod})`,
    });
  } else if (decision === "deferred-review") {
    fired.push({
      decision,
      reason: `deferred review: score ${input.score.toFixed(2)} is in the deferred band (${thresholds.green.toFixed(2)}–${deferredBelow!.toFixed(2)}); lands now, reviewed after merge`,
    });
  }
  if (lands && !auto.enabled) notes.push("dry run: autoApprove.enabled=false");

  return {
    tier,
    decision,
    reasons: [...fired.map((f) => f.reason), ...notes],
    hardBlocked,
    sampled,
    mergeMethod: lands ? auto.mergeMethod : "none",
    suggestedReviewers: suggestReviewers(
      input.history,
      diff.files.filter((f) => !f.ignored).map((f) => f.path),
      diff.author?.email,
    ),
    landingDelayMinutes: Math.max(auto.landingDelayMinutes, ...kinds.map((k) => config.sources[k].landingDelayMinutes ?? 0)),
  };
}

/** For each pattern that matches an added line of a non-binary file, its "path:line" locations (new side). */
function contentHits(diff: DiffInfo, patterns: string[]): Array<[string, string[]]> {
  const rules = patterns.map((p) => ({ p, re: new RegExp(p), hits: [] as string[] }));
  if (rules.length === 0) return [];
  for (const f of diff.files) {
    if (f.binary) continue;
    for (const h of f.hunks) {
      for (const { kind, line, text } of changedLines(h)) {
        if (kind === "+") for (const r of rules) if (r.re.test(text)) r.hits.push(`${f.path}:${line}`);
      }
    }
  }
  return rules.filter((r) => r.hits.length > 0).map((r) => [r.p, r.hits]);
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

/** Whether the local date at `now` in the window's timezone meets every condition the window sets. */
function freezeActive(f: OpendrsConfig["freezes"][number], now: number): boolean {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: f.timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  const day = part("weekday").toLowerCase();
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return (!f.days || f.days.some((d) => d === day)) && (!f.from || date >= f.from) && (!f.to || date <= f.to);
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
