import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMetricsFile } from "../../scripts/metrics-path.mjs";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("resolveMetricsFile", () => {
  it("OPENDRS_METRICS_FILE env override wins and is resolved to an absolute path", () => {
    const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
    try {
      const result = resolveMetricsFile(cwd, { OPENDRS_METRICS_FILE: "custom/runs.jsonl" });
      expect(result).toBe(join(cwd, "custom/runs.jsonl"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("falls back to .dev-metrics/runs.jsonl when git is unavailable", () => {
    const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
    try {
      const result = resolveMetricsFile(cwd, {});
      expect(result).toBe(join(cwd, ".dev-metrics/runs.jsonl"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolves to <git-common-dir>/opendrs-dev-metrics/runs.jsonl in a plain repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
    try {
      git(cwd, ["init", "-q"]);
      const result = resolveMetricsFile(cwd, {});
      expect(result).toBe(join(cwd, ".git/opendrs-dev-metrics/runs.jsonl"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("resolves to the main repo's common dir from a linked worktree, not the worktree's own .git", () => {
    // Resolve the tmpdir's real path up front: macOS aliases /tmp through a symlink, and git
    // itself returns a canonicalized absolute path for a worktree's common dir, so comparing
    // against a non-canonical path here would be an artifact of this test's environment, not
    // a real mismatch.
    const mainDir = realpathSync(mkdtempSync(join(tmpdir(), "opendrs-metrics-")));
    const worktreesParent = realpathSync(mkdtempSync(join(tmpdir(), "opendrs-metrics-wt-")));
    try {
      git(mainDir, ["init", "-q"]);
      git(mainDir, ["commit", "--allow-empty", "-q", "-m", "init"]);
      const worktreeDir = join(worktreesParent, "wt1");
      git(mainDir, ["worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);

      const fromMain = resolveMetricsFile(mainDir, {});
      const fromWorktree = resolveMetricsFile(worktreeDir, {});

      expect(fromWorktree).toBe(fromMain);
      expect(fromWorktree).toBe(join(mainDir, ".git/opendrs-dev-metrics/runs.jsonl"));
    } finally {
      rmSync(worktreesParent, { recursive: true, force: true });
      rmSync(mainDir, { recursive: true, force: true });
    }
  });
});
