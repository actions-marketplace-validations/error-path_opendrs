import { z } from "zod";
import { OpendrsError, type LlmJudgement } from "../domain/types.js";

const MAX_RATIONALE = 400;
const MAX_REASON = 200;
const MAX_SNIPPETS = 5;

const outputSchema = z.object({
  risk: z.number().refine(Number.isFinite, "risk must be a finite number"),
  rationale: z.string(),
  risky_snippets: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().nullish(),
        reason: z.string(),
      }),
    )
    .default([]),
});

/** The first balanced {...} in text, skipping braces inside JSON strings. */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return undefined;
}

/** Strictly parse the judge's reply. Snippets are kept only for files that are in the diff. */
export function parseJudgement(text: string, files: string[]): LlmJudgement {
  const json = firstJsonObject(text);
  if (json === undefined) throw new OpendrsError("LLM reply contained no JSON object", "llm");

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new OpendrsError(`LLM reply was not valid JSON: ${(e as Error).message}`, "llm");
  }

  const parsed = outputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new OpendrsError(`LLM reply did not match the expected shape: ${z.prettifyError(parsed.error)}`, "llm");
  }

  const changed = new Set(files);
  const { risk, rationale, risky_snippets } = parsed.data;
  return {
    risk: Math.min(1, Math.max(0, risk)),
    rationale: rationale.slice(0, MAX_RATIONALE),
    riskySnippets: risky_snippets
      .filter((s) => changed.has(s.file))
      .slice(0, MAX_SNIPPETS)
      .map((s) => ({ file: s.file, ...(s.line != null ? { line: s.line } : {}), reason: s.reason.slice(0, MAX_REASON) })),
  };
}
