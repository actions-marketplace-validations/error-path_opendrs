import { describe, expect, it } from "vitest";
import { needsHuman } from "../../src/brief/human.js";
import type { PolicyOutcome } from "../../src/domain/types.js";

const policy = (rules: PolicyOutcome["rules"]): PolicyOutcome => ({
  tier: "yellow",
  decision: "human-review",
  reasons: rules.map((r) => r.reason),
  rules,
  hardBlocked: false,
  sampled: false,
  mergeMethod: "none",
  suggestedReviewers: [],
  landingDelayMinutes: 0,
});

describe("needsHuman", () => {
  it("keeps only the §5.7 rule ids, in firing order", () => {
    const out = needsHuman(
      policy([
        { rule: "paths.block", reason: "a" },
        { rule: "tier", reason: "b" },
        { rule: "unknowns", reason: "c" },
        { rule: "sample", reason: "d" },
        { rule: "draft", reason: "e" },
        { rule: "source", reason: "f" },
      ]),
    );
    expect(out).toEqual([
      { rule: "paths.block", reason: "a" },
      { rule: "draft", reason: "e" },
      { rule: "source", reason: "f" },
    ]);
  });

  it("keeps every hard rule the spec lists", () => {
    const hard = ["paths.block", "unread-files", "control-chars", "submodule", "tests.deleted", "content.block", "freeze", "draft", "changes-requested", "source"] as const;
    const out = needsHuman(policy(hard.map((rule) => ({ rule, reason: rule }))));
    expect(out.map((r) => r.rule)).toEqual([...hard]);
  });

  it("returns an empty array when nothing fired", () => {
    expect(needsHuman(policy([]))).toEqual([]);
  });
});
