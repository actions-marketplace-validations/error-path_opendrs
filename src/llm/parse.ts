import { z } from "zod";
import { LLM_RISK_CATEGORIES, LLM_SAFE_CATEGORIES, OpendrsError, type LlmHunkRef, type LlmHunkVerdict, type LlmJudgement } from "../domain/types.js";

const MAX_RATIONALE = 400;
const MAX_REASON = 200;
const MAX_SNIPPETS = 5;

const SAFE = new Set<string>(LLM_SAFE_CATEGORIES);
const finite = (name: string) => z.number().refine(Number.isFinite, `${name} must be a finite number`);
const clampConfidence = (c: number) => Math.round(Math.min(10, Math.max(0, c)));

const outputSchema = z.object({
  risk: finite("risk"),
  confidence: finite("confidence"),
  rationale: z.string(),
  hunks: z.array(
    z.object({
      hunk: z.number().int(),
      category: z.enum([...LLM_SAFE_CATEGORIES, ...LLM_RISK_CATEGORIES]),
      confidence: finite("confidence"),
      reason: z.string(),
    }),
  ),
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

/** Every top-level balanced {...} in text, skipping braces inside JSON strings; an unclosed one counts too. */
function topLevelObjects(text: string): string[] {
  const found: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (depth === 0) {
      if (c === "{") {
        start = i;
        depth = 1;
      }
    } else if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) found.push(text.slice(start, i + 1));
  }
  if (depth > 0) found.push(text.slice(start));
  return found;
}

/** Of two verdicts for one hunk, the one to keep: risk beats safe, then the lower confidence. */
function riskier(a: LlmHunkVerdict, b: LlmHunkVerdict): LlmHunkVerdict {
  if (a.safe !== b.safe) return a.safe ? b : a;
  return b.confidence < a.confidence ? b : a;
}

/**
 * Strictly parse the judge's reply. Snippets are kept only for files that are in the diff; hunk
 * verdicts only for ids we showed, with `safe` derived from the category, never taken from the model.
 */
export function parseJudgement(text: string, files: string[], hunks: LlmHunkRef[], truncated: boolean): LlmJudgement {
  const objects = topLevelObjects(text);
  if (objects.length === 0) throw new OpendrsError("LLM reply contained no JSON object", "llm");
  // A second object (e.g. one quoted from the diff) could be the attacker's; refuse to pick one.
  if (objects.length > 1) throw new OpendrsError(`LLM reply must contain exactly one JSON object, found ${objects.length}`, "llm");
  const json = objects[0]!;

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
  const { risk, confidence, rationale, risky_snippets } = parsed.data;

  const shown = new Map(hunks.map((h) => [h.id, h]));
  const verdicts = new Map<number, LlmHunkVerdict>();
  for (const v of parsed.data.hunks) {
    const ref = shown.get(v.hunk);
    if (!ref) continue;
    const verdict: LlmHunkVerdict = {
      file: ref.file,
      line: ref.line,
      category: v.category,
      safe: SAFE.has(v.category),
      confidence: clampConfidence(v.confidence),
      reason: v.reason.slice(0, MAX_REASON),
    };
    const prev = verdicts.get(v.hunk);
    verdicts.set(v.hunk, prev ? riskier(prev, verdict) : verdict);
  }

  return {
    risk: Math.min(1, Math.max(0, risk)),
    rationale: rationale.slice(0, MAX_RATIONALE),
    riskySnippets: risky_snippets
      .filter((s) => changed.has(s.file))
      .slice(0, MAX_SNIPPETS)
      .map((s) => ({ file: s.file, ...(s.line != null ? { line: s.line } : {}), reason: s.reason.slice(0, MAX_REASON) })),
    confidence: clampConfidence(confidence),
    hunks: hunks.filter((h) => verdicts.has(h.id)).map((h) => verdicts.get(h.id)!),
    unclassified: hunks.filter((h) => !verdicts.has(h.id)).map((h) => ({ file: h.file, line: h.line })),
    truncated,
  };
}
