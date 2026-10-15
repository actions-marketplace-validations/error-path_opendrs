import type { HistoryIndex } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

/** One `git log` pass up to `ref`, bounded by history.maxCommits. */
export async function buildHistoryIndex(_repoDir: string, _ref: string, _config: OpendrsConfig): Promise<HistoryIndex> {
  throw new Error("not implemented: workstream A");
}
