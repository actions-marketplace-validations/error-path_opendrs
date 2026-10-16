import type { ScoreResult, Tier, Decision } from "../../src/domain/types.js";
import type { CliIo } from "../../src/cli/types.js";

export function testIo(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { cwd, env, out: (s) => out.push(s), err: (s) => err.push(s), progress: () => {} };
  return { io, stdout: () => out.join("\n"), stderr: () => err.join("\n") };
}

export function fakeResult(score: number, tier: Tier = "green", decision: Decision = "auto-approve"): ScoreResult {
  return {
    score,
    tier,
    signals: [],
    contributions: [],
    unknowns: [],
    policy: {
      tier,
      decision,
      reasons: [decision === "auto-approve" ? "low risk" : "tier " + tier],
      hardBlocked: false,
      sampled: false,
      mergeMethod: "queue",
      suggestedReviewers: [],
    },
    diff: { base: "b".repeat(40), head: "h".repeat(40), files: 1, added: 3, deleted: 1 },
    model: "default",
    version: "0.1.3",
  };
}
