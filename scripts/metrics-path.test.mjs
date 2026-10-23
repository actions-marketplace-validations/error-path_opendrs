import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveMetricsFile } from "./metrics-path.mjs";

function git(cwd, args) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("OPENDRS_METRICS_FILE env override wins and is resolved to an absolute path", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
  try {
    const result = resolveMetricsFile(cwd, { OPENDRS_METRICS_FILE: "custom/runs.jsonl" });
    assert.equal(result, join(cwd, "custom/runs.jsonl"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("falls back to .dev-metrics/runs.jsonl when git is unavailable", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
  try {
    const result = resolveMetricsFile(cwd, {});
    assert.equal(result, join(cwd, ".dev-metrics/runs.jsonl"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolves to <git-common-dir>/opendrs-dev-metrics/runs.jsonl in a plain repo", () => {
  const cwd = mkdtempSync(join(tmpdir(), "opendrs-metrics-"));
  try {
    git(cwd, ["init", "-q"]);
    const result = resolveMetricsFile(cwd, {});
    assert.equal(result, join(cwd, ".git/opendrs-dev-metrics/runs.jsonl"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolves to the main repo's common dir from a linked worktree, not the worktree's own .git", () => {
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

    assert.equal(fromWorktree, fromMain);
    assert.equal(fromWorktree, join(mainDir, ".git/opendrs-dev-metrics/runs.jsonl"));
  } finally {
    rmSync(worktreesParent, { recursive: true, force: true });
    rmSync(mainDir, { recursive: true, force: true });
  }
});
