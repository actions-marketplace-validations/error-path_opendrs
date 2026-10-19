import type { CommitInfo, HistoryIndex } from "../domain/types.js";
import { OpendrsError } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { agentPatterns, classifyCommit } from "../policy/source.js";
import { unquotePath } from "./diff.js";
import { git } from "./exec.js";

// Records start with NUL, which a commit message cannot contain, so a message cannot forge a record.
const RECORD = "\0";
const FIELD = "\x1f";
const END = "\x1d";
const FORMAT = "%x00%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1d";
const REVERTS = /This reverts commit ([0-9a-f]{7,64})/i;

interface Change {
  kind: string; // first letter of git's name-status: A M D R C T
  path: string;
  oldPath?: string;
}

/**
 * Commits that touched one file across renames. `commits` is sorted by time ascending;
 * `adds` are the times/authors of the commits that created it.
 */
interface Lineage {
  commits: CommitInfo[];
  adds: Array<{ time: number; email: string }>;
}

/** One `git log` pass up to `ref`, bounded by history.maxCommits and timed out at history.gitTimeoutMs. */
export async function buildHistoryIndex(repoDir: string, ref: string, config: OpendrsConfig): Promise<HistoryIndex> {
  const fixRe = compileFixPattern(config.history.fixPattern);
  const patterns = agentPatterns(config);
  let out: string;
  try {
    out = await git(
      repoDir,
      ["log", `-n${config.history.maxCommits}`, "--name-status", "-M", "--no-show-signature", `--format=${FORMAT}`, "--end-of-options", ref],
      { timeoutMs: config.history.gitTimeoutMs },
    );
  } catch (e) {
    // A blobless or otherwise slow clone can make this one-time scan outrun the timeout; say so and
    // name the two knobs that fix it, instead of surfacing git's own opaque "Command failed" message.
    if (e instanceof OpendrsError && e.code === "git" && /timed out/.test(e.message)) {
      throw new OpendrsError(`${e.message} while reading history; raise history.gitTimeoutMs or lower history.maxCommits`, "git");
    }
    throw e;
  }

  const commits: CommitInfo[] = [];
  const changes: Change[][] = [];
  for (const record of out.split(RECORD)) {
    // The last END: one inside the body must not turn the rest of the message into file names.
    const end = record.lastIndexOf(END);
    if (end < 0) continue;
    const [sha = "", parents = "", authorName = "", authorEmail = "", time = "0", subject = "", ...body] = record.slice(0, end).split(FIELD);
    const revertsSha = REVERTS.exec(body.join(FIELD))?.[1];
    const fileChanges = parseNameStatus(record.slice(end + 1));
    commits.push({
      sha,
      parents: parents ? parents.split(" ") : [],
      authorName,
      authorEmail,
      time: Number(time),
      subject,
      files: fileChanges.map((c) => c.path),
      isFix: fixRe.test(subject),
      isRevert: subject.startsWith('Revert "') || revertsSha !== undefined,
      ...(revertsSha !== undefined && { revertsSha }),
      source: classifyCommit({ authorName, authorEmail, message: `${subject}\n\n${body.join(FIELD)}` }, patterns).kind,
    });
    changes.push(fileChanges);
  }
  return buildIndex(commits, changes);
}

function compileFixPattern(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "i");
  } catch (e) {
    throw new OpendrsError(`Invalid history.fixPattern: ${(e as Error).message}`, "config");
  }
}

function parseNameStatus(text: string): Change[] {
  const result: Change[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const [status = "", a = "", b] = line.split("\t");
    const kind = status[0] ?? "";
    if ((kind === "R" || kind === "C") && b !== undefined) result.push({ kind, path: unquotePath(b), oldPath: unquotePath(a) });
    else result.push({ kind, path: unquotePath(a) });
  }
  return result;
}

function buildIndex(commits: CommitInfo[], changes: Change[][]): HistoryIndex {
  const lineages: Lineage[] = [];
  // Every lineage a path has pointed at, in history order; a path re-created later gets a new one.
  const bindings = new Map<string, Array<{ time: number; lineage: Lineage }>>();
  const current = new Map<string, Lineage>();
  const authorTimes = new Map<string, number[]>();

  const bind = (path: string, time: number, lineage: Lineage) => {
    current.set(path, lineage);
    const list = bindings.get(path);
    if (list) list.push({ time, lineage });
    else bindings.set(path, [{ time, lineage }]);
  };
  const fresh = (path: string, time: number): Lineage => {
    const lineage: Lineage = { commits: [], adds: [] };
    lineages.push(lineage);
    bind(path, time, lineage);
    return lineage;
  };

  // git log is newest-first; replay oldest-first so renames carry earlier history forward.
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i]!;
    if (commit.parents.length <= 1) {
      const email = commit.authorEmail.toLowerCase();
      const times = authorTimes.get(email);
      if (times) times.push(commit.time);
      else authorTimes.set(email, [commit.time]);
    }
    for (const change of changes[i]!) {
      let lineage: Lineage;
      if (change.kind === "A" || change.kind === "C") {
        lineage = fresh(change.path, commit.time);
        lineage.adds.push({ time: commit.time, email: commit.authorEmail.toLowerCase() });
      } else if (change.kind === "R" && change.oldPath !== undefined) {
        lineage = current.get(change.oldPath) ?? fresh(change.oldPath, commit.time);
        current.delete(change.oldPath);
        bind(change.path, commit.time, lineage);
      } else {
        lineage = current.get(change.path) ?? fresh(change.path, commit.time);
        if (change.kind === "D") current.delete(change.path);
      }
      if (lineage.commits.at(-1) !== commit) lineage.commits.push(commit);
    }
  }

  const byTime = (a: { time: number }, b: { time: number }) => a.time - b.time;
  for (const l of lineages) {
    l.commits.sort(byTime);
    l.adds.sort(byTime);
  }
  for (const times of authorTimes.values()) times.sort((a, b) => a - b);

  const lineageAt = (path: string, asOf?: number): Lineage | undefined => {
    const list = bindings.get(path);
    if (!list) return undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      if (asOf === undefined || list[i]!.time < asOf) return list[i]!.lineage;
    }
    return undefined;
  };

  return {
    commits,
    fileCommits(path, asOf) {
      const lineage = lineageAt(path, asOf);
      if (!lineage) return [];
      const n = asOf === undefined ? lineage.commits.length : countBefore(lineage.commits, asOf, (c) => c.time);
      return lineage.commits.slice(0, n).reverse();
    },
    fileCreator(path, asOf) {
      const lineage = lineageAt(path, asOf);
      if (!lineage) return undefined;
      const n = asOf === undefined ? lineage.adds.length : countBefore(lineage.adds, asOf, (a) => a.time);
      return lineage.adds[n - 1]?.email;
    },
    authorCommitCount(email, asOf) {
      const times = authorTimes.get(email.toLowerCase());
      if (!times) return 0;
      return asOf === undefined ? times.length : countBefore(times, asOf, (t) => t);
    },
  };
}

/** Number of leading items with key < limit in an ascending array (binary search). */
function countBefore<T>(items: readonly T[], limit: number, key: (item: T) => number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(items[mid]!) < limit) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
