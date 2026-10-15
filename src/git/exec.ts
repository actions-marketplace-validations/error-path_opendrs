import { execFile } from "node:child_process";
import { OpendrsError } from "../domain/types.js";

const MAX_BUFFER = 256 * 1024 * 1024;

/** Run git without a shell. Throws OpendrsError("git") with stderr on failure. */
export function git(repoDir: string, args: string[], opts: { timeoutMs?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
      { cwd: repoDir, maxBuffer: MAX_BUFFER, timeout: opts.timeoutMs ?? 120_000, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) reject(new OpendrsError(`git ${args[0]} failed: ${(stderr || err.message).trim()}`, "git"));
        else resolve(stdout);
      },
    );
  });
}

/** Like git(), but returns undefined instead of throwing (e.g. `git show` of a missing path). */
export async function gitMaybe(repoDir: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(repoDir, args);
  } catch {
    return undefined;
  }
}
