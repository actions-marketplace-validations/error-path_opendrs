import { createHash } from "node:crypto";
import { z } from "zod";
import { OpendrsError, type ArchitectureFact } from "../domain/types.js";

/** The dismissal memory (verification spec §3.4, §3.9): read from base like incidents, written by `feedback --fact`. */
export const FACTS_FILE = ".opendrs/facts.jsonl";

export type FactVerdict = "wrong" | "useful" | "intentional" | "ignored";

export interface FactMemoryEntry {
  hash: string;
  id: string;
  file: string;
  verdict: FactVerdict;
  note?: string;
  at: string;
}

/** Digit runs become "#" so "14 of 17 commits" and "15 of 18 commits" are the same fact. */
const normalize = (text: string) => text.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

/** First 16 hex of sha256 over detector id, file and the normalised text: the content key, not a sha. */
export function factHash(fact: Pick<ArchitectureFact, "id" | "file" | "text">): string {
  return createHash("sha256").update(`${fact.id}\0${fact.file}\0${normalize(fact.text)}`).digest("hex").slice(0, 16);
}

const entrySchema = z.object({
  hash: z.string(),
  id: z.string(),
  file: z.string(),
  verdict: z.enum(["wrong", "useful", "intentional", "ignored"]),
  note: z.string().optional(),
  at: z.string(),
});

/** The contents of `.opendrs/facts.jsonl`, one entry per line, from wherever the caller read it. */
export function parseFactMemory(text: string): FactMemoryEntry[] {
  const entries: FactMemoryEntry[] = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch (e) {
      throw new OpendrsError(`${FACTS_FILE} line ${i + 1}: ${(e as Error).message}`, "config");
    }
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) throw new OpendrsError(`${FACTS_FILE} line ${i + 1}: ${z.prettifyError(parsed.error)}`, "config");
    entries.push(parsed.data);
  });
  return entries;
}
