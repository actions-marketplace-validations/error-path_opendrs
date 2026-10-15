import { spawn } from "node:child_process";
import { OpendrsError } from "../domain/types.js";
import { git } from "../git/exec.js";

export interface TreeEntry {
  path: string;
  sha: string;
  size: number;
}

/** Every blob in a tree, with its size (submodules and symlink targets are not followed). */
export async function listTree(repoDir: string, treeSha: string): Promise<TreeEntry[]> {
  const out = await git(repoDir, ["ls-tree", "-r", "-l", "-z", treeSha]);
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

/** Stream blob contents through ONE `git cat-file --batch`; `onBlob` gets the index into `shas`. */
export function readBlobs(repoDir: string, shas: string[], onBlob: (index: number, content: Buffer) => void): Promise<void> {
  if (shas.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["--no-pager", "cat-file", "--batch"], { cwd: repoDir, timeout: 120_000 });
    let pending: Buffer = Buffer.alloc(0);
    let index = 0;
    let need = -1; // bytes of the current blob body, or -1 while waiting for a header
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let pos = 0;
      for (;;) {
        if (need < 0) {
          const nl = pending.indexOf(10, pos);
          if (nl < 0) break;
          const size = Number(pending.toString("latin1", pos, nl).split(" ")[2]);
          pos = nl + 1;
          if (!Number.isInteger(size)) {
            index++; // "<sha> missing"
            continue;
          }
          need = size;
        }
        if (pending.length - pos < need + 1) break;
        onBlob(index++, pending.subarray(pos, pos + need));
        pos += need + 1;
        need = -1;
      }
      pending = pending.subarray(pos);
    });
    proc.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    proc.stdin.on("error", () => {}); // reported via the exit code instead
    proc.on("error", (e) => reject(new OpendrsError(`git cat-file failed: ${e.message}`, "git")));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new OpendrsError(`git cat-file failed: ${stderr.trim() || `exit ${code}`}`, "git"));
    });
    proc.stdin.end(`${shas.join("\n")}\n`);
  });
}
