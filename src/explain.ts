import type { OpendrsConfig } from "./domain/config.js";

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
export async function explainFile(_repoDir: string, _path: string, _config: OpendrsConfig): Promise<FileRiskExplanation> {
  throw new Error("not implemented: workstream E");
}
