import type { ScoreResult } from "../domain/types.js";

/** PR comment body. Starts with the `<!-- opendrs -->` marker. */
export function renderMarkdown(_result: ScoreResult): string {
  throw new Error("not implemented: workstream C");
}

/** Short human text for terminals. */
export function renderText(_result: ScoreResult): string {
  throw new Error("not implemented: workstream C");
}
