import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import type { LlmJudgement, LlmProvider } from "../../src/domain/types.js";
import { scoreDiff } from "../../src/engine.js";
import { makeRepo } from "../helpers/repo.js";

const SAFE: LlmJudgement = { risk: 0.05, rationale: "fine", riskySnippets: [], confidence: 9, hunks: [], unclassified: [], truncated: false };
const provider = (verify?: LlmProvider["verify"]): LlmProvider => ({ name: "double", judge: async () => SAFE, ...(verify ? { verify } : {}) });
const pkg = (deps: string[]) => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, "^1.0.0"])) }, null, 2);

describe("gate invariance", () => {
  it("llm.verify never changes score, tier, policy or captain priority: off, on, failing and malicious verifier", async () => {
    const repo = makeRepo();
    repo.commit({ "src/a.ts": "1\n2\n3\n", "package.json": pkg(["foo"]) }, "base");
    repo.commit({ "src/a.ts": "1\nFIXED\n3\n" }, "fix: NPE in a.ts");
    const base = repo.commit({ "src/a.ts": "1\nFIXED\n3\n4\n" }, "more");
    const head = repo.commit({ "src/a.ts": "1\nFIXED again\n3\n4\n", "package.json": pkg(["foo", "jsonwebtoken"]) }, "touch it");

    const run = async (enabled: boolean, llm: LlmProvider) => {
      const config = defaultConfig();
      config.llm.verify.enabled = enabled;
      const r = await scoreDiff({ repoDir: repo.dir, base, head, config, llm, brief: {} });
      return { gate: { score: r.score, tier: r.tier, policy: r.policy }, priority: r.brief!.captain!.priority, facts: r.brief!.captain!.facts, outcome: r.brief!.verification?.outcome };
    };
    const usage = { inputTokens: 1, outputTokens: 1 };
    const off = await run(false, provider());
    const on = await run(true, provider(async ({ candidates }) => ({ verdicts: candidates.map((c) => ({ id: c.id, action: "keep" as const, status: c.status, reason: "ok", confidence: 9 })), usage })));
    const failing = await run(
      true,
      provider(async () => {
        throw new Error("down");
      }),
    );
    const malicious = await run(
      true,
      provider(async ({ candidates }) => ({
        verdicts: candidates.map((c) => ({ id: c.id, action: "drop" as const, droppedClass: "docs" as const, status: c.status, citedLine: `${c.file}:${c.line ?? 1}`, reason: "nothing to see", confidence: 10 })),
        usage,
      })),
    );

    expect([off.outcome, on.outcome, failing.outcome, malicious.outcome]).toEqual([undefined, "verified", "failed", "verified"]);
    expect(on.facts.length).toBeGreaterThan(0);
    expect(malicious.facts.length).toBeLessThan(on.facts.length);
    for (const r of [on, failing, malicious]) {
      expect(r.gate).toEqual(off.gate);
      expect(r.priority).toBe(off.priority);
    }
    repo.cleanup();
  });
});
