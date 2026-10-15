import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, sep } from "node:path";
import { OpendrsError } from "../domain/types.js";
import { git, gitMaybe } from "../git/exec.js";

/** Repository root containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  const top = await gitMaybe(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top) throw new OpendrsError(`not a git repository: ${cwd}`, "git");
  return top.trim();
}

const resolves = async (repoDir: string, ref: string) =>
  (await gitMaybe(repoDir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) !== undefined;

/** origin/HEAD's target when it resolves, else main, else master. */
export async function defaultBase(repoDir: string): Promise<string> {
  const sym = await gitMaybe(repoDir, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const remote = sym?.trim().replace(/^refs\/remotes\//, "");
  if (remote && (await resolves(repoDir, remote))) return remote;
  for (const branch of ["main", "master"]) if (await resolves(repoDir, branch)) return branch;
  throw new OpendrsError("could not find a base branch (origin/HEAD, main or master); pass --base <ref>", "usage");
}

/** Convert a user-supplied path (relative to cwd, or absolute) to a repo-relative posix path. */
export async function toRepoPath(cwd: string, repoDir: string, file: string): Promise<string> {
  if (isAbsolute(file)) {
    const abs = await realpath(file).catch(() => {
      throw new OpendrsError(`file not found: ${file}`, "usage");
    });
    return relative(await realpath(repoDir), abs).split(sep).join("/");
  }
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).trim();
  return posix.normalize(posix.join(prefix, file.split(sep).join("/")));
}
