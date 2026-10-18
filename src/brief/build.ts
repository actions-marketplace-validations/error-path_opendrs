import type { Incident, ReviewBrief, ScoreResult, ScoringContext } from "../domain/types.js";
import { gitMaybe } from "../git/exec.js";
import { INCIDENTS_FILE, parseIncidents } from "../model/label.js";
import { untrusted } from "../report/escape.js";
import { blameFixes } from "./blame.js";
import { fitBudget } from "./budget.js";
import { needsHuman } from "./human.js";
import { checkQuestions } from "./questions.js";
import { candidateHunks, rankHunks } from "./rank.js";
import { skimList } from "./skim.js";

const DEFAULT_MAX_TOKENS = 2_500;
const HARD_CEILING = 6_000;
const MAX_FILES = 8;
const MAX_HUNKS_PER_FILE = 3;
const MAX_BLAME_CANDIDATES = 24;

export interface BuildBriefOptions {
  /** Token budget for the rendered Markdown; default 2500, clamped to 6000. */
  maxTokens?: number;
  /** Unused today: every history lookup goes through ctx.asOf. Accepted so the engine can pass its clock without an interface change. */
  now?: number;
  /** False ignores the judge's per-hunk verdicts even when it ran. */
  llm?: boolean;
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

  const shown = ranked.slice(0, MAX_FILES).map((f) => ({ ...f, hunks: [...f.hunks].sort((a, b) => b.score - a.score || a.id - b.id).slice(0, MAX_HUNKS_PER_FILE) }));
  const totalHunks = ranked.reduce((n, f) => n + f.hunks.length, 0);
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

  const maxTokens = Math.min(options.maxTokens ?? DEFAULT_MAX_TOKENS, HARD_CEILING);
  return fitBudget(
    {
      version: 1,
      verdict: verdictOf(result),
      reviewFirst: shown.map((f) => ({
        file: f.file,
        reasons: f.reasons,
        hunks: f.hunks.map((h) => ({ id: h.id, oldStart: h.oldStart, newStart: h.newStart, newLines: h.newLines, score: h.score, reasons: h.reasons })),
      })),
      checks: checkQuestions(shown, ctx, incidents),
      skim: skimList(ctx),
      human: needsHuman(result.policy),
      notRanked: { hunks: totalHunks - shownHunks, files: ranked.length - shown.length },
      budget: { maxTokens, estimatedTokens: 0, truncated: false, omitted: { files: 0, hunks: 0, checks: 0 } },
      notes,
    },
    maxTokens,
  );
}

/** Spec §5.1: the first hard rule when one fired, else the top non-zero contribution's summary, else the decisive policy line. */
function verdictOf(result: ScoreResult): ReviewBrief["verdict"] {
  const top = result.contributions.find((c) => c.contribution !== 0);
  const why =
    result.policy.hardBlocked && result.policy.rules[0]
      ? result.policy.rules[0].reason
      : (top && result.signals.find((s) => s.id === top.id)?.summary) || result.policy.reasons[0] || "";
  return { tier: result.tier, score: result.score, decision: result.policy.decision, why };
}
