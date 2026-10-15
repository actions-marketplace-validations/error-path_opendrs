import type { HistoryIndex, Incident, LabelledCommit } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

/** Read `.opendrs/incidents.jsonl` (one Incident per line); missing file = []. Workstream A. */
export async function loadIncidents(_repoDir: string): Promise<Incident[]> {
  throw new Error("not implemented: workstream A");
}

/**
 * Label every non-merge commit in `history`: positive when reverted, blamed by SZZ-lite from a
 * fix commit, or named by an incident. Spec §5. Workstream A.
 */
export async function labelCommits(
  _repoDir: string,
  _history: HistoryIndex,
  _config: OpendrsConfig,
  _incidents: Incident[],
): Promise<LabelledCommit[]> {
  throw new Error("not implemented: workstream A");
}
