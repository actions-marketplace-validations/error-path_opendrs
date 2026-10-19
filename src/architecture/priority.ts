import type { ArchitectureFact, CaptainPriority, PolicyRule, Tier } from "../domain/types.js";

/** Gate rules that stand in for a hard-block-worthy decision, regardless of tier (spec §7.1). */
const BLOCK_RULES: readonly PolicyRule[] = ["paths.block", "tests.deleted", "content.block"];

/** Spec §7.1, first match wins. `criticalTouched`: a changed file matches paths.critical. */
export function captainPriority(input: { tier: Tier; facts: ArchitectureFact[]; firedRules: PolicyRule[]; criticalTouched: boolean }): CaptainPriority {
  const hasStrong = input.facts.some((f) => f.weight === "strong");
  const blockRuleFired = input.firedRules.some((r) => BLOCK_RULES.includes(r));
  if (input.tier === "red" || (input.tier === "yellow" && hasStrong) || blockRuleFired || input.criticalTouched) return "careful";
  if (input.tier === "yellow" || (input.tier === "green" && hasStrong)) return "standard";
  return "quick";
}
