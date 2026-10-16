import type { OpendrsConfig } from "./domain/config.js";
import { git } from "./git/exec.js";
import { matchAny } from "./git/glob.js";
import { buildHistoryIndex } from "./git/history.js";
import { buildDependencyGraph } from "./graph/graph.js";

export interface Hotspot {
  rank: number;
  score: number;
  path: string;
  commits: number;
  fixCommits: number;
  authors: number;
  transitiveDependents: number | null; // null = language unsupported by the import graph
  critical: boolean;
  blocked: boolean;
}

/**
 * Risk-at-rest weights (after Mockus et al., "Metrics Driven Reengineering at Meta", ASE 2025):
 * fix-prone files dominate, churn and blast radius add, a critical path adds a flat bonus.
 * Every term is log1p of a count, so the score is monotone in each input and ties are rare.
 */
const WEIGHTS = { fixCommits: 2, commits: 1, transitiveDependents: 0.5, critical: 1 } as const;

export function hotspotScore(h: Pick<Hotspot, "fixCommits" | "commits" | "transitiveDependents" | "critical">): number {
  return (
    Math.log1p(h.fixCommits) * WEIGHTS.fixCommits +
    Math.log1p(h.commits) * WEIGHTS.commits +
    Math.log1p(h.transitiveDependents ?? 0) * WEIGHTS.transitiveDependents +
    (h.critical ? WEIGHTS.critical : 0)
  );
}

/** Rank the files tracked at HEAD by code-at-rest risk over the lookback window. One history pass, one graph build. */
export async function hotspots(repoDir: string, config: OpendrsConfig, top = 20): Promise<Hotspot[]> {
  const [listing, history, graph] = await Promise.all([
    git(repoDir, ["ls-files", "-z"]),
    buildHistoryIndex(repoDir, "HEAD", config),
    config.graph.enabled ? buildDependencyGraph(repoDir, "HEAD", config).catch(() => undefined) : undefined,
  ]);
  const from = Date.now() / 1000 - config.history.lookbackDays * 86_400;

  const rows: Omit<Hotspot, "rank">[] = [];
  for (const path of listing.split("\0")) {
    if (!path || matchAny(config.paths.ignore, path)) continue;
    let commits = 0;
    let fixCommits = 0;
    const authors = new Set<string>();
    // fileCommits is newest-first, so stop at the first commit older than the window.
    for (const c of history.fileCommits(path)) {
      if (c.time < from) break;
      commits++;
      if (c.isFix || c.isRevert) fixCommits++;
      authors.add(c.authorEmail.toLowerCase());
    }
    const row = {
      path,
      commits,
      fixCommits,
      authors: authors.size,
      transitiveDependents: graph?.supports(path) ? graph.transitiveDependents(path, config.graph.maxDepth).size : null,
      critical: matchAny(config.paths.critical, path, { ignoreCase: true }),
      blocked: matchAny(config.paths.block, path, { ignoreCase: true }),
    };
    rows.push({ ...row, score: hotspotScore(row) });
  }

  rows.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.slice(0, top).map((r, i) => ({ rank: i + 1, ...r }));
}
