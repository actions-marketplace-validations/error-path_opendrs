import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { CommitInfo, HistoryIndex, Hunk, Incident, LabelledCommit } from "../domain/types.js";
import { OpendrsError } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { parseUnifiedDiff } from "../git/diff.js";
import { gitMaybe } from "../git/exec.js";
import { matchAny } from "../git/glob.js";

export const INCIDENTS_FILE = ".opendrs/incidents.jsonl";
const MAX_FIX_COMMITS = 2000;
const CONCURRENCY = Math.max(2, availableParallelism());

type Source = NonNullable<LabelledCommit["source"]>;
const RANK: Record<Source, number> = { szz: 1, revert: 2, incident: 3 };

const incidentSchema = z.object({
  inducing: z.string().optional(),
  fix: z.string().optional(),
  paths: z.array(z.string()).optional(),
  note: z.string().optional(),
});

/** Read `.opendrs/incidents.jsonl` (one Incident per line); missing file = []. */
export async function loadIncidents(repoDir: string): Promise<Incident[]> {
  let text: string;
  try {
    text = await readFile(join(repoDir, INCIDENTS_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new OpendrsError(`Cannot read ${INCIDENTS_FILE}: ${(e as Error).message}`, "io");
  }
  const incidents: Incident[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new OpendrsError(`${INCIDENTS_FILE} line ${i + 1}: ${(e as Error).message}`, "config");
    }
    const parsed = incidentSchema.safeParse(raw);
    if (!parsed.success) throw new OpendrsError(`${INCIDENTS_FILE} line ${i + 1}: ${z.prettifyError(parsed.error)}`, "config");
    incidents.push(parsed.data);
  });
  return incidents;
}

/**
 * Label every non-merge commit in `history`: positive when reverted, blamed by SZZ-lite from a
 * fix commit, or named by an incident. Precedence incident > revert > szz. Newest first.
 */
export async function labelCommits(
  repoDir: string,
  history: HistoryIndex,
  config: OpendrsConfig,
  incidents: Incident[],
  /** Called for each incident sha that cannot be used, so the caller can show it. */
  warn: (message: string) => void = () => {},
): Promise<LabelledCommit[]> {
  const sources = new Map<string, Source>();
  const mark = (sha: string | undefined, source: Source) => {
    if (sha === undefined) return;
    const prev = sources.get(sha);
    if (!prev || RANK[source] > RANK[prev]) sources.set(sha, source);
  };
  const resolve = shaResolver(history.commits);

  for (const c of history.commits) if (c.revertsSha) mark(resolve(c.revertsSha), "revert");
  for (const inc of incidents) {
    if (!inc.inducing) continue;
    const sha = resolve(inc.inducing);
    if (sha) mark(sha, "incident");
    else warn(`${INCIDENTS_FILE}: inducing commit ${inc.inducing} is not in the indexed history; not counted`);
  }

  const jobs: Array<{ sha: string; source: Source }> = history.commits
    .filter((c) => c.isFix && c.parents.length === 1)
    .slice(0, MAX_FIX_COMMITS)
    .map((c) => ({ sha: c.sha, source: "szz" }));
  for (const inc of incidents) {
    if (!inc.fix) continue;
    const sha = resolve(inc.fix) ?? (await gitMaybe(repoDir, ["rev-parse", "--verify", "--quiet", `${inc.fix}^{commit}`]))?.trim();
    if (sha) jobs.push({ sha, source: "incident" });
    else warn(`${INCIDENTS_FILE}: fix commit ${inc.fix} does not resolve in this repository; not counted`);
  }

  await runPool(jobs, CONCURRENCY, async ({ sha, source }) => {
    for (const blamed of await blameFix(repoDir, sha, config.paths.ignore)) mark(resolve(blamed), source);
  });

  return history.commits
    .filter((c) => c.parents.length <= 1)
    .map((c) => {
      const source = sources.get(c.sha);
      return source ? { sha: c.sha, label: 1, source } : { sha: c.sha, label: 0 };
    });
}

/** Map a full or abbreviated sha to a full sha in history (binary search over sorted shas). */
function shaResolver(commits: CommitInfo[]): (prefix: string) => string | undefined {
  const shas = commits.map((c) => c.sha).sort();
  return (prefix) => {
    const p = prefix.toLowerCase();
    let lo = 0;
    let hi = shas.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (shas[mid]! < p) lo = mid + 1;
      else hi = mid;
    }
    const hit = shas[lo];
    return hit?.startsWith(p) ? hit : undefined;
  };
}

/** SZZ-lite: commits that last touched the meaningful lines `sha` deleted or modified, blamed at `sha^`. */
async function blameFix(repoDir: string, sha: string, ignore: string[]): Promise<Set<string>> {
  const blamed = new Set<string>();
  const text = await gitMaybe(repoDir, [
    "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "-U0", `${sha}^`, sha,
  ]);
  if (!text) return blamed;
  for (const file of parseUnifiedDiff(text)) {
    // Whole-file deletions are left out: blaming every line of a removed file is mostly noise.
    if (file.binary || (file.status !== "modified" && file.status !== "renamed")) continue;
    const oldPath = file.oldPath ?? file.path;
    if (matchAny(ignore, oldPath) || matchAny(ignore, file.path)) continue;
    const ranges = deletedRanges(file.hunks);
    if (ranges.length === 0) continue;
    const out = await gitMaybe(repoDir, ["blame", "--porcelain", "-w", ...ranges.flatMap(([a, b]) => ["-L", `${a},${b}`]), `${sha}^`, "--", oldPath]);
    for (const line of out?.split("\n") ?? []) {
      const m = /^([0-9a-f]{40,64}) \d+ \d+/.exec(line);
      if (m) blamed.add(m[1]!);
    }
  }
  return blamed;
}

/** Old-side line ranges of meaningful deleted lines, merged when consecutive. */
function deletedRanges(hunks: Hunk[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const hunk of hunks) {
    let line = hunk.oldStart;
    for (const raw of hunk.lines) {
      if (raw[0] === "-") {
        if (isMeaningful(raw.slice(1))) {
          const last = ranges.at(-1);
          if (last && last[1] === line - 1) last[1] = line;
          else ranges.push([line, line]);
        }
        line++;
      } else if (raw[0] === " ") line++;
    }
  }
  return ranges;
}

// Line comments in common languages. `#` is a comment except C preprocessor / C# directives
// and Rust attributes; `*` only as a block-comment continuation (`* text`, `*/`).
const COMMENT = /^(\/\/|\/\*|\*(\s|\/|$)|<!--|--(\s|$)|#(?!\[|!\[|\s*(include|define|undef|if|ifdef|ifndef|elif|else|endif|pragma|region|endregion)\b))/;

function isMeaningful(content: string): boolean {
  const t = content.trim();
  return t !== "" && !COMMENT.test(t);
}

async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
