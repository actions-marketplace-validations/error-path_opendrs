#!/usr/bin/env node
// Prints the slowest run kinds/commands and a simple trend from the shared dev-metrics file.
// See docs/maintaining.md "Dev loop metrics". Usage: node scripts/metrics-report.mjs [--slow-threshold-min=10]
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveMetricsFile } from "./metrics-path.mjs";

const fmtS = (ms) => `${((ms ?? 0) / 1000).toFixed(1)}s`;

function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Kinds whose median duration is over `thresholdMs`: candidates for running in parallel.
// Sorted by median duration, slowest first.
export function computeSlowKinds(runs, thresholdMs) {
  const byKind = new Map();
  for (const r of runs) {
    const k = r.kind ?? "unknown";
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(r.durationMs ?? 0);
  }
  const slow = [];
  for (const [kind, durations] of byKind) {
    const p50Ms = median(durations);
    if (p50Ms > thresholdMs) slow.push({ kind, count: durations.length, p50Ms, maxMs: Math.max(...durations) });
  }
  return slow.sort((a, b) => b.p50Ms - a.p50Ms);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const thresholdArg = process.argv.slice(2).find((a) => a.startsWith("--slow-threshold-min="));
  const slowThresholdMin = thresholdArg ? Number(thresholdArg.slice("--slow-threshold-min=".length)) : 10;

  const path = resolveMetricsFile();
  if (!existsSync(path)) {
    console.log(`No runs recorded yet (${path} does not exist). Run \`npm test\` or \`npm run check\` first.`);
    process.exit(0);
  }

  const runs = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      runs.push(JSON.parse(line));
    } catch {
      // skip a malformed line rather than fail the whole report
    }
  }

  if (runs.length === 0) {
    console.log("No runs recorded yet.");
    process.exit(0);
  }

  const byKind = new Map();
  for (const r of runs) {
    const k = r.kind ?? "unknown";
    const agg = byKind.get(k) ?? { count: 0, totalMs: 0, fails: 0 };
    agg.count += 1;
    agg.totalMs += r.durationMs ?? 0;
    if (r.exitCode) agg.fails += 1;
    byKind.set(k, agg);
  }

  console.log(`${runs.length} runs recorded in ${path}\n`);

  console.log("By kind (slowest total first):");
  const rows = [...byKind.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [kind, agg] of rows) {
    console.log(`  ${kind.padEnd(12)} count=${String(agg.count).padEnd(4)} total=${fmtS(agg.totalMs).padEnd(9)} avg=${fmtS(agg.totalMs / agg.count).padEnd(9)} fails=${agg.fails}`);
  }

  console.log("\nTop 10 slowest individual runs:");
  const slowest = [...runs].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 10);
  for (const r of slowest) {
    console.log(`  ${fmtS(r.durationMs).padEnd(9)} [${(r.kind ?? "unknown").padEnd(10)}] ${(r.command ?? "").slice(0, 70)} (${r.source ?? "live"})`);
  }

  console.log(`\nParallelism candidates (median > ${slowThresholdMin}min):`);
  const slowKinds = computeSlowKinds(runs, slowThresholdMin * 60_000);
  if (slowKinds.length === 0) {
    console.log("  None.");
  } else {
    for (const { kind, count, p50Ms, maxMs } of slowKinds) {
      console.log(`  ${kind.padEnd(12)} count=${String(count).padEnd(4)} p50=${fmtS(p50Ms).padEnd(9)} max=${fmtS(maxMs)}`);
    }
  }

  console.log("\nTrend (older half mean -> newer half mean), kinds with >= 4 runs:");
  for (const [kind] of rows) {
    const kindRuns = runs.filter((r) => (r.kind ?? "unknown") === kind).sort((a, b) => new Date(a.ts) - new Date(b.ts));
    if (kindRuns.length < 4) continue;
    const mid = Math.floor(kindRuns.length / 2);
    const mean = (arr) => arr.reduce((sum, r) => sum + (r.durationMs ?? 0), 0) / arr.length;
    const olderMean = mean(kindRuns.slice(0, mid));
    const newerMean = mean(kindRuns.slice(mid));
    const trend = newerMean > olderMean * 1.1 ? "up" : newerMean < olderMean * 0.9 ? "down" : "flat";
    console.log(`  ${kind.padEnd(12)} ${fmtS(olderMean)} -> ${fmtS(newerMean)}  (${trend})`);
  }
}
