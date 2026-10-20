import { detectArchitecture } from "../architecture/index.js";
import { captainPriority } from "../architecture/priority.js";
import type { ArchitectureFact, CaptainBrief, Incident, PolicyRule, ReviewBrief, ScoreResult, ScoringContext } from "../domain/types.js";
import { gitMaybe } from "../git/exec.js";
import { matchAny } from "../git/glob.js";
import { INCIDENTS_FILE, parseIncidents } from "../model/label.js";
import { untrusted } from "../report/escape.js";
import { blameFixes } from "./blame.js";
import { fitBudget } from "./budget.js";
import { needsHuman } from "./human.js";
import { checkQuestions } from "./questions.js";
import { candidateHunks, rankHunks } from "./rank.js";
import { skimList, skimmablePaths } from "./skim.js";

const DEFAULT_MAX_TOKENS = 2_500;
const HARD_CEILING = 6_000;
const MAX_FILES = 8;
const MAX_HUNKS_PER_FILE = 3;
const MAX_BLAME_CANDIDATES = 24;

export interface BuildBriefOptions {
  /** Token budget for the rendered Markdown; default 2500, clamped to 6000. */
  maxTokens?: number;
  /** False ignores the judge's per-hunk verdicts even when it ran. */
  llm?: boolean;
  /** The head of opendrs's first run on this PR, for the drift detector (spec §6.4; Action only). */
  firstHead?: string;
  /** That first run's number, for an old marker's "since run k" phrasing. */
  firstRun?: number;
}

const MAX_WHY_CHARS = 100;

/**
 * The index of the first sentence boundary (`.` or `;`) outside any backtick-quoted code span -
 * followed by a space, or at the very end of the text - or undefined if there is none. `code()`
 * (src/report/escape.ts) never leaves a literal backtick inside a span's content, so a simple
 * backtick toggle reliably tracks whether a position is inside one.
 */
function sentenceBoundary(text: string): number | undefined {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "`") {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    if ((ch === "." || ch === ";") && (i === text.length - 1 || text[i + 1] === " ")) return i;
  }
  return undefined;
}

