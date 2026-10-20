import { z } from "zod";

/** One entry an agent writes into its head commit's message after a pre-PR self-check (spec §2.3). */
export interface SelfCheckEntry {
  id: string;
  verdict: "fixed" | "explained";
  note?: string;
}

const MAX_NOTE_CHARS = 140;

const entrySchema = z
  .object({
    id: z.string().min(1),
    verdict: z.enum(["fixed", "explained"]),
    note: z.string().min(1).max(MAX_NOTE_CHARS).optional(),
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.verdict === "explained" && e.note === undefined) {
      ctx.addIssue({ code: "custom", message: 'a self-check entry with verdict "explained" needs a non-empty note' });
    }
  });

const recordSchema = z.array(entrySchema);

/**
 * Any substring shaped like a self-check marker: opening line, exactly one JSON line (JSON.stringify
 * never emits a literal newline inside a string, so the record is always exactly one line), closing
 * line. Used only to check there is exactly one before parsing it strictly (mirrors
 * `src/action/state.ts`'s STATE_ANY_RE/STATE_STRICT_RE split).
 */
const SELF_CHECK_ANY_RE = /<!-- opendrs-self-check:v1\n.*\n-->/g;
const SELF_CHECK_STRICT_RE = /^<!-- opendrs-self-check:v1\n(.*)\n-->$/;

/**
 * The self-check record from the exact commit message passed in — callers must pass only the head
 * commit's own message, never an ancestor's (spec §2.3: this is what makes it sha-pinned — a push
 * that does not carry the marker forward simply parses as "no record", not a stale one reused).
 * Anything but exactly one well-formed marker, with JSON that validates strictly, counts as no
 * record at all.
 */
export function parseSelfCheck(message: string | undefined): SelfCheckEntry[] | undefined {
  const candidates = message?.match(SELF_CHECK_ANY_RE) ?? [];
  if (candidates.length !== 1) return undefined;
  const m = SELF_CHECK_STRICT_RE.exec(candidates[0]!);
  if (!m) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(m[1]!);
  } catch {
    return undefined;
  }
  const result = recordSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

type Classification = "addressed" | "explained" | "contradicted" | "dropped";

/** Spec §2.3's four-way split, by comparing each entry's id against the freshly recomputed brief's ids. */
function classify(entry: SelfCheckEntry, freshIds: ReadonlySet<string>): Classification {
  const stillPresent = freshIds.has(entry.id);
  if (entry.verdict === "fixed") return stillPresent ? "contradicted" : "addressed";
  return stillPresent ? "explained" : "dropped"; // explained + absent: most likely stale ranking drift, not a lie worth surfacing
}

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * One advisory line for the PR comment (spec §2.4), or undefined when there is no record at all (so
 * the caller omits the line rather than showing a misleading "0 addressed"). `freshIds` is every id
 * `selfCheckItems` finds in a brief rebuilt from scratch, as if the record did not exist.
 */
export function renderSelfCheckLine(entries: SelfCheckEntry[] | undefined, freshIds: ReadonlySet<string>): string | undefined {
  if (entries === undefined) return undefined;
  const counts = { addressed: 0, explained: 0, contradicted: 0, dropped: 0 };
  for (const entry of entries) counts[classify(entry, freshIds)]++;

  const matched = counts.addressed + counts.explained + counts.contradicted;
  if (entries.length > 0 && matched === 0) {
    return "author agent self-checked: present but could not be matched to this diff · not part of the review decision";
  }

  const parts = [`${plural(counts.addressed, "fact")} addressed`, `${counts.explained} explained`];
  if (counts.contradicted > 0) parts.push(`${plural(counts.contradicted, "fact")} claimed fixed but still present`);
  return `author agent self-checked: ${parts.join(", ")} · not part of the review decision`;
}
