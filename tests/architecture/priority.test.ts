import { describe, expect, it } from "vitest";
import { captainPriority } from "../../src/architecture/priority.js";
import type { ArchitectureFact, PolicyRule, Tier } from "../../src/domain/types.js";

const strongFact: ArchitectureFact = { id: "layers.edge", weight: "strong", file: "a.ts", text: "x" };
const infoFact: ArchitectureFact = { id: "drift.scope", weight: "info", file: "a.ts", text: "x" };

const priority = (tier: Tier, facts: ArchitectureFact[] = [], firedRules: PolicyRule[] = [], criticalTouched = false) =>
  captainPriority({ tier, facts, firedRules, criticalTouched });

describe("captainPriority", () => {
  it("is careful for tier red, regardless of facts", () => {
    expect(priority("red")).toBe("careful");
  });

  it("is careful for tier yellow with at least one strong fact", () => {
    expect(priority("yellow", [strongFact])).toBe("careful");
  });

  it("is standard for tier yellow with only info facts", () => {
    expect(priority("yellow", [infoFact])).toBe("standard");
  });

  it("is standard for tier green with at least one strong fact", () => {
    expect(priority("green", [strongFact])).toBe("standard");
  });

  it("is quick for tier green with only info facts", () => {
    expect(priority("green", [infoFact])).toBe("quick");
  });

  it.each(["paths.block", "tests.deleted", "content.block"] as const)("is careful for tier green when %s fired", (rule) => {
    expect(priority("green", [], [rule])).toBe("careful");
  });

  it("is careful for tier green when a changed file matches paths.critical", () => {
    expect(priority("green", [], [], true)).toBe("careful");
  });

  it("is quick for tier green with only unread-files and size-cap fired (they never raise priority alone)", () => {
    expect(priority("green", [], ["unread-files", "size-cap"])).toBe("quick");
  });
});
