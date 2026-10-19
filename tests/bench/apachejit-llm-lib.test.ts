import { describe, expect, it } from "vitest";
import { LLM_CAVEATS, categoryStats, gateStats, passesGate, renderLlmReport, sample } from "../../bench/apachejit/lib.js";
import type { JudgedCommit } from "../../bench/apachejit/lib.js";
import { mulberry32 } from "../../src/model/fit.js";

const hunk = (category: string, confidence: number, safe = category === "tests" || category === "docs") => ({ category, safe, confidence });
const judged = (buggy: 0 | 1, hunks: ReturnType<typeof hunk>[], extra: Partial<NonNullable<JudgedCommit["judgement"]>> = {}): JudgedCommit => ({
  buggy,
  judgement: { hunks, unclassified: [], truncated: false, ...extra },
});

describe("sample", () => {
  it("is a deterministic permutation prefix and leaves the input alone", () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const a = sample(items, 10, mulberry32(1));
    const b = sample(items, 10, mulberry32(1));
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    expect(a).not.toEqual(items.slice(0, 10));
    expect(items).toEqual(Array.from({ length: 50 }, (_, i) => i));
    expect(sample(items, 100, mulberry32(1))).toHaveLength(50);
  });
});

describe("passesGate / gateStats", () => {
  const allSafe = judged(0, [hunk("tests", 9), hunk("docs", 8)]);
  it("passes when every hunk is safe at or above the confidence", () => {
    expect(passesGate(allSafe.judgement!, 8)).toBe(true);
    expect(passesGate(allSafe.judgement!, 9)).toBe(false);
  });
  it("blocks a risk hunk, a truncated diff and an unclassified hunk", () => {
    expect(passesGate(judged(0, [hunk("tests", 10), hunk("logic_bug", 10)]).judgement!, 8)).toBe(false);
    expect(passesGate(judged(0, [hunk("tests", 10)], { truncated: true }).judgement!, 8)).toBe(false);
    expect(passesGate(judged(0, [hunk("tests", 10)], { unclassified: [{ file: "a", line: 1 }] }).judgement!, 8)).toBe(false);
  });
  it("counts passed and buggy commits; a failed judge never passes", () => {
    const commits: JudgedCommit[] = [allSafe, judged(1, [hunk("docs", 8)]), judged(1, [hunk("docs", 6)]), { buggy: 0 }];
    expect(gateStats(commits, 8)).toEqual({ minConfidence: 8, passed: 2, buggy: 1 });
    expect(gateStats(commits, 6)).toEqual({ minConfidence: 6, passed: 3, buggy: 2 });
  });
});

it("categoryStats counts a commit once per category it has a hunk in", () => {
  const commits: JudgedCommit[] = [
    judged(1, [hunk("logic_bug", 7), hunk("logic_bug", 9), hunk("security", 8)]),
    judged(0, [hunk("security", 5)]),
    { buggy: 1 },
  ];
  expect(categoryStats(commits, ["logic_bug", "security", "performance"])).toEqual([
    { category: "logic_bug", flagged: 1, buggy: 1 },
    { category: "security", flagged: 2, buggy: 1 },
    { category: "performance", flagged: 0, buggy: 0 },
  ]);
});

it("renderLlmReport shows — for undefined rates and metrics, never NaN", () => {
  const md = renderLlmReport({
    meta: { version: "0.1.5", commit: "abc", date: "2026-10-16", model: "claude-x", promptHash: "0123456789ab", maxDiffChars: 60000 },
    sample: { train: { rows: 10, positives: 5, judgeFailures: 1 }, test: { rows: 0, positives: 0, judgeFailures: 0 } },
    models: [
      { label: "opendrs, default priors", metrics: { rows: 2, positives: 1, auc: 1, recallAt: { "5": 1, "10": 1, "30": 1, "50": 1 }, prf: { precision: 1, recall: 1, f1: 1 } } },
      { label: "opendrs, calibrated", metrics: null },
    ],
    gates: [{ minConfidence: 8, passed: 0, buggy: 0 }],
    categories: [{ category: "logic_bug", flagged: 0, buggy: 0 }],
    notes: ["a note"],
  });
  expect(md).toContain("opendrs, calibrated | — |");
  expect(md).toContain("| 8 | 0 | — | 0 | — |");
  expect(md).toContain("| logic_bug | 0 | 0 | — |");
  expect(md).toContain("prompt hash: 0123456789ab");
  expect(md).toContain("- a note");
  expect(md).toContain("## Caveats");
  for (const c of LLM_CAVEATS) expect(md).toContain(c);
  expect(LLM_CAVEATS.join("\n")).toMatch(/training/);
  expect(md).not.toContain("NaN");
});
