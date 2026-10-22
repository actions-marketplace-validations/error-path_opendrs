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

// The five `git config` child-process spawns this helper used to make per repo (user.name,
// user.email, commit.gpgsign, gc.auto, maintenance.auto) measurably add up: this fixture backs
// most of the test suite's wall time (see docs/research/2026-10-22-dev-loop-time-sinks.md).
// GIT_CONFIG_COUNT/KEY/VALUE (git >= 2.31) set the same config ambiently via env on every spawn
// instead, for identical behaviour with one spawn (`init`) instead of six.
const REPO_GIT_CONFIG_ENV: Record<string, string> = {
  GIT_CONFIG_COUNT: "5",
  GIT_CONFIG_KEY_0: "user.name",
  GIT_CONFIG_VALUE_0: DEFAULT_AUTHOR.name,
  GIT_CONFIG_KEY_1: "user.email",
  GIT_CONFIG_VALUE_1: DEFAULT_AUTHOR.email,
  GIT_CONFIG_KEY_2: "commit.gpgsign",
  GIT_CONFIG_VALUE_2: "false",
  // Big test commits can trigger a detached `git gc --auto`, which races cleanup (ENOTEMPTY in CI).
  GIT_CONFIG_KEY_3: "gc.auto",
  GIT_CONFIG_VALUE_3: "0",
  GIT_CONFIG_KEY_4: "maintenance.auto",
  GIT_CONFIG_VALUE_4: "false",
};

/** Create a real temporary git repository for tests. */
export function makeRepo(): TestRepo {
  const dir = mkdtempSync(join(tmpdir(), "opendrs-test-"));
  const run = (args: string[], env: Record<string, string> = {}) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", env: { ...process.env, ...REPO_GIT_CONFIG_ENV, ...env } });
  run(["init", "-q", "-b", "main"]);
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
