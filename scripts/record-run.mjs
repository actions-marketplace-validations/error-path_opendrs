#!/usr/bin/env node
// Dependency-free wrapper: runs a command, times it, and appends one JSON line to
// .dev-metrics/runs.jsonl (gitignored, append-only). See docs/maintaining.md "Dev loop metrics".
//
// Usage: node scripts/record-run.mjs <kind> -- <command> [args...]
import { spawnSync, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const dashIdx = args.indexOf("--");
if (dashIdx <= 0 || dashIdx === args.length - 1) {
  console.error("usage: record-run.mjs <kind> -- <command> [args...]");
  process.exit(2);
}

const kind = args[0];
const cmdParts = args.slice(dashIdx + 1);
const [cmd, ...cmdArgs] = cmdParts;

const gitSha = safe(() => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim());
const gitBranch = safe(() => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim());

const startedAt = Date.now();
const result = spawnSync(cmd, cmdArgs, { stdio: "inherit" });
const durationMs = Date.now() - startedAt;
const exitCode = result.status ?? (result.signal ? 1 : 0);

const entry = {
  ts: new Date(startedAt).toISOString(),
  kind,
  command: cmdParts.join(" "),
  gitSha,
  gitBranch,
  durationMs,
  exitCode,
  counts: null,
  costUsd: null,
  loadAvg1m: safe(() => os.loadavg()[0]),
  source: "live",
};

safe(() => {
  mkdirSync(".dev-metrics", { recursive: true });
  appendFileSync(".dev-metrics/runs.jsonl", JSON.stringify(entry) + "\n");
});

process.exit(exitCode);
