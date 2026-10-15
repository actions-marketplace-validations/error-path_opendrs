import type { SignalProvider } from "../domain/types.js";

const MAX_SUMMARY = 300;
const ID = "llm.semantic";

const clamp = (p: number) => Math.min(0.99, Math.max(0.01, p));
const logit = (p: number) => Math.log(p / (1 - p));
const truncate = (s: string) => (s.length > MAX_SUMMARY ? `${s.slice(0, MAX_SUMMARY - 3)}...` : s);

/** Spec §4 "llm.semantic". Emits nothing when ctx.llm is absent. */
export const llmSignals: SignalProvider = async (ctx) => {
  if (!ctx.llm) return [];
  const { judgement, error } = ctx.llm;

  if (!judgement) {
    // The engine already prefixes non-OpendrsError messages; avoid saying it twice.
    const reason = (error ?? "no judgement returned").replace(/^LLM judge failed: /, "");
    return [{ id: ID, value: 0, status: "unknown", summary: truncate(`LLM judge failed: ${reason}`), evidence: [] }];
  }

  return [
    {
      id: ID,
      value: logit(clamp(judgement.risk)),
      status: "inferred",
      summary: truncate(`LLM judge: risk ${judgement.risk.toFixed(2)}. ${judgement.rationale}`),
      evidence: judgement.riskySnippets.map((s) => ({ file: s.file, ...(s.line !== undefined ? { line: s.line } : {}), detail: s.reason })),
    },
  ];
};
