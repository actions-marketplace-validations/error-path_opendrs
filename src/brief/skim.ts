import type { ChangedFile, ReviewBrief, ScoringContext } from "../domain/types.js";
import { matchAny } from "../git/glob.js";
import { languageFamily } from "../signals/language.js";
import { inert } from "../signals/size.js";

const COLLAPSE_AT = 20;

type SkimEntry = Extract<ReviewBrief["skim"], unknown[]>[number];

/** The per-file form of size.comment_only: every changed line is blank or a plain comment. */
function commentOnly(f: ChangedFile): boolean {
  if (f.status === "renamed") return false;
  const family = languageFamily(f.path);
  const texts = f.hunks.flatMap((h) => h.lines.filter((l) => l[0] === "+" || l[0] === "-").map((l) => l.slice(1)));
  return texts.length > 0 && texts.every((t) => inert(t, family));
}

function skimEntries(ctx: ScoringContext): SkimEntry[] {
  const isTest = (path: string) => matchAny(ctx.config.paths.tests, path);
  const testsDeleted = ctx.diff.files.some((f) => isTest(f.path) && (f.status === "deleted" || f.deleted > f.added));
  const entries: SkimEntry[] = [];
  for (const f of ctx.diff.files) {
    if (f.binary || f.submodule) continue;
    if (f.ignored) entries.push({ file: f.path, category: "ignored" });
    else if (languageFamily(f.path) === "docs") entries.push({ file: f.path, category: "docs" });
    else if (isTest(f.path)) {
      if (!testsDeleted) entries.push({ file: f.path, category: "tests" });
    } else if (commentOnly(f)) entries.push({ file: f.path, category: "comment-only" });
  }
  return entries;
}

/**
 * Spec §5.6: every path skimList would classify as mechanically safe, uncollapsed. `build.ts` uses
 * this to keep a skimmable file out of "Review first" whenever the PR has any non-skimmable hunk.
 */
export function skimmablePaths(ctx: ScoringContext): ReadonlySet<string> {
  return new Set(skimEntries(ctx).map((e) => e.file));
}

/**
 * Spec §5.6: files in mechanically safe categories. Binary files and submodules never qualify.
 * `exclude` drops paths already shown in "Review first", so a skim-only PR (every changed hunk is
 * skim-listed, spec §5.6 note) never lists the same file in both sections.
 */
export function skimList(ctx: ScoringContext, exclude: ReadonlySet<string> = new Set()): ReviewBrief["skim"] {
  const entries = skimEntries(ctx).filter((e) => !exclude.has(e.file));
  if (entries.length <= COLLAPSE_AT) return entries;
  const counts: Record<string, number> = {};
  for (const e of entries) counts[e.category] = (counts[e.category] ?? 0) + 1;
  return { counts };
}