/** A short, fact-type-based summary used when a fact's own text can't be safely shortened. */
function fallbackWhy(fact: ArchitectureFact): string {
  const spans = [...fact.text.matchAll(/`([^`]*)`/g)].map((m) => m[1]!);
  switch (fact.id) {
    case "layers.edge":
      return spans.length >= 2 ? `new import edge ${spans[0]} → ${spans[1]}` : `new import edge in ${fact.file}`;
    case "layers.cycle":
      return spans.length >= 2 ? `new import cycle ${spans.join(" → ")}` : `new import cycle in ${fact.file}`;
    case "contract.api":
      return spans.length >= 1 ? `exported API change: ${spans[0]}` : `exported API change in ${fact.file}`;
    case "contract.dependency":
      return spans.length >= 1 ? `new dependency ${spans[0]}` : `dependency change in ${fact.file}`;
    case "contract.schema":
      return `schema/contract file changed: ${fact.file}`;
    case "contract.env":
      return spans.length >= 1 ? `new env var ${spans[0]}` : `new environment variable in ${fact.file}`;
    case "coupling.missing":
      return `missing historical co-change partner for ${fact.file}`;
    case "drift.scope":
      return `review scope drifted for ${fact.file}`;
    default:
      return `change in ${fact.file}`;
  }
}

/**
 * Spec §6.5: a short one-line summary of a fact's text for the captain "why" line. Never cuts inside
 * a backtick-quoted code span (which usually holds a file path or identifier with dots of its own),
 * and only splits at a real sentence boundary. Falls back to a short, fact-type-based summary when
 * the result would be empty or too long to read as a one-liner.
 */
export function shortenWhy(fact: ArchitectureFact): string {
  const boundary = sentenceBoundary(fact.text);
  const candidate = (boundary === undefined ? fact.text : fact.text.slice(0, boundary)).trim();
  if (candidate.length > 0 && candidate.length <= MAX_WHY_CHARS) return candidate;
  return fallbackWhy(fact);
}

/** Spec §5, §7.1: run the architecture detectors and turn tier, facts and the fired gate rules into the captain brief. */
async function buildCaptain(result: ScoreResult, ctx: ScoringContext, opts: { firstHead?: string; firstRun?: number }): Promise<CaptainBrief> {
  const { facts, notes } = await detectArchitecture(ctx, { firstHead: opts.firstHead, firstRun: opts.firstRun });
  const criticalTouched = ctx.diff.files.some((f) => matchAny(ctx.config.paths.critical, f.path));
  const firedRules: PolicyRule[] = (result.policy.rules ?? []).map((r) => r.rule);
  const priority = captainPriority({ tier: result.tier, facts, firedRules, criticalTouched });
  const why = facts.slice(0, 2).map((f: ArchitectureFact) => shortenWhy(f));
  return { priority, why, facts, notes };
}

/** Spec §4: rank hunks (blame on the top candidates), build questions, skim list and hard rules, then fit the budget. */
export async function buildBrief(result: ScoreResult, ctx: ScoringContext, options: BuildBriefOptions = {}): Promise<ReviewBrief> {
  const candidates = candidateHunks(ctx);
  const prelim = rankHunks(ctx, result, new Map(), { llm: options.llm });
  const topIds = new Set(
    prelim
      .flatMap((f) => f.hunks)
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, MAX_BLAME_CANDIDATES)
      .map((h) => h.id),
  );
  const { hits, notes } = await blameFixes(ctx, candidates.filter((c) => topIds.has(c.id)));
  const ranked = rankHunks(ctx, result, hits, { llm: options.llm });

  // Spec §5.6: a skim-listed file (docs, comment-only, test-only or ignored) never outranks a real
  // code change, so it is dropped from the candidate pool whenever one exists. Only a skim-only PR
  // (every ranked file is skim-listed) falls back to ranking the skim files themselves, and that
  // scope is recorded so the rendering can say so explicitly instead of looking like a ranked PR.
  const skimPaths = skimmablePaths(ctx);
  const codeRanked = ranked.filter((f) => !skimPaths.has(f.file));
  const reviewFirstScope: NonNullable<ReviewBrief["reviewFirstScope"]> = codeRanked.length > 0 || ranked.length === 0 ? "code" : "skim-only";
  const pool = reviewFirstScope === "code" ? codeRanked : ranked;

  // The top hunks of a file by score, shown in diff order (spec §6.2: hunks within a file keep diff order).
  const shown = pool.slice(0, MAX_FILES).map((f) => ({
    ...f,
    hunks: [...f.hunks]
      .sort((a, b) => b.score - a.score || a.id - b.id)
      .slice(0, MAX_HUNKS_PER_FILE)
      .sort((a, b) => a.id - b.id),
  }));
  const totalHunks = pool.reduce((n, f) => n + f.hunks.length, 0);
  const shownHunks = shown.reduce((n, f) => n + f.hunks.length, 0);

  // From the base commit, like the Action's config and model: the PR must not write its own incidents.
  let incidents: Incident[] = [];
  try {
    const text = await gitMaybe(ctx.repoDir, ["show", `${ctx.diff.base}:${INCIDENTS_FILE}`]);
    if (text !== undefined) incidents = parseIncidents(text);
  } catch (e) {
    notes.push(`could not read ${INCIDENTS_FILE}: ${untrusted((e as Error).message)}`);
  }
  if (!ctx.trust.historyComplete) notes.push("history is incomplete (shallow clone): blame and fix counts are lower bounds");

  const captain = ctx.config.captain.enabled ? await buildCaptain(result, ctx, options) : undefined;

  const maxTokens = Math.min(options.maxTokens ?? DEFAULT_MAX_TOKENS, HARD_CEILING);
  return fitBudget(
    {
      version: 1,
      verdict: verdictOf(result),
      reviewFirstScope,
      reviewFirst: shown.map((f) => ({
        file: f.file,
        reasons: f.reasons,
        hunks: f.hunks.map((h) => ({ id: h.id, oldStart: h.oldStart, newStart: h.newStart, newLines: h.newLines, score: h.score, reasons: h.reasons })),
      })),
      checks: checkQuestions(shown, ctx, incidents),
      skim: skimList(ctx, new Set(shown.map((f) => f.file))),
      human: needsHuman(result.policy),
      notRanked: { hunks: totalHunks - shownHunks, files: pool.length - shown.length },
      budget: { maxTokens, estimatedTokens: 0, truncated: false, omitted: { files: 0, hunks: 0, checks: 0, notes: 0 } },
      notes,
      captain,
    },
    maxTokens,
  );
}

/** Spec §5.1: the first hard rule when one fired, else the top non-zero contribution's summary, else the decisive policy line. */
function verdictOf(result: ScoreResult): ReviewBrief["verdict"] {
  const top = result.contributions.find((c) => c.contribution !== 0);
  const why =
    result.policy.hardBlocked && result.policy.rules?.[0]
      ? result.policy.rules[0].reason
      : (top && result.signals.find((s) => s.id === top.id)?.summary) || result.policy.reasons[0] || "";
  return { tier: result.tier, score: result.score, decision: result.policy.decision, why };
}
