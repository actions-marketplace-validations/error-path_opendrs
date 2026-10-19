import type { Hunk, ScoringContext } from "../domain/types.js";
import { changedLines } from "../git/diff.js";
import { git } from "../git/exec.js";
import { runPool } from "../model/label.js";
import { code, untrusted } from "../report/escape.js";
import type { BlameHit, HunkCandidate } from "./rank.js";

const BLAME_TIMEOUT_MS = 5_000;
// How many `git blame` calls run at once; a repo with many candidate hunks would otherwise spawn
// them all together.
const BLAME_CONCURRENCY = 4;
// A porcelain header line: "<sha> <orig line> <final line> [<group size>]".
const SHA_LINE = /^([0-9a-f]{40,64}) \d+ \d+/;

/**
 * For each candidate hunk, the fix or revert commits (before asOf) that last touched its old-side
 * lines at base. Added-only hunks have nothing to blame. One hunk's failure becomes a note, never an error.
 */
export async function blameFixes(ctx: ScoringContext, candidates: HunkCandidate[]): Promise<{ hits: Map<number, BlameHit[]>; notes: string[] }> {
  const hits = new Map<number, BlameHit[]>();
  const fixes = new Map(ctx.history.commits.filter((c) => (c.isFix || c.isRevert) && (ctx.asOf === undefined || c.time < ctx.asOf)).map((c) => [c.sha, c]));
  // Indexed by position in `candidates`, not completion order, so the pool's concurrency cannot reorder them.
  const notes: (string | undefined)[] = new Array(candidates.length);

  await runPool(
    candidates.map((c, i) => ({ c, i })),
    BLAME_CONCURRENCY,
    async ({ c, i }) => {
      const ranges = deletedRanges(c.hunk);
      if (ranges.length === 0) return;
      // The base tree has the file at its old path, not its new one.
      const oldPath = c.file.oldPath ?? c.file.path;
      let out: string;
      try {
        out = await git(ctx.repoDir, ["blame", "--porcelain", ...ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), ctx.diff.base, "--", oldPath], { timeoutMs: BLAME_TIMEOUT_MS });
      } catch (e) {
        // git's message echoes the path, so it is escaped like any other untrusted text; notes render as they are.
        notes[i] = `blame unavailable for ${code(oldPath)}: ${untrusted(e instanceof Error ? e.message : String(e))}`;
        return;
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
    },
  );
  return { hits, notes: notes.filter((n): n is string => n !== undefined) };
}

/** Old-side line ranges of a hunk's deleted rows only (never its context), merged when consecutive. */
function deletedRanges(hunk: Hunk): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const { kind, line } of changedLines(hunk)) {
    if (kind !== "-") continue;
    const last = ranges.at(-1);
    if (last && last[1] === line - 1) last[1] = line;
    else ranges.push([line, line]);
  }
  return ranges;
}
