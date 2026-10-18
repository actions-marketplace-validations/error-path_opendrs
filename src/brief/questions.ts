import type { Incident, ScoringContext } from "../domain/types.js";
import { code } from "../report/escape.js";
import { quoteUntrusted } from "./quote.js";
import type { RankedFile } from "./rank.js";

export interface CheckItem {
  file: string;
  line?: number;
  question: string;
  /** Raw untrusted fragments the question quotes (clipped, not neutralised). */
  quotes: string[];
  evidence: string[];
}

const MAX_CHECKS = 6;
const MAX_PER_FILE = 2;
const MAX_DEPENDENTS_NAMED = 3;

function incidentFor(file: string, incidents: Incident[]): Incident | undefined {
  return incidents.find((inc) => inc.note && inc.paths?.some((p) => file === p || file.startsWith(p.endsWith("/") ? p : `${p}/`)));
}

/** Spec §5.5: fixed question templates from a file's ranked evidence, in priority order; at most 6, 2 per file. */
export function checkQuestions(ranked: RankedFile[], ctx: ScoringContext, incidents: Incident[]): CheckItem[] {
  const out: CheckItem[] = [];
  for (const f of ranked) {
    if (out.length >= MAX_CHECKS) break;
    let forFile = 0;
    const add = (item: CheckItem) => {
      if (out.length >= MAX_CHECKS || forFile >= MAX_PER_FILE) return;
      out.push(item);
      forFile++;
    };
    const reasons = [...f.reasons, ...f.hunks.flatMap((h) => h.reasons)];
    const path = code(f.file);

    const blameHunk = f.hunks.find((h) => h.reasons.some((r) => r.kind === "fix-blame"));
    const blame = blameHunk?.reasons.find((r) => r.kind === "fix-blame");
    if (blameHunk && blame) {
      add({
        file: f.file,
        line: blameHunk.newStart,
        question: `Fix ${code((blame.sha ?? "").slice(0, 7))} ${quoteUntrusted(blame.quote ?? "")} changed these lines. Does this change bring that problem back?`,
        quotes: blame.quote ? [blame.quote] : [],
        evidence: [blame.text],
      });
    }

    const incident = incidentFor(f.file, incidents);
    if (incident?.note) {
      add({ file: f.file, question: `An incident ${quoteUntrusted(incident.note)} involved ${path}. Could this change fail the same way?`, quotes: [incident.note], evidence: [] });
    }

    const exports = reasons.find((r) => r.kind === "exports");
    if (exports) {
      // The graph is read at base, where a renamed file still has its old path (matches rank.ts).
      const oldPath = ctx.diff.files.find((cf) => cf.path === f.file)?.oldPath ?? f.file;
      const dependents = ctx.graph?.dependentsOf(oldPath) ?? [];
      const named = dependents.slice(0, MAX_DEPENDENTS_NAMED).map(code);
      if (dependents.length > named.length) named.push("…");
      const callers = dependents.length > 0 ? `; ${dependents.length} file${dependents.length === 1 ? "" : "s"} import ${path} (${named.join(", ")})` : "";
      add({
        file: f.file,
        question: `${exports.text}${callers}. Are all callers compatible (arguments, return values, thrown errors)?`,
        quotes: [],
        evidence: dependents.slice(0, MAX_DEPENDENTS_NAMED),
      });
    }

    if (reasons.some((r) => r.kind === "no-tests")) {
      add({ file: f.file, question: `No test changed for ${path}. Which new branch is unverified?`, quotes: [], evidence: [] });
    }
    if (reasons.some((r) => r.kind === "critical")) {
      add({ file: f.file, question: `${path} is on a critical path. What happens on the failure path (authorisation denied, payment declined, timeout)?`, quotes: [], evidence: [] });
    }
  }
  return out;
}
