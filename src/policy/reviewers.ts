import type { HistoryIndex } from "../domain/types.js";

/** Top-n most frequent recent authors (emails) of `paths`, excluding `exclude`. Workstream C. */
export function suggestReviewers(_history: HistoryIndex, _paths: string[], _exclude: string | undefined, _n = 3): string[] {
  throw new Error("not implemented: workstream C");
}
