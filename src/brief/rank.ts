import { LLM_RISK_CATEGORIES } from "../domain/types.js";
import type { BriefReason, ChangedFile, DiffInfo, Hunk, ScoreResult, ScoringContext } from "../domain/types.js";
import { changedLines } from "../git/diff.js";
import { matchAny } from "../git/glob.js";
import { isPublicDeclaration } from "../graph/public-decl.js";
import { hotspotScore } from "../hotspots.js";
import { code } from "../report/escape.js";
import { isPatchFile } from "../signals/language.js";
import { clipQuote, quoteUntrusted } from "./quote.js";

export interface HunkCandidate {
  /** The `[hunk N]` id: its position in buildDiffText(diff, Infinity). */
  id: number;
  file: ChangedFile;
  hunk: Hunk;
  index: number;
}
/** A fix or revert commit that `git blame` attributed an old-side line of a hunk to. */
export interface BlameHit {
  sha: string;
  subject: string;
  time: number;
}
export interface RankedHunk {
  id: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  score: number;
  reasons: BriefReason[];
}
export interface RankedFile {
  file: string;
  score: number;
  reasons: BriefReason[];
  hunks: RankedHunk[];
}

/** Spec §5.3 ranking weights, priors until §10.2 tunes them. */
export const RANK_WEIGHTS = { fixBlame: 1.5, exports: 1.0, changedLines: 0.5, branches: 0.25, newAuthor: 0.5, llmRisk: 1.0 } as const;
const MAX_REASONS = 4;
// The same set complexity.touched counts (signals/complexity.ts).
const BRANCH = /\b(if|elif|elsif|for|foreach|while|until|unless|case|when|catch|except|rescue|guard)\b|&&|\|\|/g;

// Mirrors buildDiffText's file ordering (llm/prompt.ts) and keeps every hunk, so ids here are
// identical, file for file and hunk for hunk, to buildDiffText(diff, Infinity).
function orderedFiles(diff: DiffInfo): ChangedFile[] {
  return diff.files.filter((f) => !f.ignored).sort((a, b) => b.added + b.deleted - (a.added + a.deleted) || a.path.localeCompare(b.path));
}

export function candidateHunks(ctx: ScoringContext): HunkCandidate[] {
  const out: HunkCandidate[] = [];
  let id = 0;
  for (const file of orderedFiles(ctx.diff)) {
    // A file git diffed as text but the blob check flagged binary keeps its hunks, and buildDiffText
    // numbers them, so they count here too; they are only not ranked. A patch/diff file is an
    // archived record, never a hunk worth ranking, so it is excluded the same way.
    for (const [index, hunk] of file.hunks.entries()) {
      id++;
      if (!file.binary && !isPatchFile(file.path)) out.push({ id, file, hunk, index });
    }
  }
  return out;
}

function hunkChangedLines(h: Hunk): number {
  let n = 0;
  for (const _ of changedLines(h)) n++;
  return n;
}

function branchKeywordCount(h: Hunk): number {
  let n = 0;
  for (const { text } of changedLines(h)) n += text.match(BRANCH)?.length ?? 0;
  return n;
}

/**
 * The first changed line that declares a public symbol, if any: its head only (trimmed, at most 120
 * chars), cut before a comment, an initialiser or a body, which is where PR-controlled prose would sit.
 */
