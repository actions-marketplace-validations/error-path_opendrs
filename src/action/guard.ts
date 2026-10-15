import { matchAny } from "../git/glob.js";

/**
 * Paths a PR may never change and still be auto-approved: the gate's own config, model and
 * incidents, CI workflows, this action, where submodules point, and the attributes that tell git
 * what is binary. Fixed in code so no config can turn it off.
 */
const GUARDED = [
  ".opendrs.yml",
  ".opendrs/**",
  ".github/**",
  "action.yml",
  "action.yaml",
  "action/**",
  ".gitmodules",
  "**/.gitattributes",
];

/** Changed files that trip the self-modification guard (case-insensitive). */
export function selfModifiedPaths(files: readonly string[], extra: readonly string[] = []): string[] {
  const patterns = [...GUARDED, ...extra];
  return files.filter((f) => matchAny(patterns, f, { ignoreCase: true }));
}
