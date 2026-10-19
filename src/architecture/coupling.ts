import type { CommitInfo } from "../domain/types.js";
import type { Detector } from "./index.js";
import { matchAny } from "../git/glob.js";
import { code } from "../report/escape.js";
import { languageFamily } from "../signals/language.js";
import { asOfOrNow, plural } from "../signals/util.js";

/** Spec §6.1: a commit touching more than this many files is a mass refactor, excluded from support. */
const MAX_FILES_PER_COMMIT = 30;

export interface CouplingPair {
  file: string;
  partner: string;
  support: number;
  total: number;
}

export interface CouplingPairsOptions {
  minSupport: number;
  minConfidence: number;
  maxFilesPerCommit: number;
  /** True for a file that cannot be A or B (docs, lockfiles, ignored paths). */
  exclude: (path: string) => boolean;
}

/** Spec §6.1: for each file in `changed` (that is not excluded), its highest-confidence co-changing partner, if any meets the thresholds. Pure over a commit list already restricted to the lookback window. */
export function couplingPairs(commits: readonly CommitInfo[], changed: readonly string[], opts: CouplingPairsOptions): CouplingPair[] {
  const changedSet = new Set(changed);
  const kept = commits.filter((c) => c.files.length <= opts.maxFilesPerCommit);
  const result: CouplingPair[] = [];
  for (const file of changed) {
    if (opts.exclude(file)) continue;
    const touching = kept.filter((c) => c.files.includes(file));
    const total = touching.length;
    if (total === 0) continue;
    const support = new Map<string, number>();
    for (const c of touching) {
      for (const partner of c.files) {
        if (partner === file || changedSet.has(partner) || opts.exclude(partner)) continue;
        support.set(partner, (support.get(partner) ?? 0) + 1);
      }
    }
    let best: CouplingPair | undefined;
    for (const [partner, sup] of support) {
      if (sup < opts.minSupport || sup / total < opts.minConfidence) continue;
      const candidate: CouplingPair = { file, partner, support: sup, total };
      if (!best || isHigherConfidence(candidate, best)) best = candidate;
    }
    if (best) result.push(best);
  }
  return result;
}

/** Spec §6.1: ties broken by higher support, then path order. */
function isHigherConfidence(a: CouplingPair, b: CouplingPair): boolean {
  const ca = a.support / a.total;
  const cb = b.support / b.total;
  if (ca !== cb) return ca > cb;
  if (a.support !== b.support) return a.support > b.support;
  return a.partner < b.partner;
}

/** A file this detector never treats as A or B: docs, lockfiles and other ignored paths (spec §6.1). */
function excluded(ctx: { config: { paths: { ignore: readonly string[] } } }, path: string): boolean {
  return matchAny(ctx.config.paths.ignore, path) || languageFamily(path) === "docs";
}

/** Spec §6.1: files that historically change together, where this PR changed only one of them. */
export const detectCoupling: Detector = async (ctx) => {
  const cfg = ctx.config.captain.coupling;
  if (!cfg.enabled) return { facts: [], notes: [] };

  const days = ctx.config.history.lookbackDays;
  const now = asOfOrNow(ctx);
  const from = now - days * 86_400;
  const commits = ctx.history.commits.filter((c) => c.time >= from && c.time < now);
  const changed = ctx.diff.files.filter((f) => !f.ignored).map((f) => f.path);

  const pairs = couplingPairs(commits, changed, {
    minSupport: cfg.minSupport,
    minConfidence: cfg.minConfidence,
    maxFilesPerCommit: MAX_FILES_PER_COMMIT,
    exclude: (path) => excluded(ctx, path),
  });

  const facts = [];
  for (const pair of pairs) {
    if ((await ctx.readHead(pair.partner)) === undefined) continue;
    facts.push({
      id: "coupling.missing" as const,
      weight: "strong" as const,
      file: pair.file,
      text: `${code(pair.partner)} changed with ${code(pair.file)} in ${pair.support} of ${pair.total} commits (last ${plural(days, "day")}); this PR changes only ${code(pair.file)}.`,
    });
  }
  return { facts, notes: [] };
};
