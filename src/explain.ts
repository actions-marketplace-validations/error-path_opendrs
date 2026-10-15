import type { OpendrsConfig } from "./domain/config.js";
import { OpendrsError } from "./domain/types.js";
import { matchAny } from "./cli/glob-lite.js";
import { gitMaybe } from "./git/exec.js";
import { buildHistoryIndex } from "./git/history.js";
import { buildDependencyGraph } from "./graph/graph.js";

export interface FileRiskExplanation {
  path: string;
  commits: number;
  fixCommits: number;
  authors: number;
  directDependents: number | null; // null = language unsupported by the import graph
  transitiveDependents: number | null;
  critical: boolean;
  blocked: boolean;
  topAuthors: string[];
}

/** Standing risk profile of one file at HEAD (used by `opendrs explain` and MCP). Workstream E. */
export async function explainFile(repoDir: string, path: string, config: OpendrsConfig): Promise<FileRiskExplanation> {
  path = path.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const [history, graph] = await Promise.all([
    buildHistoryIndex(repoDir, "HEAD", config),
    config.graph.enabled ? buildDependencyGraph(repoDir, "HEAD", config).catch(() => undefined) : undefined,
  ]);

  const commits = history.fileCommits(path);
  if (commits.length === 0 && (await gitMaybe(repoDir, ["cat-file", "-e", `HEAD:${path}`])) === undefined) {
    throw new OpendrsError(`${path} is not tracked at HEAD and has no history`, "usage");
  }

  // Commits are newest first, so the stable sort breaks count ties by recency.
  const byAuthor = new Map<string, number>();
  for (const c of commits) byAuthor.set(c.authorEmail, (byAuthor.get(c.authorEmail) ?? 0) + 1);
  const topAuthors = [...byAuthor].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([email]) => email);

  const supported = graph?.supports(path) ?? false;
  return {
    path,
    commits: commits.length,
    fixCommits: commits.filter((c) => c.isFix || c.isRevert).length,
    authors: byAuthor.size,
    directDependents: graph && supported ? graph.dependentsOf(path).length : null,
    transitiveDependents: graph && supported ? graph.transitiveDependents(path, config.graph.maxDepth).size : null,
    critical: matchAny(config.paths.critical, path),
    blocked: matchAny(config.paths.block, path),
    topAuthors,
  };
}
