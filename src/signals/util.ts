import type { ChangedFile, Evidence, ScoringContext, Signal } from "../domain/types.js";

export const MAX_EVIDENCE = 5;

/** Changed files that count toward risk (not lockfiles, generated or vendored). */
export const countedFiles = (ctx: ScoringContext): ChangedFile[] => ctx.diff.files.filter((f) => !f.ignored);

/** The path history knows the file by: the pre-rename name, since the new one has no history yet. */
export const historyPath = (f: ChangedFile): string => f.oldPath ?? f.path;

export const asOfOrNow = (ctx: ScoringContext): number => ctx.asOf ?? Math.floor(Date.now() / 1000);

/** False when no commit precedes the cutoff (root commit, empty or truncated history). */
export function historyAvailable(ctx: ScoringContext): boolean {
  const oldest = ctx.history.commits.at(-1);
  return oldest !== undefined && (ctx.asOf === undefined || oldest.time < ctx.asOf);
}

export const unknown = (id: string, reason: string): Signal => ({ id, value: 0, status: "unknown", summary: reason, evidence: [] });

export const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

export const topEvidence = (items: Evidence[]): Evidence[] => items.slice(0, MAX_EVIDENCE);
