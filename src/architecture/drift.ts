import type { ArchitectureFact } from "../domain/types.js";
import { git, gitMaybe } from "../git/exec.js";
import { matchAny } from "../git/glob.js";
import { buildDependencyGraph } from "../graph/graph.js";
import { untrusted } from "../report/escape.js";
import type { Detector } from "./index.js";
import { moduleOf } from "./module.js";

interface DiffStats {
  files: Set<string>;
  /** Added + deleted lines, ignored paths excluded. */
  churn: number;
}

/** Whether `sha` is in the checkout; if not, one `git fetch --no-tags origin <sha>` retry (spec §6.4). */
async function ensureCommit(repoDir: string, sha: string): Promise<boolean> {
  if ((await gitMaybe(repoDir, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined) return true;
  await gitMaybe(repoDir, ["fetch", "--no-tags", "origin", sha]);
  return (await gitMaybe(repoDir, ["cat-file", "-e", `${sha}^{commit}`])) !== undefined;
}

/** The three-dot diff `base...sha`'s changed files and total churn, ignored paths excluded. */
async function diffStats(repoDir: string, base: string, sha: string, ignore: readonly string[]): Promise<DiffStats> {
  const out = await git(repoDir, ["diff", "--numstat", "--no-renames", `${base}...${sha}`]);
  const files = new Set<string>();
  let churn = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [addedStr, deletedStr, path] = line.split("\t");
    if (path === undefined || matchAny(ignore, path)) continue;
    files.add(path);
    const added = Number(addedStr);
    const deleted = Number(deletedStr);
    if (!Number.isNaN(added) && !Number.isNaN(deleted)) churn += added + deleted; // binary files report "-\t-": no churn
  }
  return { files, churn };
}

/** Spec §6.4: what the PR picked up since opendrs's first scored head, run in the Action only. */
export const detectDrift: Detector = async (ctx, opts) => {
  const { firstHead, firstRun } = opts;
  if (firstHead === undefined) return { facts: [], notes: ["drift: not tracked here"] };
  if (firstHead === ctx.diff.head) return { facts: [], notes: [] };
  if (!(await ensureCommit(ctx.repoDir, firstHead))) return { facts: [], notes: ["drift: the first scored head is no longer reachable"] };

  const ignore = ctx.config.paths.ignore;
  const base = ctx.diff.base;

  // The module map (spec §6.2) is computed once, from head's current manifests, the same way
  // reused by layers; reuse the tree-sha-cached graph instead of a flat depth here too
  // (module-boundaries spec §6). graph.enabled off, or a failed build, falls back to flat depth.
  const graph = ctx.config.graph.enabled ? await buildDependencyGraph(ctx.repoDir, ctx.diff.head, ctx.config).catch(() => undefined) : undefined;
  const fallbackDepth = ctx.config.captain.moduleDepth ?? 2;
  const moduleOfPath = (path: string) => graph?.moduleOf(path) ?? moduleOf(path, fallbackDepth);

  const first = await diffStats(ctx.repoDir, base, firstHead, ignore);
  const head = await diffStats(ctx.repoDir, base, ctx.diff.head, ignore);
  const modules1 = new Set([...first.files].map(moduleOfPath));
  const newFiles = [...head.files].filter((f) => !first.files.has(f)).sort();
  const outside = newFiles.filter((f) => !modules1.has(moduleOfPath(f)));

  const churnGrew = head.churn - first.churn;
  const churnDoubled = head.churn >= first.churn * 2 && churnGrew > 100;
  if (outside.length === 0 && !churnDoubled) return { facts: [], notes: [] };

  const since =
    firstRun !== undefined && firstRun > 1
      ? `Since run ${firstRun} at \`${firstHead.slice(0, 7)}\``
      : `Since opendrs first scored this PR at \`${firstHead.slice(0, 7)}\` (run 1)`;
  const outsideText =
    outside.length > 0
      ? `; ${outside.length} new file${outside.length === 1 ? "" : "s"} are outside the original modules: ${outside.map((f) => `\`${untrusted(f)}\``).join(", ")}`
      : "";
  const text = `${since}, it grew from ${first.files.size} to ${head.files.size} files (+${first.churn} → +${head.churn} lines)${outsideText}.`;
  const file = outside[0] ?? newFiles[0] ?? [...head.files].sort()[0] ?? "";

  const fact: ArchitectureFact = { id: "drift.scope", weight: outside.length >= 3 || churnDoubled ? "strong" : "info", file, text };
  return { facts: [fact], notes: [] };
};
