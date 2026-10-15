import { parseArgs } from "node:util";
import { loadConfig } from "../../domain/config.js";
import { OpendrsError } from "../../domain/types.js";
import { explainFile, type FileRiskExplanation } from "../../explain.js";
import { repoRoot, toRepoPath } from "../repo.js";
import type { Command } from "../types.js";

function render(e: FileRiskExplanation): string {
  const dependents =
    e.directDependents === null ? "unknown (language not supported by the import graph)" : `${e.directDependents} direct, ${e.transitiveDependents} transitive`;
  const flags = [e.blocked && "blocked path (never auto-approved)", e.critical && "critical path"].filter(Boolean);
  return [
    e.path,
    `  history     ${e.commits} commits, ${e.fixCommits} fixes or reverts, ${e.authors} authors`,
    `  dependents  ${dependents}`,
    `  policy      ${flags.length ? flags.join(", ") : "no blocked or critical match"}`,
    `  authors     ${e.topAuthors.length ? e.topAuthors.join(", ") : "none"}`,
  ].join("\n");
}

export const explainCommand: Command = {
  name: "explain",
  summary: "Show the standing risk profile of one file",
  help: `Usage: opendrs explain <file> [--json]

Show a file's history (commits, fixes, authors), its dependents in the import
graph, and whether it matches paths.block or paths.critical.

Options:
  --json   Print JSON`,

  async run(args, io) {
    const { values, positionals } = parseArgs({ args, options: { json: { type: "boolean" } }, allowPositionals: true });
    if (positionals.length !== 1) throw new OpendrsError("explain takes exactly one <file>", "usage");
    const repoDir = await repoRoot(io.cwd);
    const path = await toRepoPath(io.cwd, repoDir, positionals[0]!);
    const result = await explainFile(repoDir, path, await loadConfig(repoDir));
    io.out(values.json ? JSON.stringify(result, null, 2) : render(result));
    return 0;
  },
};
