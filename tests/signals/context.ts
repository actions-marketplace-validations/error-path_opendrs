import { defaultConfig, type OpendrsConfig } from "../../src/domain/config.js";
import type { ScoringContext, Signal } from "../../src/domain/types.js";
import { makeContext } from "../../src/engine.js";
import { loadDiff } from "../../src/git/diff.js";
import { buildHistoryIndex } from "../../src/git/history.js";
import type { TestRepo } from "../helpers/repo.js";

/** A real ScoringContext for `base..head`, built the way the engine builds it. */
export async function contextFor(repo: TestRepo, base: string, head = "HEAD", opts: { config?: OpendrsConfig; asOf?: number } = {}): Promise<ScoringContext> {
  const config = opts.config ?? defaultConfig();
  const diff = await loadDiff(repo.dir, base, head, config);
  const history = await buildHistoryIndex(repo.dir, diff.base, config);
  return makeContext(repo.dir, diff, config, history, undefined, opts.asOf);
}

export function byId(signals: Signal[], id: string): Signal {
  const s = signals.find((x) => x.id === id);
  if (!s) throw new Error(`signal ${id} missing; got ${signals.map((x) => x.id).join(", ")}`);
  return s;
}
