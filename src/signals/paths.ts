import type { ChangedFile, Evidence, Signal, SignalProvider } from "../domain/types.js";
import { globMatch } from "../graph/glob-lite.js";

/**
 * Files whose new or old path matches a glob. Ignored files are included on purpose:
 * `paths.ignore` must not be a way around a hard block.
 */
function matches(files: ChangedFile[], globs: string[], kind: string): Evidence[] {
  const out: Evidence[] = [];
  for (const f of files) {
    const hitNew = globs.find((g) => globMatch(g, f.path));
    if (hitNew) {
      out.push({ file: f.path, detail: `matches ${kind} glob "${hitNew}"` });
      continue;
    }
    const hitOld = f.oldPath ? globs.find((g) => globMatch(g, f.oldPath!)) : undefined;
    if (hitOld) out.push({ file: f.path, detail: `renamed from ${f.oldPath}, which matches ${kind} glob "${hitOld}"` });
  }
  return out;
}

function signal(id: string, evidence: Evidence[], label: string): Signal {
  return {
    id,
    value: evidence.length > 0 ? 1 : 0,
    status: "observed",
    summary: evidence.length > 0 ? `${evidence.length} changed file(s) in ${label} paths` : `No changed file in ${label} paths`,
    evidence,
  };
}

/** Spec §4 "paths.*" signals. */
export const pathsSignals: SignalProvider = async (ctx) => {
  const { files } = ctx.diff;
  const { critical, block } = ctx.config.paths;
  return [
    signal("paths.critical", matches(files, critical, "critical"), "critical"),
    signal("paths.blocked", matches(files, block, "block"), "blocked"),
  ];
};
