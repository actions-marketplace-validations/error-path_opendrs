import type { ChangedFile, Evidence, ScoringContext, Signal, SignalProvider } from "../domain/types.js";
import { countedFiles, historyPath, plural, topEvidence, unknown } from "./util.js";

/** Spec §4 "size.*" signals. */
export const sizeSignals: SignalProvider = async (ctx) => {
  const files = countedFiles(ctx);
  const added = files.filter((f) => f.status === "added").length;
  const lines = files.reduce((n, f) => n + f.added + f.deleted, 0);
  const ignored = ctx.diff.files.length - files.length;

  const churn: Signal = {
    id: "size.churn",
    value: Math.log1p(lines),
    status: "observed",
    summary: `${plural(lines, "line")} changed across ${plural(files.length, "file")} (${added} new)` + (ignored ? `; ${ignored} ignored` : ""),
    evidence: topEvidence(
      [...files].sort((a, b) => b.added + b.deleted - (a.added + a.deleted)).map((f) => ({ file: f.path, detail: `+${f.added} -${f.deleted}` })),
    ),
  };

  const newOnly = files.length > 0 && added === files.length;
  const newFilesOnly: Signal = {
    id: "size.new_files_only",
    value: newOnly ? 1 : 0,
    status: "observed",
    summary: newOnly ? `all ${plural(files.length, "changed file")} are new` : `${added} of ${plural(files.length, "changed file")} are new`,
    evidence: [],
  };

  return [churn, await relativeSize(ctx, files), newFilesOnly];
};

async function relativeSize(ctx: ScoringContext, files: ChangedFile[]): Promise<Signal> {
  const id = "size.relative";
  const modified = files.filter((f) => !f.binary && (f.status === "modified" || f.status === "renamed"));
  if (modified.length === 0) {
    return { id, value: 0, status: "derived", summary: "no pre-existing text files modified", evidence: [] };
  }
  const bases = await Promise.all(modified.map((f) => ctx.readBase(historyPath(f))));
  let changed = 0;
  let baseLines = 0;
  const evidence: Evidence[] = [];
  for (const [i, f] of modified.entries()) {
    const text = bases[i];
    if (text === undefined) continue;
    const length = lineCount(text);
    changed += f.added + f.deleted;
    baseLines += length;
    evidence.push({ file: f.path, detail: `${f.added + f.deleted} of ${length} lines changed` });
  }
  if (evidence.length === 0) return unknown(id, `could not read base contents of ${plural(modified.length, "modified file")}`);
  if (baseLines === 0) return unknown(id, "modified files were empty at base");
  const ratio = changed / baseLines;
  return {
    id,
    value: Math.log1p(ratio),
    status: "derived",
    summary: `${changed} changed lines vs ${baseLines} base lines in ${plural(evidence.length, "modified file")} (${(ratio * 100).toFixed(1)}%)`,
    evidence: topEvidence(evidence),
  };
}

function lineCount(text: string): number {
  if (text === "") return 0;
  let n = 0;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n : n + 1;
}
