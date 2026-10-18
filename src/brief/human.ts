import type { PolicyOutcome, PolicyRule } from "../domain/types.js";

/** Spec §5.7: the hard rules a human must act on. Score-based rules (tier, unknowns, sample) are the verdict's job. */
const HUMAN_RULES = new Set<PolicyRule>(["paths.block", "unread-files", "control-chars", "submodule", "tests.deleted", "content.block", "freeze", "draft", "changes-requested", "source"]);

export function needsHuman(policy: PolicyOutcome): Array<{ rule: PolicyRule; reason: string }> {
  return (policy.rules ?? []).filter((r) => HUMAN_RULES.has(r.rule));
}
