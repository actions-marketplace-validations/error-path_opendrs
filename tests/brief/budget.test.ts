import { describe, expect, it } from "vitest";
import { estimateTokens, fitBudget } from "../../src/brief/budget.js";
import { renderBriefMarkdown } from "../../src/brief/render.js";
import type { ReviewBrief } from "../../src/domain/types.js";

function bigBrief(): ReviewBrief {
  return {
    version: 1,
    verdict: { tier: "yellow", score: 0.4, decision: "human-review", why: "big diff" },
    reviewFirst: Array.from({ length: 8 }, (_, i) => ({
      file: `src/file${i}.ts`,
      reasons: [{ kind: "dependents" as const, text: `${i} files depend on it` }],
      hunks: Array.from({ length: 3 }, (_, j) => ({
        id: i * 3 + j + 1,
        oldStart: 1,
        newStart: j * 10 + 1,
        newLines: 5,
        score: 1,
        reasons: [{ kind: "fix-history" as const, text: "3 fix or revert commits in this file" }],
      })),
    })),
    checks: Array.from({ length: 6 }, (_, i) => ({ file: `src/file${i}.ts`, question: `Question number ${i} about this file, which is fairly long to cost real tokens.`, quotes: [], evidence: [] })),
    skim: [{ file: "docs/a.md", category: "docs" as const }],
    human: [{ rule: "paths.block", reason: "hard block: x matches paths.block" }],
    notRanked: { hunks: 2, files: 1 },
    budget: { maxTokens: 2500, estimatedTokens: 0, truncated: false, omitted: { files: 0, hunks: 0, checks: 0, notes: 0 } },
    notes: [],
  };
}

describe("estimateTokens", () => {
  it("is characters / 3.5, rounded up", () => {
    expect(estimateTokens("1234567")).toBe(2);
    expect(estimateTokens("12345678")).toBe(3);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("fitBudget", () => {
  it("keeps everything and reports no truncation when the budget is generous", () => {
    const out = fitBudget(bigBrief(), 6000);
    expect(out.budget).toEqual({ maxTokens: 6000, estimatedTokens: estimateTokens(renderBriefMarkdown(out)), truncated: false, omitted: { files: 0, hunks: 0, checks: 0, notes: 0 } });
    expect(out.reviewFirst).toEqual(bigBrief().reviewFirst);
    expect(out.checks).toHaveLength(6);
    expect(out.skim).toEqual(bigBrief().skim);
  });

  it("drops everything optional when the budget is tiny, keeping the verdict, human and not-ranked sections, and counts what it cut", () => {
    const out = fitBudget(bigBrief(), 40);
    expect(out.verdict).toEqual(bigBrief().verdict);
    expect(out.human).toEqual(bigBrief().human);
    expect(out.notRanked).toEqual(bigBrief().notRanked);
    expect(out.reviewFirst).toEqual([]);
    expect(out.checks).toEqual([]);
    expect(out.skim).toEqual([]);
    expect(out.budget).toMatchObject({ maxTokens: 40, truncated: true, omitted: { files: 8, hunks: 24, checks: 6 } });
  });

  it("fills review-first before checks and checks before skim, and its estimate matches the rendered size", () => {
    const tight = fitBudget(bigBrief(), 200);
    expect(tight.reviewFirst.length).toBeGreaterThan(0);
    expect(tight.reviewFirst.some((f) => f.hunks.length > 0)).toBe(true);
    expect(tight.checks).toEqual([]);
    expect(tight.skim).toEqual([]);
    expect(tight.budget.truncated).toBe(true);
    expect(tight.budget.omitted.files + tight.reviewFirst.length).toBe(8);
    const rendered = estimateTokens(renderBriefMarkdown(tight));
    expect(tight.budget.estimatedTokens).toBe(rendered);
    expect(rendered).toBeLessThanOrEqual(200);

    const medium = fitBudget(bigBrief(), 700);
    expect(medium.reviewFirst).toHaveLength(8);
    expect(medium.checks.length).toBeGreaterThan(0);
    expect(medium.checks.length).toBeLessThan(6);
    expect(estimateTokens(renderBriefMarkdown(medium))).toBeLessThanOrEqual(700);
  });

  it("keeps a file's header when only some of its hunks fit, and never renders over budget", () => {
    // The fixed sections (verdict, needs a human, not ranked, footer) are never cut, so start at their cost,
    // measured at a three-digit budget: the footer prints maxTokens, and every budget scanned has three digits.
    const floor = estimateTokens(renderBriefMarkdown(fitBudget(bigBrief(), 100)));
    let partials = 0;
    for (let budget = floor; budget <= floor + 700; budget += 10) {
      const out = fitBudget(bigBrief(), budget);
      expect(estimateTokens(renderBriefMarkdown(out)), `budget ${budget}`).toBeLessThanOrEqual(budget);
      expect(out.budget.estimatedTokens, `budget ${budget}`).toBe(estimateTokens(renderBriefMarkdown(out)));
      if (out.reviewFirst.some((f) => f.hunks.length > 0 && f.hunks.length < 3)) partials++;
    }
    expect(partials).toBeGreaterThan(0);
  });

  it("keeps at most 5 notes of 200 characters, after everything else, and counts the rest as omitted", () => {
    const notes = Array.from({ length: 8 }, (_, i) => `${i}`.repeat(500));
    const out = fitBudget({ ...bigBrief(), notes }, 6000);
    expect(out.notes).toHaveLength(5);
    expect(out.notes[0]).toBe(`${"0".repeat(200)}…`);
    expect(out.budget).toMatchObject({ truncated: true, omitted: { files: 0, hunks: 0, checks: 0, notes: 3 } });
    expect(out.checks).toHaveLength(6);
  });

  it("never renders over a tiny budget however many notes there are", () => {
    const floor = fitBudget(bigBrief(), 100).budget.estimatedTokens;
    const notes = Array.from({ length: 30 }, () => "n".repeat(300));
    const out = fitBudget({ ...bigBrief(), notes }, floor + 30);
    expect(out.budget.estimatedTokens).toBeLessThanOrEqual(floor + 30);
    expect(out.notes.length + out.budget.omitted.notes).toBe(30);
    expect(renderBriefMarkdown(out)).toContain(`/ ${out.budget.omitted.notes} notes omitted)`);
  });

  it("collapses a counts skim to an empty counts object when it does not fit", () => {
    const b = { ...bigBrief(), skim: { counts: { docs: 30 } } };
    expect(fitBudget(b, 40).skim).toEqual({ counts: {} });
    expect(fitBudget(b, 6000).skim).toEqual({ counts: { docs: 30 } });
  });
});
