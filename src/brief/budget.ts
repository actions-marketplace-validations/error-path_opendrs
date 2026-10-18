import type { ReviewBrief } from "../domain/types.js";
import { renderBriefMarkdown } from "./render.js";

const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/**
 * Trim the brief to `maxTokens` of rendered Markdown in spec §6.2's fill order: verdict, needs a
 * human and not ranked are fixed; then review-first (file by file, hunk by hunk), checks, skim.
 * Each candidate is measured by rendering it, so `estimatedTokens` is the real rendered size.
 */
export function fitBudget(brief: ReviewBrief, maxTokens: number): ReviewBrief {
  const first = fill(brief, maxTokens, false);
  // Something was cut, so the footer line is part of the output: refill with its room reserved.
  return first.budget.truncated ? fill(brief, maxTokens, true) : first;
}

function fill(brief: ReviewBrief, maxTokens: number, reserveFooter: boolean): ReviewBrief {
  const omitted = { files: 0, hunks: 0, checks: 0 };
  // The footer at its longest possible counts, so the final one is never larger than what was reserved.
  const footer = { files: brief.reviewFirst.length, hunks: brief.reviewFirst.reduce((n, f) => n + f.hunks.length, 0), checks: brief.checks.length };
  const emptySkim: ReviewBrief["skim"] = Array.isArray(brief.skim) ? [] : { counts: {} };
  let cur: ReviewBrief = {
    ...brief,
    reviewFirst: [],
    checks: [],
    skim: emptySkim,
    budget: { maxTokens, estimatedTokens: 0, truncated: reserveFooter, omitted: reserveFooter ? footer : omitted },
  };
  const tryAdd = (next: ReviewBrief): boolean => {
    if (estimateTokens(renderBriefMarkdown(next)) > maxTokens) return false;
    cur = next;
    return true;
  };

  for (const f of brief.reviewFirst) {
    if (!tryAdd({ ...cur, reviewFirst: [...cur.reviewFirst, { ...f, hunks: [] }] })) {
      omitted.files++;
      omitted.hunks += f.hunks.length;
      continue;
    }
    for (const h of f.hunks) {
      const last = cur.reviewFirst.at(-1)!;
      if (!tryAdd({ ...cur, reviewFirst: [...cur.reviewFirst.slice(0, -1), { ...last, hunks: [...last.hunks, h] }] })) omitted.hunks++;
    }
  }
  for (const c of brief.checks) if (!tryAdd({ ...cur, checks: [...cur.checks, c] })) omitted.checks++;
  tryAdd({ ...cur, skim: brief.skim });

  const truncated = omitted.files > 0 || omitted.hunks > 0 || omitted.checks > 0;
  const out: ReviewBrief = { ...cur, budget: { maxTokens, estimatedTokens: 0, truncated, omitted } };
  return { ...out, budget: { ...out.budget, estimatedTokens: estimateTokens(renderBriefMarkdown(out)) } };
}
