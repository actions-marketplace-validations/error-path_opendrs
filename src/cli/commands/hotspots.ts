import { parseArgs } from "node:util";
import { loadConfig } from "../../domain/config.js";
import { OpendrsError } from "../../domain/types.js";
import { hotspots, type Hotspot } from "../../hotspots.js";
import { repoRoot } from "../repo.js";
import type { Command } from "../types.js";

function render(rows: Hotspot[]): string {
  const header = ["rank", "score", "file", "fixes", "commits", "authors", "dependents", "flags"];
  const cells = rows.map((h) => [
    String(h.rank),
    h.score.toFixed(2),
    h.path,
    String(h.fixCommits),
    String(h.commits),
    String(h.authors),
    h.transitiveDependents === null ? "-" : String(h.transitiveDependents),
    [h.blocked && "blocked", h.critical && "critical"].filter(Boolean).join(",") || "-",
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => (i === 2 || i === 7 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join("  ").trimEnd();
  return [line(header), ...cells.map(line)].join("\n");
}

export const hotspotsCommand: Command = {
  name: "hotspots",
  summary: "Rank the repository's files by risk at rest",
  help: `Usage: opendrs hotspots [--top N] [--json]

Rank every file tracked at HEAD by code-at-rest risk: fix commits, commits and
authors in the history lookback window, transitive dependents in the import
graph, and whether it matches paths.critical or paths.block.

Options:
  --top N  Show the N riskiest files (default 20)
  --json   Print JSON`,

  async run(args, io) {
    const { values, positionals } = parseArgs({
      args,
      options: { top: { type: "string" }, json: { type: "boolean" } },
      allowPositionals: true,
    });
    if (positionals.length) throw new OpendrsError("hotspots takes no positional arguments", "usage");
    const top = values.top === undefined ? 20 : Number(values.top);
    if (!Number.isInteger(top) || top < 1) throw new OpendrsError("--top must be a positive integer", "usage");
    const repoDir = await repoRoot(io.cwd);
    const rows = await hotspots(repoDir, await loadConfig(repoDir), top);
    io.out(values.json ? JSON.stringify(rows, null, 2) : rows.length ? render(rows) : "no tracked files");
    return 0;
  },
};
