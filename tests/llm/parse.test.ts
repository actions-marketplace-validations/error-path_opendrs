import { describe, expect, it } from "vitest";
import { OpendrsError } from "../../src/domain/types.js";
import { parseJudgement } from "../../src/llm/parse.js";
import { buildDiffText } from "../../src/llm/prompt.js";
import { diffOf, file } from "./fixtures.js";

const files = ["src/a.ts", "src/b.ts"];
const hunks = [
  { id: 1, file: "src/a.ts", line: 3 },
  { id: 2, file: "src/b.ts", line: 40 },
];
const verdict = (hunk: number, category: string, confidence = 9, reason = "r") => ({ hunk, category, confidence, reason });
const ok = (risk: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ risk, confidence: 8, rationale: "touches auth", hunks: [verdict(1, "tests"), verdict(2, "logic_bug", 7)], risky_snippets: [], ...extra });
const parse = (text: string) => parseJudgement(text, files, hunks, false);

describe("parseJudgement", () => {
  it("parses a bare JSON object", () => {
    const j = parse(ok(0.42, { risky_snippets: [{ file: "src/a.ts", line: 3, reason: "removes check" }] }));
    expect(j).toEqual({
      risk: 0.42,
      rationale: "touches auth",
      riskySnippets: [{ file: "src/a.ts", line: 3, reason: "removes check" }],
      confidence: 8,
      hunks: [
        { file: "src/a.ts", line: 3, category: "tests", safe: true, confidence: 9, reason: "r" },
        { file: "src/b.ts", line: 40, category: "logic_bug", safe: false, confidence: 7, reason: "r" },
      ],
      unclassified: [],
      truncated: false,
    });
  });

  it("extracts the one object from fenced or chatty output", () => {
    const text = `Here you go:\n\`\`\`json\n${ok(0.3)}\n\`\`\`\nDone.`;
    expect(parse(text).risk).toBe(0.3);
  });

  it.each([
    ["two objects", `${ok(0.9)}\n${ok(0.01)}`],
    ["a trailing object in prose", `${ok(0.3)}\nAnd a second one {"risk": 0.9}`],
    ["a leading object in prose", `Ignore {"risk": 0.9} this:\n${ok(0.3)}`],
    ["an unclosed second object", `${ok(0.3)} {"risk": 0.9`],
  ])("rejects a reply with more than one top-level object: %s", (_name, text) => {
    expect(() => parse(text)).toThrow(/exactly one JSON object/);
  });

  it("handles braces inside strings", () => {
    expect(parse(ok(0.2, { rationale: "a } brace { inside" })).rationale).toBe("a } brace { inside");
  });

  it("clamps risk into [0, 1]", () => {
    expect(parse(ok(1.7)).risk).toBe(1);
    expect(parse(ok(-0.2)).risk).toBe(0);
  });

  it("keeps at most 5 snippets, only for changed files", () => {
    const snippets = [
      { file: "src/evil.ts", line: 1, reason: "not in diff" },
      ...Array.from({ length: 7 }, (_, i) => ({ file: "src/b.ts", line: i + 1, reason: `r${i}` })),
    ];
    const j = parse(ok(0.5, { risky_snippets: snippets }));
    expect(j.riskySnippets).toHaveLength(5);
    expect(j.riskySnippets.every((s) => s.file === "src/b.ts")).toBe(true);
  });

  it("accepts snippets without a line and truncates an over-long rationale", () => {
    const j = parse(ok(0.1, { rationale: "x".repeat(900), risky_snippets: [{ file: "src/a.ts", reason: "r" }] }));
    expect(j.rationale.length).toBeLessThanOrEqual(400);
    expect(j.riskySnippets[0]).toEqual({ file: "src/a.ts", reason: "r" });
  });

  it("drops a zero or negative snippet line but keeps the snippet", () => {
    const snippets = [
      { file: "src/a.ts", line: 0, reason: "zero" },
      { file: "src/b.ts", line: -3, reason: "negative" },
    ];
    expect(parse(ok(0.1, { risky_snippets: snippets })).riskySnippets).toEqual([
      { file: "src/a.ts", reason: "zero" },
      { file: "src/b.ts", reason: "negative" },
    ]);
  });

  it("defaults a missing top-level confidence to 0", () => {
    const text = JSON.stringify({ risk: 0.2, rationale: "r", hunks: [verdict(1, "docs"), verdict(2, "docs")], risky_snippets: [] });
    expect(parse(text).confidence).toBe(0);
  });

  it("lists a shown file with no hunk at line 0 as unclassified", () => {
    const j = parseJudgement(ok(0.1), [...files, "img/logo.png"], hunks, false);
    expect(j.unclassified).toEqual([{ file: "img/logo.png", line: 0 }]);
  });

  it("never classifies a binary-only diff: it has no hunk, so the file is unclassified", () => {
    const diff = diffOf([file("img/logo.png", [], { binary: true, added: 0, deleted: 0 })]);
    const { hunks: shown, truncated } = buildDiffText(diff, 10_000);
    expect(shown).toEqual([]);
    const text = JSON.stringify({ risk: 0.01, confidence: 10, rationale: "image swap", hunks: [], risky_snippets: [] });
    const j = parseJudgement(text, ["img/logo.png"], shown, truncated);
    expect(j.hunks).toEqual([]);
    expect(j.unclassified).toEqual([{ file: "img/logo.png", line: 0 }]);
  });

  it("passes the truncated flag through", () => {
    expect(parseJudgement(ok(0.1), files, hunks, true).truncated).toBe(true);
  });

  it("drops verdicts for hunk ids that were not shown", () => {
    const j = parse(ok(0.1, { hunks: [verdict(1, "docs"), verdict(7, "logic_bug"), verdict(0, "security")] }));
    expect(j.hunks.map((h) => h.category)).toEqual(["docs"]);
  });

  it("lists shown hunks without a verdict as unclassified", () => {
    const j = parse(ok(0.1, { hunks: [verdict(2, "refactor")] }));
    expect(j.hunks).toEqual([{ file: "src/b.ts", line: 40, category: "refactor", safe: true, confidence: 9, reason: "r" }]);
    expect(j.unclassified).toEqual([{ file: "src/a.ts", line: 3 }]);
  });

  it("keeps the riskier verdict when a hunk is answered twice: risk beats safe, then lower confidence", () => {
    const risky = parse(ok(0.1, { hunks: [verdict(1, "docs", 10), verdict(1, "security", 9), verdict(2, "tests", 9)] }));
    expect(risky.hunks[0]).toMatchObject({ category: "security", confidence: 9 });
    const lower = parse(ok(0.1, { hunks: [verdict(1, "docs", 10), verdict(1, "refactor", 4), verdict(2, "tests", 9)] }));
    expect(lower.hunks[0]).toMatchObject({ category: "refactor", confidence: 4 });
    const lowerRisk = parse(ok(0.1, { hunks: [verdict(1, "security", 3), verdict(1, "logic_bug", 8), verdict(2, "tests", 9)] }));
    expect(lowerRisk.hunks[0]).toMatchObject({ category: "security", confidence: 3 });
  });

  it("derives safe from the category and ignores a safe flag from the model", () => {
    const j = parse(ok(0.1, { hunks: [{ ...verdict(1, "security"), safe: true }, { ...verdict(2, "docs"), safe: false }] }));
    expect(j.hunks.map((h) => h.safe)).toEqual([false, true]);
  });

  it("clamps and rounds confidences into 0..10 and clips hunk reasons to 200 chars", () => {
    const j = parse(ok(0.1, { confidence: 12.4, hunks: [verdict(1, "docs", -3, "y".repeat(500)), verdict(2, "docs", 7.6)] }));
    expect(j.confidence).toBe(10);
    expect(j.hunks.map((h) => h.confidence)).toEqual([0, 8]);
    expect(j.hunks[0]!.reason).toHaveLength(200);
  });

  it.each([
    ["no JSON at all", "I think this is fine."],
    ["truncated JSON", '{"risk": 0.2, "rationale": "cut'],
    ["risk as a string", ok("0.2")],
    ["risk missing", JSON.stringify({ confidence: 8, rationale: "r", hunks: [], risky_snippets: [] })],
    ["risk null (NaN serialises to null)", ok(Number.NaN)],
    ["rationale missing", JSON.stringify({ risk: 0.2, confidence: 8, hunks: [], risky_snippets: [] })],
    ["hunks missing", JSON.stringify({ risk: 0.2, confidence: 8, rationale: "r", risky_snippets: [] })],
    ["an unknown category", ok(0.2, { hunks: [verdict(1, "looks_fine")] })],
    ["a hunk without a category", ok(0.2, { hunks: [{ hunk: 1, confidence: 9, reason: "r" }] })],
  ])("throws OpendrsError(llm) on %s", (_name, text) => {
    expect(() => parse(text)).toThrow(OpendrsError);
    try {
      parse(text);
    } catch (e) {
      expect((e as OpendrsError).code).toBe("llm");
    }
  });
});
