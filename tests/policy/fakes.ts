import type { CommitInfo, HistoryIndex } from "../../src/domain/types.js";

export const NOW = 1_760_000_000;
export const DAY = 86_400;

let seq = 0;
export function fakeCommit(email: string, files: string[], daysAgo: number): CommitInfo {
  return {
    sha: `sha${++seq}`,
    parents: ["p"],
    authorName: email.split("@")[0]!,
    authorEmail: email,
    time: NOW - daysAgo * DAY,
    subject: "change",
    files,
    isFix: false,
    isRevert: false,
    source: "human",
  };
}

/** In-memory HistoryIndex honouring the `asOf` contract (time < asOf). */
export function fakeHistory(commits: CommitInfo[]): HistoryIndex {
  const sorted = [...commits].sort((a, b) => b.time - a.time);
  const visible = (asOf?: number) => sorted.filter((c) => asOf === undefined || c.time < asOf);
  return {
    commits: sorted,
    fileCommits: (path, asOf) => visible(asOf).filter((c) => c.files.includes(path)),
    fileCreator: (path, asOf) => visible(asOf).filter((c) => c.files.includes(path)).at(-1)?.authorEmail,
    authorCommitCount: (email, asOf) => visible(asOf).filter((c) => c.authorEmail === email).length,
  };
}
