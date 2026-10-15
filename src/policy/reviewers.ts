import type { HistoryIndex } from "../domain/types.js";

const RECENT_SECONDS = 90 * 86_400;

const isBot = (email: string) => email.includes("[bot]") || email === "noreply@github.com" || email === "actions@github.com";

/**
 * Top-n authors (lowercased emails) of `paths`, excluding `exclude` and bots. Each commit counts
 * once; commits within 90 days of the newest commit in history count double. Ties go to the most
 * recent committer, then alphabetical email.
 */
export function suggestReviewers(history: HistoryIndex, paths: string[], exclude: string | undefined, n = 3): string[] {
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
      t.score += now - c.time <= RECENT_SECONDS ? 2 : 1;
      t.latest = Math.max(t.latest, c.time);
      tally.set(email, t);
    }
  }
  return [...tally]
    .sort(([ea, a], [eb, b]) => b.score - a.score || b.latest - a.latest || (ea < eb ? -1 : 1))
    .slice(0, n)
    .map(([email]) => email);
}
