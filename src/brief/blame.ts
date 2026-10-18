import type { ScoringContext } from "../domain/types.js";
import { git } from "../git/exec.js";
import { code, untrusted } from "../report/escape.js";
import type { BlameHit, HunkCandidate } from "./rank.js";

const BLAME_TIMEOUT_MS = 5_000;
// A porcelain header line: "<sha> <orig line> <final line> [<group size>]".
const SHA_LINE = /^([0-9a-f]{40,64}) \d+ \d+/;

/**
 * For each candidate hunk, the fix or revert commits (before asOf) that last touched its old-side
 * lines at base. Added-only hunks have nothing to blame. One hunk's failure becomes a note, never an error.
 */
export async function blameFixes(ctx: ScoringContext, candidates: HunkCandidate[]): Promise<{ hits: Map<number, BlameHit[]>; notes: string[] }> {
  const hits = new Map<number, BlameHit[]>();
  const notes: string[] = [];
  const fixes = new Map(ctx.history.commits.filter((c) => (c.isFix || c.isRevert) && (ctx.asOf === undefined || c.time < ctx.asOf)).map((c) => [c.sha, c]));

  for (const c of candidates) {
    if (c.hunk.oldLines === 0) continue;
    // The base tree has the file at its old path, not its new one.
    const oldPath = c.file.oldPath ?? c.file.path;
    let out: string;
    try {
      const range = `${c.hunk.oldStart},${c.hunk.oldStart + c.hunk.oldLines - 1}`;
      out = await git(ctx.repoDir, ["blame", "--porcelain", "-L", range, ctx.diff.base, "--", oldPath], { timeoutMs: BLAME_TIMEOUT_MS });
    } catch (e) {
      // git's message echoes the path, so it is escaped like any other untrusted text; notes render as they are.
      notes.push(`blame unavailable for ${code(oldPath)}: ${untrusted(e instanceof Error ? e.message : String(e))}`);
      continue;
    }
    const seen = new Set<string>();
    const fixHits: BlameHit[] = [];
    for (const line of out.split("\n")) {
      const sha = SHA_LINE.exec(line)?.[1];
      if (!sha || seen.has(sha)) continue;
      seen.add(sha);
      const commit = fixes.get(sha);
      if (commit) fixHits.push({ sha: commit.sha, subject: commit.subject, time: commit.time });
    }
    if (fixHits.length > 0) hits.set(c.id, fixHits.sort((a, b) => b.time - a.time));
  }
  return { hits, notes };
}
