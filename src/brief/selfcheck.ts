import type { ArchitectureFact, ReviewBrief } from "../domain/types.js";

/** One item from the brief a pre-PR self-check should address (spec §2.2-§2.3): fix it, or explain why not. */
export interface SelfCheckItem {
  id: string;
  file: string;
  line?: number;
  text: string;
}

/**
 * `coupling.missing:src/session.ts`, or with a line: `contract.api:src/api.ts:42` (spec §2.3). `index`
 * disambiguates a fact that shares this key with an earlier one in the same brief (`factIds` assigns
 * it) — e.g. two new dependencies added to the same manifest that `findLine` cannot place on
 * different lines, or a file historically coupled with more than one partner.
 */
export const factId = (fact: ArchitectureFact, index = 0): string => `${fact.id}:${fact.file}${fact.line === undefined ? "" : `:${fact.line}`}${index === 0 ? "" : `#${index}`}`;

/**
 * Every fact's id, in `facts` order, made unique against others sharing its id+file+line: the first
 * keeps the plain `factId`, later ones get `#1`, `#2`, ... appended. Several candidate facts can share
 * that key (see `factId`), and a shared key previously collapsed the verifier's verdicts, the
 * dismissal memory lookup and `opendrs feedback --fact` onto whichever fact was processed last.
 */
export function factIds(facts: readonly ArchitectureFact[]): string[] {
  const seen = new Map<string, number>();
  return facts.map((f) => {
    const base = factId(f);
    const index = seen.get(base) ?? 0;
    seen.set(base, index + 1);
    return factId(f, index);
  });
}

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
  const facts = brief.captain?.facts ?? [];
  factIds(facts).forEach((id, i) => {
    const fact = facts[i]!;
    items.push({ id, file: fact.file, line: fact.line, text: fact.text });
  });
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
