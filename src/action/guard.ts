import { matchAny } from "../cli/glob-lite.js";

/**
 * Paths a PR may never change and still be auto-approved: the gate's own config, model and
 * incidents, CI workflows, and this action. Fixed in code so no config can turn it off.
 */
const GUARDED = [".opendrs.yml", ".opendrs/**", ".github/**", "action.yml", "action.yaml", "action/**"];

/** Changed files that trip the self-modification guard (case-insensitive). */
export function selfModifiedPaths(files: readonly string[], extra: readonly string[] = []): string[] {
  const patterns = [...GUARDED, ...extra].map((p) => p.toLowerCase());
  return files.filter((f) => matchAny(patterns, f.toLowerCase()));
}
