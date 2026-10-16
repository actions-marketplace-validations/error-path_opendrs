import { createHash } from "node:crypto";
import type { HistoryIndex } from "../domain/types.js";

const RECENT_SECONDS = 90 * 86_400;

const isBot = (email: string) => email.includes("[bot]") || email === "noreply@github.com" || email === "actions@github.com";

/**
 * Top-n authors (lowercased emails) of `paths`, excluding `exclude` and bots. Each commit counts
 * once; commits within 90 days of the newest commit in history count double. Ties go to the most
 * recent committer, then alphabetical email. For a `risky` (yellow or red) diff, fix and revert
 * commits count double again: the people who fixed bugs in these files know their failure modes.
 */
export function suggestReviewers(history: HistoryIndex, paths: string[], exclude: string | undefined, n = 3, risky = false): string[] {
  // "Now" is the newest commit in history, not the wall clock, so results are reproducible.
  const now = history.commits[0]?.time ?? 0;
  const excluded = exclude?.toLowerCase();
  const seen = new Set<string>();
  const tally = new Map<string, { score: number; latest: number }>();
  for (const path of paths) {
    for (const c of history.fileCommits(path)) {
      if (seen.has(c.sha)) continue;
      seen.add(c.sha);
      const email = c.authorEmail.toLowerCase();
      if (email === excluded || isBot(email)) continue;
      const t = tally.get(email) ?? { score: 0, latest: 0 };
      t.score += (now - c.time <= RECENT_SECONDS ? 2 : 1) * (risky && (c.isFix || c.isRevert) ? 2 : 1);
      t.latest = Math.max(t.latest, c.time);
      tally.set(email, t);
    }
  }
  return [...tally]
    .sort(([ea, a], [eb, b]) => b.score - a.score || b.latest - a.latest || (ea < eb ? -1 : 1))
    .slice(0, n)
    .map(([email]) => email);
}

/**
 * One reviewer among the top three `candidates`, chosen by sha256(seed) so reruns pick the same
 * person and the load spreads across experts. One named person, not a team: a review asked of
 * several is left to the others (the bystander effect, Rigby et al. 2025).
 */
export function assignReviewer(candidates: string[], seed: string): string | undefined {
  const top = candidates.slice(0, 3);
  if (top.length === 0) return undefined;
  return top[createHash("sha256").update(seed).digest().readUInt32BE(0) % top.length];
}
