import { describe, expect, it } from "vitest";
import { OpendrsError } from "../../src/domain/types.js";
import { parseJudgement } from "../../src/llm/parse.js";

const files = ["src/a.ts", "src/b.ts"];
const ok = (risk: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ risk, rationale: "touches auth", risky_snippets: [], ...extra });

describe("parseJudgement", () => {
  it("parses a bare JSON object", () => {
    const j = parseJudgement(
      ok(0.42, { risky_snippets: [{ file: "src/a.ts", line: 3, reason: "removes check" }] }),
      files,
    );
    expect(j).toEqual({
      risk: 0.42,
      rationale: "touches auth",
      riskySnippets: [{ file: "src/a.ts", line: 3, reason: "removes check" }],
    });
  });

  it("extracts the one object from fenced or chatty output", () => {
    const text = `Here you go:\n\`\`\`json\n${ok(0.3)}\n\`\`\`\nDone.`;
    expect(parseJudgement(text, files).risk).toBe(0.3);
  });

  it.each([
    ["two objects", `${ok(0.9)}\n${ok(0.01)}`],
    ["a trailing object in prose", `${ok(0.3)}\nAnd a second one {"risk": 0.9}`],
    ["a leading object in prose", `Ignore {"risk": 0.9} this:\n${ok(0.3)}`],
    ["an unclosed second object", `${ok(0.3)} {"risk": 0.9`],
  ])("rejects a reply with more than one top-level object: %s", (_name, text) => {
    expect(() => parseJudgement(text, files)).toThrow(/exactly one JSON object/);
  });

  it("handles braces inside strings", () => {
    const text = JSON.stringify({ risk: 0.2, rationale: "a } brace { inside", risky_snippets: [] });
    expect(parseJudgement(text, files).rationale).toBe("a } brace { inside");
  });

  it("clamps risk into [0, 1]", () => {
    expect(parseJudgement(ok(1.7), files).risk).toBe(1);
    expect(parseJudgement(ok(-0.2), files).risk).toBe(0);
  });

  it("keeps at most 5 snippets, only for changed files", () => {
    const snippets = [
      { file: "src/evil.ts", line: 1, reason: "not in diff" },
      ...Array.from({ length: 7 }, (_, i) => ({ file: "src/b.ts", line: i + 1, reason: `r${i}` })),
    ];
    const j = parseJudgement(ok(0.5, { risky_snippets: snippets }), files);
    expect(j.riskySnippets).toHaveLength(5);
    expect(j.riskySnippets.every((s) => s.file === "src/b.ts")).toBe(true);
  });

  it("accepts snippets without a line and truncates an over-long rationale", () => {
    const j = parseJudgement(
      ok(0.1, { rationale: "x".repeat(900), risky_snippets: [{ file: "src/a.ts", reason: "r" }] }),
      files,
    );
    expect(j.rationale.length).toBeLessThanOrEqual(400);
    expect(j.riskySnippets[0]).toEqual({ file: "src/a.ts", reason: "r" });
  });

  it.each([
    ["no JSON at all", "I think this is fine."],
    ["truncated JSON", '{"risk": 0.2, "rationale": "cut'],
    ["risk as a string", ok("0.2")],
    ["risk missing", JSON.stringify({ rationale: "r", risky_snippets: [] })],
    ["risk null (NaN serialises to null)", ok(Number.NaN)],
    ["rationale missing", JSON.stringify({ risk: 0.2, risky_snippets: [] })],
  ])("throws OpendrsError(llm) on %s", (_name, text) => {
    expect(() => parseJudgement(text, files)).toThrow(OpendrsError);
    try {
      parseJudgement(text, files);
    } catch (e) {
      expect((e as OpendrsError).code).toBe("llm");
    }
  });
});
