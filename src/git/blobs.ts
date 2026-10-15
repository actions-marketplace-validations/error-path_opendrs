import { spawn } from "node:child_process";
import { OpendrsError } from "../domain/types.js";

/** Stream blob contents through ONE `git cat-file --batch`; `onBlob` gets the index into `shas`. */
export function readBlobs(repoDir: string, shas: string[], onBlob: (index: number, content: Buffer) => void): Promise<void> {
  if (shas.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const proc = spawn("git", ["--no-pager", "cat-file", "--batch"], { cwd: repoDir, timeout: 120_000 });
    let pending: Buffer = Buffer.alloc(0);
    // Chunks of a large blob body are parked and joined once, not re-concatenated per chunk.
    let parked: Buffer[] = [];
    let parkedBytes = 0;
    let index = 0;
    let need = -1; // bytes of the current blob body, or -1 while waiting for a header
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      if (need >= 0 && pending.length + parkedBytes + chunk.length < need + 1) {
        parked.push(chunk);
        parkedBytes += chunk.length;
        return;
      }
      pending = Buffer.concat([pending, ...parked, chunk]);
      parked = [];
      parkedBytes = 0;
      let pos = 0;
      for (;;) {
        if (need < 0) {
          const nl = pending.indexOf(10, pos);
          if (nl < 0) break;
          const header = pending.toString("latin1", pos, nl);
          pos = nl + 1;
          // "<name> missing" / "<name> ambiguous": the name itself may contain spaces and digits.
          if (header.endsWith(" missing") || header.endsWith(" ambiguous")) {
            index++;
            continue;
          }
          need = Number(header.split(" ")[2]);
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

/**
 * File reader for one scoring context. Reads requested in the same event-loop turn share one
 * `git cat-file --batch` process instead of one `git show` each.
 */
export function createBlobReader(repoDir: string): (rev: string, path: string) => Promise<string | undefined> {
  let queue: Array<{ name: string; resolve: (v: string | undefined) => void; reject: (e: unknown) => void }> = [];
  const flush = () => {
    const batch = queue;
    queue = [];
    const results = new Array<string | undefined>(batch.length);
    readBlobs(repoDir, batch.map((b) => b.name), (i, content) => (results[i] = content.toString("utf8"))).then(
      () => batch.forEach((b, i) => b.resolve(results[i])),
      (e: unknown) => batch.forEach((b) => b.reject(e)),
    );
  };
  return (rev, path) =>
    new Promise((resolve, reject) => {
      // cat-file --batch reads one name per line; a line break in the path would desync later reads.
      if (/[\n\r]/.test(path)) return resolve(undefined);
      if (queue.push({ name: `${rev}:${path}`, resolve, reject }) === 1) setImmediate(flush);
    });
}
