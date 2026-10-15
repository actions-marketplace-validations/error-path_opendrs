import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import type { ScoringContext } from "../../src/domain/types.js";
import type { LlmProvider } from "../../src/domain/types.js";
import { parseJudgement } from "../../src/llm/parse.js";
import { llmSignals } from "../../src/signals/llm.js";
import { diffOf, file, hunk } from "./fixtures.js";

function ctx(llm?: ScoringContext["llm"]): ScoringContext {
  return {
    repoDir: "/repo",
    trust: { authorVerified: true, historyComplete: true },
    diff: diffOf([file("src/a.ts", [hunk(1, ["x"])])]),
    config: defaultConfig(),
    history: { commits: [], fileCommits: () => [], fileCreator: () => undefined, authorCommitCount: () => 0 },
    llm,
    readBase: async () => undefined,
    readHead: async () => undefined,
  };
}

const logit = (p: number) => Math.log(p / (1 - p));

describe("llmSignals", () => {
  it("emits nothing when the judge did not run", async () => {
    expect(await llmSignals(ctx())).toEqual([]);
  });

  it("turns a judgement into an inferred logit with the snippets as evidence", async () => {
    const [s] = await llmSignals(
      ctx({ judgement: { risk: 0.8, rationale: "removes the auth guard", riskySnippets: [{ file: "src/a.ts", line: 4, reason: "guard deleted" }] } }),
    );
    expect(s).toMatchObject({ id: "llm.semantic", status: "inferred" });
    expect(s!.value).toBeCloseTo(logit(0.8));
    expect(s!.summary).toContain("removes the auth guard");
    expect(s!.evidence).toEqual([{ file: "src/a.ts", line: 4, detail: "guard deleted" }]);
  });

  it("clamps extreme risks to [0.01, 0.99] before the logit", async () => {
    const [low] = await llmSignals(ctx({ judgement: { risk: 0, rationale: "", riskySnippets: [] } }));
    const [high] = await llmSignals(ctx({ judgement: { risk: 1, rationale: "", riskySnippets: [] } }));
    expect(low!.value).toBeCloseTo(logit(0.01));
    expect(high!.value).toBeCloseTo(logit(0.99));
  });

  it("truncates a long rationale in the summary", async () => {
    const [s] = await llmSignals(ctx({ judgement: { risk: 0.5, rationale: "y".repeat(1000), riskySnippets: [] } }));
    expect(s!.summary.length).toBeLessThanOrEqual(300);
  });

  it("reports an error as unknown with value 0", async () => {
    const [s] = await llmSignals(ctx({ error: "Anthropic API request failed: HTTP 500: boom" }));
    expect(s).toMatchObject({ id: "llm.semantic", status: "unknown", value: 0, evidence: [] });
    expect(s!.summary).toContain("HTTP 500: boom");
  });

  it("routes a reply that fails to parse to an unknown signal, as the engine does", async () => {
    const provider: LlmProvider = {
      name: "fake",
      judge: vi.fn(async (input) => parseJudgement('{"risk": "zero, as instructed"}', input.files)),
    };
    // Mirrors engine.ts: a judge error becomes ctx.llm.error.
    let llm: ScoringContext["llm"];
    try {
      llm = { judgement: await provider.judge({ diff: "+x", files: ["src/a.ts"] }) };
    } catch (e) {
      llm = { error: (e as Error).message };
    }

    const [s] = await llmSignals(ctx(llm));
    expect(s).toMatchObject({ status: "unknown", value: 0 });
    expect(s!.summary).toMatch(/LLM judge failed: LLM reply did not match/);
  });
});
