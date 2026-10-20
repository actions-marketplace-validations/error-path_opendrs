import { describe, expect, it } from "vitest";
import type { ReviewBrief } from "../../src/domain/types.js";
import { checkId, factId, hunkId, selfCheckItems } from "../../src/brief/selfcheck.js";

function brief(over: Partial<ReviewBrief> = {}): ReviewBrief {
  return {
    version: 1,
    verdict: { tier: "green", score: 0.1, decision: "auto-approve", why: "ok" },
    reviewFirst: [],
    checks: [],
    skim: [],
    human: [],
    notRanked: { hunks: 0, files: 0 },
    budget: { maxTokens: 2500, estimatedTokens: 10, truncated: false, omitted: { files: 0, hunks: 0, checks: 0, notes: 0 } },
    notes: [],
    ...over,
  };
}

describe("factId / hunkId / checkId", () => {
  it("includes the line only when the fact has one", () => {
    expect(factId({ id: "coupling.missing", weight: "info", file: "src/session.ts", text: "t" })).toBe("coupling.missing:src/session.ts");
    expect(factId({ id: "contract.api", weight: "strong", file: "src/api.ts", line: 42, text: "t" })).toBe("contract.api:src/api.ts:42");
  });
  it("hunkId is the file and the brief's own numeric hunk id", () => {
    expect(hunkId("src/a.ts", 3)).toBe("hunk:src/a.ts:3");
  });
  it("checkId takes an explicit index so two checks on the same file:line don't collide", () => {
    expect(checkId("src/a.ts", 10, 0)).toBe("check:src/a.ts:10:0");
    expect(checkId("src/a.ts", 10, 1)).toBe("check:src/a.ts:10:1");
    expect(checkId("src/a.ts", undefined, 0)).toBe("check:src/a.ts:-:0");
  });
});

describe("selfCheckItems", () => {
  it("lists every captain fact, every reviewFirst hunk and every check, in brief order", () => {
    const b = brief({
      captain: {
        priority: "careful",
        why: [],
        facts: [{ id: "coupling.missing", weight: "info", file: "src/a.ts", text: "missing co-change" }],
        notes: [],
      },
      reviewFirst: [{ file: "src/b.ts", reasons: [], hunks: [{ id: 2, oldStart: 1, newStart: 1, newLines: 3, score: 1, reasons: [{ kind: "critical", text: "on a critical path" }] }] }],
      checks: [{ file: "src/c.ts", line: 5, question: "Are callers compatible?", quotes: [], evidence: [] }],
    });
    expect(selfCheckItems(b)).toEqual([
      { id: "coupling.missing:src/a.ts", file: "src/a.ts", line: undefined, text: "missing co-change" },
      { id: "hunk:src/b.ts:2", file: "src/b.ts", line: 1, text: "on a critical path" },
      { id: "check:src/c.ts:5:0", file: "src/c.ts", line: 5, text: "Are callers compatible?" },
    ]);
  });

  it("gives two checks on the same file:line distinct ids instead of merging them", () => {
    const b = brief({
      checks: [
        { file: "src/a.ts", line: 10, question: "Q1?", quotes: [], evidence: [] },
        { file: "src/a.ts", line: 10, question: "Q2?", quotes: [], evidence: [] },
      ],
    });
    const items = selfCheckItems(b);
    expect(items.map((i) => i.id)).toEqual(["check:src/a.ts:10:0", "check:src/a.ts:10:1"]);
  });

  it("has no captain items when captain is absent (captain.enabled: false)", () => {
    expect(selfCheckItems(brief())).toEqual([]);
  });
});
