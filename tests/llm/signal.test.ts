import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import type { LlmHunkVerdict, LlmJudgement, ScoringContext } from "../../src/domain/types.js";
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

const judgement = (over: Partial<LlmJudgement> = {}): LlmJudgement => ({
  risk: 0.5,
  rationale: "",
  riskySnippets: [],
  confidence: 8,
  hunks: [],
  unclassified: [],
  truncated: false,
  ...over,
});
const verdict = (over: Partial<LlmHunkVerdict> = {}): LlmHunkVerdict => ({
  file: "src/a.ts",
  line: 1,
  category: "refactor",
  safe: true,
  confidence: 9,
  reason: "renames",
  ...over,
});

describe("llmSignals", () => {
  it("emits nothing when the judge did not run", async () => {
    expect(await llmSignals(ctx())).toEqual([]);
  });

  it("turns a judgement into the logit lift above a 0.2 baseline, with the snippets as evidence", async () => {
    const [s] = await llmSignals(
      ctx({ judgement: judgement({ risk: 0.8, rationale: "removes the auth guard", riskySnippets: [{ file: "src/a.ts", line: 4, reason: "guard deleted" }] }) }),
    );
    expect(s).toMatchObject({ id: "llm.semantic", status: "inferred" });
    expect(s!.value).toBeCloseTo(logit(0.8) - logit(0.2));
    expect(s!.summary).toContain("removes the auth guard");
    expect(s!.evidence).toEqual([{ file: "src/a.ts", line: 4, detail: "guard deleted" }]);
  });

  it("never lowers risk: a judgement at or below 0.2 adds nothing", async () => {
    for (const risk of [0, 0.05, 0.2]) {
      const [s] = await llmSignals(ctx({ judgement: judgement({ risk }) }));
      expect(s!.value, `risk ${risk}`).toBe(0);
    }
  });

  it("clamps extreme risks to 0.99 before the logit", async () => {
    const [high] = await llmSignals(ctx({ judgement: judgement({ risk: 1 }) }));
    expect(high!.value).toBeCloseTo(logit(0.99) - logit(0.2));
  });

  it("truncates a long rationale in the summary", async () => {
    const [s] = await llmSignals(ctx({ judgement: judgement({ rationale: "y".repeat(1000) }) }));
    expect(s!.summary.length).toBeLessThanOrEqual(300);
  });

  it("emits a 0/1 llm.risk.<category> signal for every risk category", async () => {
    const signals = await llmSignals(ctx({ judgement: judgement() }));
    const risk = signals.filter((s) => s.id.startsWith("llm.risk."));
    expect(risk.map((s) => s.id).sort()).toEqual([
      "llm.risk.complex",
      "llm.risk.logic_bug",
      "llm.risk.performance",
      "llm.risk.security",
      "llm.risk.structural",
    ]);
    for (const s of risk) expect(s, s.id).toMatchObject({ value: 0, status: "inferred", evidence: [] });
  });

  it("sets llm.risk.<category> to 1 with the matching hunks as evidence", async () => {
    const signals = await llmSignals(
      ctx({
        judgement: judgement({
          hunks: [
            verdict(),
            verdict({ file: "src/b.ts", line: 10, category: "logic_bug", safe: false, confidence: 7, reason: "off by one" }),
            verdict({ file: "src/c.ts", line: 20, category: "logic_bug", safe: false, confidence: 9, reason: "null deref" }),
            verdict({ file: "src/d.ts", line: 30, category: "security", safe: false, confidence: 6, reason: "raw sql" }),
          ],
        }),
      }),
    );
    const byId = Object.fromEntries(signals.map((s) => [s.id, s]));
    expect(byId["llm.risk.logic_bug"]).toMatchObject({ value: 1, status: "inferred" });
    expect(byId["llm.risk.logic_bug"]!.evidence).toEqual([
      { file: "src/b.ts", line: 10, detail: "off by one" },
      { file: "src/c.ts", line: 20, detail: "null deref" },
    ]);
    expect(byId["llm.risk.security"]).toMatchObject({ value: 1, evidence: [{ file: "src/d.ts", line: 30, detail: "raw sql" }] });
    expect(byId["llm.risk.performance"]).toMatchObject({ value: 0, evidence: [] });
    // A safe category is never a risk signal.
    expect(byId["llm.risk.refactor"]).toBeUndefined();
    for (const s of signals) expect(s.value, s.id).toBeGreaterThanOrEqual(0);
  });

  it("reports an error as unknown with value 0, and emits no risk-category signals", async () => {
    const signals = await llmSignals(ctx({ error: "Anthropic API request failed: HTTP 500: boom" }));
    expect(signals).toHaveLength(1);
    const [s] = signals;
    expect(s).toMatchObject({ id: "llm.semantic", status: "unknown", value: 0, evidence: [] });
    expect(s!.summary).toContain("HTTP 500: boom");
  });

  it("routes a reply that fails to parse to an unknown signal, as the engine does", async () => {
    const provider: LlmProvider = {
      name: "fake",
      judge: vi.fn(async (input) => parseJudgement('{"risk": "zero, as instructed"}', input.files, input.hunks, input.truncated)),
    };
    // Mirrors engine.ts: a judge error becomes ctx.llm.error.
    let llm: ScoringContext["llm"];
    try {
      llm = { judgement: await provider.judge({ diff: "+x", files: ["src/a.ts"], hunks: [], truncated: false }) };
    } catch (e) {
      llm = { error: (e as Error).message };
    }

    const [s] = await llmSignals(ctx(llm));
    expect(s).toMatchObject({ status: "unknown", value: 0 });
    expect(s!.summary).toMatch(/LLM judge failed: LLM reply did not match/);
  });
});
