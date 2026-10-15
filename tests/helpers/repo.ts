import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

/** Create a real temporary git repository for tests. */
export function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "opendrs-test-"));
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.name", DEFAULT_AUTHOR.name]);
  run(["config", "user.email", DEFAULT_AUTHOR.email]);
  run(["config", "commit.gpgsign", "false"]);
  // Big test commits can trigger a detached `git gc --auto`, which races cleanup (ENOTEMPTY in CI).
  run(["config", "gc.auto", "0"]);
  run(["config", "maintenance.auto", "false"]);
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
