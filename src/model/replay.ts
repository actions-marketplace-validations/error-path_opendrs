import type { Signal } from "../domain/types.js";
import { computeSignals, makeContext } from "../engine.js";
import { loadDiff } from "../git/diff.js";
import { git } from "../git/exec.js";
import { buildHistoryIndex } from "../git/history.js";
import { buildDependencyGraph } from "../graph/graph.js";
import type { HistoryRunOptions } from "./calibrate.js";
import { labelCommits, loadIncidents } from "./label.js";

/** One historical commit with its point-in-time signals and label. */
export interface ReplayRow {
  sha: string;
  /** Unix seconds (committer date: rebases and cherry-picks keep old author dates). */
  time: number;
  label: 0 | 1;
  signals: Signal[];
}

export interface ReplayResult {
  rows: ReplayRow[];
  /** Commits left out because their diff or signals could not be read. */
  skipped: number;
  /** Lines for the user: unresolved incidents, then the skipped count when non-zero. */
  warnings: string[];
}

export const GRAPH_APPROXIMATION_NOTE =
  "blast.* signals use the import graph at the newest commit for every replayed commit (an approximation: older commits see later dependents).";

const CONCURRENCY = 8;

/**
 * Walk non-merge commits newest-first (bounded by since/maxCommits) and compute each commit's
 * signals as of its parent: diff parent..sha, history cut at the commit time.
 */
export async function replayHistory(opts: HistoryRunOptions): Promise<ReplayResult> {
  const { repoDir, config } = opts;
  const head = (await git(repoDir, ["rev-parse", "--verify", `${opts.head ?? "HEAD"}^{commit}`])).trim();
  const history = await buildHistoryIndex(repoDir, head, config);
  // Built once at head and shared by every commit: rebuilding the graph per commit is too slow.
  // See GRAPH_APPROXIMATION_NOTE; backtest reports carry it.
  const graph = config.graph.enabled ? await buildDependencyGraph(repoDir, head, config).catch(() => undefined) : undefined;

  let commits = history.commits.filter((c) => c.parents.length === 1);
  if (opts.since) {
    const inWindow = new Set((await git(repoDir, ["rev-list", `--since=${opts.since}`, head])).split("\n").filter(Boolean));
    commits = commits.filter((c) => inWindow.has(c.sha));
  }
  commits = commits.slice(0, opts.maxCommits ?? config.history.maxCommits);

  const warnings: string[] = [];
  let labels: Map<string, 0 | 1>;
  if (opts.labels) {
    const given = opts.labels;
    const found = commits.filter((c) => given.has(c.sha));
    const missing = given.size - found.length;
    if (missing > 0) warnings.push(`${missing} labelled commits not found in the history up to ${opts.head ?? "HEAD"}`);
    commits = found;
    labels = given;
  } else {
    // Label maturity: the newest commits' bugs are mostly not found yet, so their 0 labels are
    // unreliable. They stay in the history index (their fixes still label older commits).
    const days = config.history.labelHorizonDays;
    const cutoff = commits.reduce((newest, c) => Math.max(newest, c.time), -Infinity) - days * 86_400;
    const matured = commits.filter((c) => c.time <= cutoff);
    const excluded = commits.length - matured.length;
    if (excluded > 0) warnings.push(`${excluded} commits newer than ${days} days excluded from evaluation (their bugs may not be found yet)`);
    commits = matured;

    const labelled = await labelCommits(repoDir, history, config, await loadIncidents(repoDir), (w) => warnings.push(w));
    labels = new Map(labelled.map((l) => [l.sha, l.label]));
  }

  const rows = await mapLimit(
    commits,
    CONCURRENCY,
    async (c): Promise<ReplayRow | undefined> => {
      try {
        const diff = await loadDiff(repoDir, c.parents[0]!, c.sha, config, { resolved: true });
        const ctx = makeContext(repoDir, diff, config, history, graph, c.time);
        return { sha: c.sha, time: c.time, label: labels.get(c.sha) ?? 0, signals: await computeSignals(ctx) };
      } catch {
        // One unreadable commit (e.g. a shallow-clone boundary) must not abort a long replay.
        return undefined;
      }
    },
    (done) => opts.onProgress?.(done, commits.length),
  );
  const read = rows.filter((r): r is ReplayRow => r !== undefined);
  const skipped = rows.length - read.length;
  if (skipped > 0) warnings.push(`${skipped} commits skipped (unreadable)`);
  return { rows: read, skipped, warnings };
}

/** Map with at most `limit` tasks in flight; results keep input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>, onDone?: (done: number) => void): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
