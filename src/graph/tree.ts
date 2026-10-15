import { git } from "../git/exec.js";

export { readBlobs } from "../git/blobs.js";

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

/** Every blob in a tree, with its size (submodules and symlink targets are not followed). */
export async function listTree(repoDir: string, treeSha: string): Promise<TreeEntry[]> {
  const out = await git(repoDir, ["ls-tree", "--full-tree", "-r", "-l", "-z", treeSha]);
  const entries: TreeEntry[] = [];
  for (const record of out.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, sha, size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob" || !sha) continue;
    entries.push({ path: record.slice(tab + 1), sha, size: Number(size) });
  }
  return entries;
}
