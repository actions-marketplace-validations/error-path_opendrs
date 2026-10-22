#!/usr/bin/env node
// Appends one .dev-metrics/runs.jsonl entry for a finished `claude plugin eval` run, read from
// its evals/results/<timestamp>/aggregate-result.json. See docs/maintaining.md "Dev loop metrics".
//
// Usage: node scripts/record-eval-run.mjs <path/to/aggregate-result.json>
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

const path = process.argv[2];
if (!path) {
  console.error("usage: record-eval-run.mjs <path/to/aggregate-result.json>");
  process.exit(2);
}

const agg = JSON.parse(readFileSync(path, "utf8"));
const cases = Array.isArray(agg.cases) ? agg.cases : [];
const passRates = cases.map((c) => c?.aggregates?.passRate).filter((n) => typeof n === "number");
const meanPassRate = passRates.length ? passRates.reduce((a, b) => a + b, 0) / passRates.length : null;

const entry = {
  ts: agg.startedAt ?? new Date().toISOString(),
  kind: "eval",
  command: `claude plugin eval (${cases.length} case${cases.length === 1 ? "" : "s"}: ${cases.map((c) => c.name).join(", ")})`,
  gitSha: safe(() => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()),
  gitBranch: safe(() => execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()),
  durationMs: typeof agg.durationSeconds === "number" ? Math.round(agg.durationSeconds * 1000) : null,
  exitCode: agg.partial ? 1 : 0,
  counts: { cases: cases.length, passRate: meanPassRate },
  costUsd: agg.costUsd ?? null,
  loadAvg1m: null,
  source: "live",
};

safe(() => {
  mkdirSync(".dev-metrics", { recursive: true });
  appendFileSync(".dev-metrics/runs.jsonl", JSON.stringify(entry) + "\n");
});

console.log(`recorded eval run: ${entry.durationMs}ms, cost $${entry.costUsd ?? 0}, cases=${entry.counts.cases}, meanPassRate=${meanPassRate}`);
