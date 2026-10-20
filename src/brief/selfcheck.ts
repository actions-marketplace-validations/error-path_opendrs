import type { ArchitectureFact, ReviewBrief } from "../domain/types.js";

/** One item from the brief a pre-PR self-check should address (spec §2.2-§2.3): fix it, or explain why not. */
export interface SelfCheckItem {
  id: string;
  file: string;
  line?: number;
  text: string;
}

/** `coupling.missing:src/session.ts`, or with a line: `contract.api:src/api.ts:42` (spec §2.3). */
export const factId = (fact: ArchitectureFact): string => `${fact.id}:${fact.file}${fact.line === undefined ? "" : `:${fact.line}`}`;

/** `hunk:src/session.ts:3` — the file and the brief's own numeric hunk id (unique within one diff). */
export const hunkId = (file: string, hunk: number): string => `hunk:${file}:${hunk}`;

/**
 * `check:src/session.ts:42:0` — `CheckItem` carries no id of its own, so the id is the file, the
 * line (or "-" when absent), and this item's position among checks sharing that file:line (at most
 * `MAX_PER_FILE` from `checkQuestions`, so the index alone disambiguates them).
 */
export const checkId = (file: string, line: number | undefined, index: number): string => `check:${file}:${line ?? "-"}:${index}`;

/**
 * Every id a self-check can address, in the order the brief already lists them: captain facts, then
 * reviewFirst hunks, then checks. Shared by the CLI's `--self-check-template`, the `self_check_items`
 * MCP tool, and the Action's fresh-brief comparison (spec §2.2-§2.3).
 */
export function selfCheckItems(brief: ReviewBrief): SelfCheckItem[] {
  const items: SelfCheckItem[] = [];
  for (const fact of brief.captain?.facts ?? []) {
    items.push({ id: factId(fact), file: fact.file, line: fact.line, text: fact.text });
  }
  for (const file of brief.reviewFirst) {
    for (const hunk of file.hunks) {
      items.push({ id: hunkId(file.file, hunk.id), file: file.file, line: hunk.newStart, text: hunk.reasons.map((r) => r.text).join("; ") || `hunk ${hunk.id}` });
    }
  }
  const seenAt = new Map<string, number>();
  for (const check of brief.checks) {
    const key = `${check.file}:${check.line ?? "-"}`;
    const index = seenAt.get(key) ?? 0;
    seenAt.set(key, index + 1);
    items.push({ id: checkId(check.file, check.line, index), file: check.file, line: check.line, text: check.question });
  }
  return items;
}
