import type { ChangedFile, DiffInfo, Hunk } from "../domain/types.js";
import { OpendrsError } from "../domain/types.js";
import type { OpendrsConfig } from "../domain/config.js";
import { git } from "./exec.js";
import { matchAny } from "./glob.js";

/** Git's well-known empty tree. Pass it as `base` to score a root commit. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Parse `git diff --no-color -M` unified output into ChangedFile[] (ignored=false; caller applies globs). */
export function parseUnifiedDiff(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const rows = text.split("\n");
  let cur: ChangedFile | undefined;
  let oldSide: string | undefined;
  const finish = () => {
    if (!cur) return;
    if (cur.status === "deleted" && oldSide !== undefined) cur.path = oldSide;
    if (cur.status !== "renamed") delete cur.oldPath;
  };

  for (let i = 0; i < rows.length; i++) {
    const line = rows[i]!;
    if (line.startsWith("diff --git ")) {
      finish();
      const [a, b] = headerPaths(line.slice("diff --git ".length));
      oldSide = a;
      cur = { path: b, oldPath: a, status: "modified", added: 0, deleted: 0, binary: false, hunks: [], ignored: false };
      files.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith("@@")) {
      i = readHunk(rows, i, cur);
    } else if (line.startsWith("new file mode")) cur.status = "added";
    else if (line.startsWith("deleted file mode")) cur.status = "deleted";
    else if (line.startsWith("rename from ")) {
      cur.status = "renamed";
      cur.oldPath = oldSide = unquotePath(line.slice("rename from ".length));
    } else if (line.startsWith("rename to ")) cur.path = unquotePath(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ") || line === "GIT binary patch") cur.binary = true;
    else if (line.startsWith("--- ")) {
      const p = sidePath(line.slice(4), "a/");
      if (p !== undefined) oldSide = p;
    } else if (line.startsWith("+++ ")) {
      const p = sidePath(line.slice(4), "b/");
      if (p !== undefined) cur.path = p;
    }
  }
  finish();
  return files;
}

/** Consume one hunk by its line counts (so content resembling headers is never misread). Returns the last row index used. */
function readHunk(rows: string[], start: number, file: ChangedFile): number {
  const m = HUNK_HEADER.exec(rows[start]!);
  if (!m) return start;
  const hunk: Hunk = {
    oldStart: Number(m[1]),
    oldLines: m[2] === undefined ? 1 : Number(m[2]),
    newStart: Number(m[3]),
    newLines: m[4] === undefined ? 1 : Number(m[4]),
    lines: [],
  };
  file.hunks.push(hunk);
  let oldLeft = hunk.oldLines;
  let newLeft = hunk.newLines;
  let i = start + 1;
  for (; i < rows.length; i++) {
    const line = rows[i]!;
    const marker = line[0];
    if (marker === "\\") {
      hunk.lines.push(line);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) break;
    if (marker === "+") {
      newLeft--;
      file.added++;
    } else if (marker === "-") {
      oldLeft--;
      file.deleted++;
    } else if (marker === " " || line === "") {
      oldLeft--;
      newLeft--;
    } else break;
    hunk.lines.push(line);
  }
  return i - 1;
}

/** Split `a/X b/Y` from a `diff --git` header; rename/---/+++ lines refine it later. */
function headerPaths(rest: string): [string, string] {
  if (rest.startsWith('"')) {
    const [a, end] = readQuoted(rest, 0);
    const tail = rest.slice(end + 1);
    return [stripPrefix(a, "a/"), stripPrefix(unquotePath(tail), "b/")];
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && rest.slice(2, 2 + len) === rest.slice(len + 5)) {
    const p = rest.slice(2, 2 + len);
    return [p, p];
  }
  const sep = rest.indexOf(" b/");
  if (sep < 0) return [rest, rest];
  return [stripPrefix(rest.slice(0, sep), "a/"), unquotePath(rest.slice(sep + 3))];
}

function sidePath(raw: string, prefix: string): string | undefined {
  // git appends a tab to ---/+++ names that contain spaces.
  const name = raw.endsWith("\t") ? raw.slice(0, -1) : raw;
  if (name === "/dev/null") return undefined;
  return stripPrefix(unquotePath(name), prefix);
}

function stripPrefix(p: string, prefix: string): string {
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

/** Decode a git C-style quoted path (`"a\tb\303\274"`); unquoted input is returned as is. */
export function unquotePath(s: string): string {
  if (!s.startsWith('"')) return s;
  return readQuoted(s, 0)[0];
}

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** Read a quoted token starting at `start`; returns the decoded value and the index of the closing quote. */
function readQuoted(s: string, start: number): [string, number] {
  const bytes: number[] = [];
  let i = start + 1;
  for (; i < s.length && s[i] !== '"'; i++) {
    const c = s[i]!;
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const next = s[++i] ?? "";
    if (/[0-7]/.test(next)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
  }
  return [Buffer.from(bytes).toString("utf8"), i];
}

/**
 * Diff between merge-base(base, head) and head. Applies `paths.ignore`, resolves shas,
 * and fills author/title from the head commit. `resolved: true` means base and head are already
 * commit shas with base an ancestor of head (history replay), which skips three git calls.
 */
export async function loadDiff(
  repoDir: string,
  base: string,
  head: string,
  config: OpendrsConfig,
  opts: { resolved?: boolean } = {},
): Promise<DiffInfo> {
  const headSha = opts.resolved ? head : await resolveCommit(repoDir, head);
  const baseSha =
    opts.resolved || base === EMPTY_TREE ? base : await mergeBase(repoDir, await resolveCommit(repoDir, base), headSha);
  const [text, meta] = await Promise.all([
    // Explicit prefixes and no textconv keep the output parseable whatever the user's git config says.
    git(repoDir, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "-M", "--unified=3", baseSha, headSha]),
    git(repoDir, ["show", "-s", "--format=%an%x00%ae%x00%s", headSha]),
  ]);
  const files = parseUnifiedDiff(text);
  for (const f of files) f.ignored = matchAny(config.paths.ignore, f.path);
  const [name = "", email = "", title = ""] = meta.replace(/\n$/, "").split("\0");
  return {
    base: baseSha,
    head: headSha,
    files,
    author: email ? { name, email } : undefined,
    title,
  };
}

async function resolveCommit(repoDir: string, ref: string): Promise<string> {
  try {
    return (await git(repoDir, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`])).trim();
  } catch {
    throw new OpendrsError(`Cannot resolve git ref "${ref}" to a commit`, "git");
  }
}

async function mergeBase(repoDir: string, a: string, b: string): Promise<string> {
  try {
    return (await git(repoDir, ["merge-base", a, b])).trim();
  } catch {
    throw new OpendrsError(`No merge-base between ${a} and ${b} (unrelated histories?)`, "git");
  }
}
