import type { ModelWeights } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";

export interface HistoryRunOptions {
  repoDir: string;
  config: OpendrsConfig;
  /** Only commits newer than this (ISO date or git date string). */
  since?: string;
  maxCommits?: number;
  /** Progress callback for CLI output. */
  onProgress?: (done: number, total: number) => void;
}

/** Fit weights on the repo's own labelled history (spec §5). Workstream C. */
export async function calibrate(_opts: HistoryRunOptions): Promise<ModelWeights> {
  throw new Error("not implemented: workstream C");
}
