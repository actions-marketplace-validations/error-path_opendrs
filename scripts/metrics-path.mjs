// Shared metrics-file location for record-run.mjs, record-eval-run.mjs and metrics-report.mjs.
// See docs/maintaining.md "Dev loop metrics".
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

// Resolution order: env OPENDRS_METRICS_FILE, else <git-common-dir>/opendrs-dev-metrics/runs.jsonl
// (shared by every worktree of the clone, survives worktree pruning, never committed), else the
// old .dev-metrics/runs.jsonl when git isn't available.
export function resolveMetricsFile(cwd = process.cwd(), env = process.env) {
  if (env.OPENDRS_METRICS_FILE) return resolve(cwd, env.OPENDRS_METRICS_FILE);
  try {
    const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
    return resolve(cwd, commonDir, "opendrs-dev-metrics", "runs.jsonl");
  } catch {
    return resolve(cwd, ".dev-metrics/runs.jsonl");
  }
}
