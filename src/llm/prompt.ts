import type { DiffInfo } from "../domain/types.js";

/**
 * Render the diff for the LLM: unified format, ignored files dropped, truncated to maxChars,
 * keeping whole hunks and preferring files with the most changed lines. Workstream D.
 */
export function buildDiffText(_diff: DiffInfo, _maxChars: number): string {
  throw new Error("not implemented: workstream D");
}
