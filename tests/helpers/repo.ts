import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface TestRepo {
  dir: string;
  /** Write files (null deletes) and commit; returns the new sha. */
  commit(files: Record<string, string | null>, message: string, author?: { name: string; email: string }, time?: number): string;
  git(...args: string[]): string;
  cleanup(): void;
}

const DEFAULT_AUTHOR = { name: "Alice", email: "alice@example.com" };
let clock = 1_700_000_000;

// The five `git config` child-process spawns this helper used to make per repo (user.name,
// user.email, commit.gpgsign, gc.auto, maintenance.auto) measurably add up: this fixture backs
// most of the test suite's wall time (see docs/research/2026-10-22-dev-loop-time-sinks.md).
// Writing them straight into `.git/config` with fs (one spawn, `init`, instead of six) gets the
// same one-spawn win but, unlike setting them via env vars, also covers git processes a test runs
// directly against repo.dir (e.g. execFileSync) rather than through this helper's `run`.
const REPO_GIT_CONFIG = `[user]
\tname = ${DEFAULT_AUTHOR.name}
\temail = ${DEFAULT_AUTHOR.email}
[commit]
\tgpgsign = false
[gc]
\tauto = 0
[maintenance]
\tauto = false
`;

/** Create a real temporary git repository for tests. */
export function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "opendrs-test-"));
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  run(["init", "-q", "-b", "main"]);
  appendFileSync(join(dir, ".git", "config"), REPO_GIT_CONFIG);
  return {
    dir,
    commit(files, message, author = DEFAULT_AUTHOR, time) {
      for (const [path, content] of Object.entries(files)) {
        const abs = join(dir, path);
        if (content === null) rmSync(abs, { force: true });
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content);
        }
      }
      run(["add", "-A"]);
      const t = String(time ?? (clock += 3600));
      run(["commit", "-q", "--allow-empty", "-m", message], {
        GIT_AUTHOR_NAME: author.name,
        GIT_AUTHOR_EMAIL: author.email,
        GIT_COMMITTER_NAME: author.name,
        GIT_COMMITTER_EMAIL: author.email,
        GIT_AUTHOR_DATE: `${t} +0000`,
        GIT_COMMITTER_DATE: `${t} +0000`,
      });
      return run(["rev-parse", "HEAD"]).trim();
    },
    git: (...args) => run(args).trim(),
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  };
}