function hunkPublicDecl(c: HunkCandidate): string | undefined {
  for (const { kind, text } of changedLines(c.hunk)) {
    const path = kind === "+" ? c.file.path : (c.file.oldPath ?? c.file.path);
    if (isPublicDeclaration(path, text)) return text.split(/\/\/|\/\*|#|=|\{/, 1)[0]!.trim().slice(0, 120);
  }
  return undefined;
}

/**
 * Every listed hunk needs at least one concrete reason. When none of the templates above applied,
 * fall back to the hunk's own size, plus the most informative file context on hand: dependents,
 * then an exported declaration, then prior fixes.
 */
function fallbackReason(c: HunkCandidate, dependents: number, fixCount: number): BriefReason {
  const base = plural(hunkChangedLines(c.hunk), "changed line");
  const decl = hunkPublicDecl(c);
  const context =
    dependents > 0
      ? `${plural(dependents, "file")} depend${dependents === 1 ? "s" : ""} on it`
      : decl
        ? `changes exported ${code(decl)}`
        : fixCount > 0
          ? `in a file with ${plural(fixCount, "prior fix")}`
          : undefined;
  return { kind: "changed-lines", text: context ? `${base}, ${context}` : base };
}

function fixHistory(ctx: ScoringContext, path: string) {
  const commits = ctx.history.fileCommits(path, ctx.asOf).filter((c) => c.isFix || c.isRevert);
  return { count: commits.length, latest: commits[0] };
}

/** True when the PR author never committed to the file and did not create it (spec §5.3 item 4). */
function newAuthor(ctx: ScoringContext, path: string): boolean {
  const email = ctx.diff.author?.email.toLowerCase();
  if (!email) return false;
  if (ctx.history.fileCreator(path, ctx.asOf)?.toLowerCase() === email) return false;
  return !ctx.history.fileCommits(path, ctx.asOf).some((c) => c.authorEmail.toLowerCase() === email);
}

const isRiskCategory = (category: string) => (LLM_RISK_CATEGORIES as readonly string[]).includes(category);
const isoDate = (unixSeconds: number): string => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function rankHunks(
  ctx: ScoringContext,
  result: ScoreResult,
  blame: ReadonlyMap<number, BlameHit[]>,
  opts: { llm?: boolean } = {},
): RankedFile[] {
  const useLlm = opts.llm !== false;
  const testGlobs = ctx.config.paths.tests;
  const byFile = new Map<string, HunkCandidate[]>();
  for (const c of candidateHunks(ctx)) byFile.set(c.file.path, [...(byFile.get(c.file.path) ?? []), c]);
  const anyTestChanged = ctx.diff.files.some((f) => matchAny(testGlobs, f.path));

  const files: RankedFile[] = [];
  for (const [path, candidates] of byFile) {
    const f = candidates[0]!.file;
    // History and the graph are read at base, where a renamed file still has its old path.
    const oldPath = f.oldPath ?? f.path;
    const dependents = ctx.graph?.dependentsOf(oldPath).length ?? 0;
    const critical = matchAny(ctx.config.paths.critical, path, { ignoreCase: true }) || matchAny(ctx.config.paths.critical, oldPath, { ignoreCase: true });
    const fixes = fixHistory(ctx, oldPath);
    const risk = hotspotScore({
      fixCommits: fixes.count,
      commits: ctx.history.fileCommits(oldPath, ctx.asOf).length,
      transitiveDependents: ctx.graph ? ctx.graph.transitiveDependents(oldPath, ctx.config.graph.maxDepth).size : null,
      critical,
    });
    const isNewAuthor = newAuthor(ctx, oldPath);

    const fileReasons: BriefReason[] = [];
    if (fixes.latest) {
      fileReasons.push({
        kind: "fix-history",
        text: `${plural(fixes.count, "fix or revert commit")} in this file; latest ${code(fixes.latest.sha.slice(0, 7))} ${quoteUntrusted(fixes.latest.subject)}`,
        quote: clipQuote(fixes.latest.subject),
        sha: fixes.latest.sha,
      });
    }
    if (dependents > 0) fileReasons.push({ kind: "dependents", text: `${plural(dependents, "file")} depend${dependents === 1 ? "s" : ""} on it` });
    if (critical) fileReasons.push({ kind: "critical", text: "on a critical path" });
    if (!anyTestChanged && !matchAny(testGlobs, path)) fileReasons.push({ kind: "no-tests", text: "no test changed alongside it" });
    if (isNewAuthor) fileReasons.push({ kind: "new-author", text: "the author has not changed this file before" });

    const hunks: RankedHunk[] = candidates.map((c) => {
      let score = risk + (isNewAuthor ? RANK_WEIGHTS.newAuthor : 0);
      const reasons: BriefReason[] = [];
      const top = blame.get(c.id)?.[0];
      if (top) {
        score += RANK_WEIGHTS.fixBlame;
        reasons.push({
          kind: "fix-blame",
          text: `edits lines last changed by fix ${code(top.sha.slice(0, 7))} (${isoDate(top.time)}) ${quoteUntrusted(top.subject)}`,
          quote: clipQuote(top.subject),
          sha: top.sha,
        });
      }
      const decl = dependents > 0 ? hunkPublicDecl(c) : undefined;
      if (decl) {
        score += RANK_WEIGHTS.exports;
        reasons.push({ kind: "exports", text: `exports changed: ${code(decl)}` });
      }
      score += RANK_WEIGHTS.changedLines * Math.log1p(hunkChangedLines(c.hunk));
      score += RANK_WEIGHTS.branches * Math.log1p(branchKeywordCount(c.hunk));
      const line = c.hunk.newStart || c.hunk.oldStart;
      const verdict = useLlm ? result.llm?.hunks.find((h) => h.file === path && h.line === line) : undefined;
      if (verdict && isRiskCategory(verdict.category)) {
        score += RANK_WEIGHTS.llmRisk;
        reasons.push({
          kind: "llm",
          text: `LLM judge: ${verdict.category} (${verdict.confidence}/10) ${quoteUntrusted(verdict.reason)}`,
          quote: clipQuote(verdict.reason),
        });
      }
      if (reasons.length === 0) reasons.push(fallbackReason(c, dependents, fixes.count));
      return { id: c.id, oldStart: c.hunk.oldStart, oldLines: c.hunk.oldLines, newStart: c.hunk.newStart, newLines: c.hunk.newLines, score, reasons: reasons.slice(0, MAX_REASONS) };
    });

    files.push({ file: path, score: Math.max(risk, ...hunks.map((h) => h.score)), reasons: fileReasons.slice(0, MAX_REASONS), hunks });
  }

  // Files by their best hunk, ties on path; hunks within a file keep diff order (by line).
  return files.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
}
