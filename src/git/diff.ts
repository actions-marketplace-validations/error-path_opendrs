import type { ChangedFile, DiffInfo } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

/** Parse `git diff --no-color -M` unified output into ChangedFile[] (ignored=false; caller applies globs). */
export function parseUnifiedDiff(_text: string): ChangedFile[] {
  throw new Error("not implemented: workstream A");
}

/**
 * Diff between merge-base(base, head) and head. Applies `paths.ignore`, resolves shas,
 * and fills author/title from the head commit.
 */
export async function loadDiff(_repoDir: string, _base: string, _head: string, _config: OpendrsConfig): Promise<DiffInfo> {
  throw new Error("not implemented: workstream A");
}
