import { describe, expect, it } from "vitest";
import { FACTS_FILE, factHash, parseFactMemory } from "../../src/brief/facts-memory.js";
import { OpendrsError } from "../../src/domain/types.js";

const fact = (text: string, over: { id?: "coupling.missing" | "contract.api"; file?: string } = {}) => ({ id: over.id ?? ("coupling.missing" as const), file: over.file ?? "src/a.ts", text });

describe("factHash", () => {
  it("is 16 hex characters of sha256 over id, file and the normalised text", () => {
    expect(factHash(fact("`src/b.ts` changed with `src/a.ts` in 14 of 17 commits"))).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores digit runs and whitespace, so a moved count still matches", () => {
    const a = factHash(fact("`src/b.ts` changed with `src/a.ts` in 14 of 17 commits (last 30 days)"));
    expect(factHash(fact("`src/b.ts` changed with `src/a.ts` in 15 of 18 commits (last 31 days)"))).toBe(a);
    expect(factHash(fact("`src/b.ts`  changed with\n`src/a.ts` in 14 of 17 commits (last 30 days) "))).toBe(a);
  });

  it("differs by detector id, file and wording", () => {
    const a = factHash(fact("text"));
    expect(factHash(fact("text", { id: "contract.api" }))).not.toBe(a);
    expect(factHash(fact("text", { file: "src/b.ts" }))).not.toBe(a);
    expect(factHash(fact("other text"))).not.toBe(a);
  });
});

describe("parseFactMemory", () => {
  const entry = { hash: "0123456789abcdef", id: "coupling.missing", file: "src/a.ts", verdict: "wrong", note: "config only", at: "2026-10-22T10:00:00Z" };

  it("parses one entry per line, skipping blank lines", () => {
    const text = `${JSON.stringify(entry)}\n\n${JSON.stringify({ ...entry, verdict: "useful", note: undefined })}\n`;
    expect(parseFactMemory(text)).toEqual([entry, { hash: entry.hash, id: entry.id, file: entry.file, verdict: "useful", at: entry.at }]);
    expect(parseFactMemory("")).toEqual([]);
  });

  it("names the file and line of a bad entry as a config error", () => {
    for (const [bad, pattern] of [
      [`${JSON.stringify(entry)}\n{not json`, /line 2/],
      [JSON.stringify({ ...entry, verdict: "meh" }), /line 1.*verdict/s],
      [JSON.stringify({ ...entry, hash: undefined }), /line 1.*hash/s],
    ] as const) {
      const err = (() => {
        try {
          parseFactMemory(bad);
        } catch (e) {
          return e;
        }
        return undefined;
      })();
      expect(err).toBeInstanceOf(OpendrsError);
      expect((err as OpendrsError).code).toBe("config");
      expect((err as Error).message).toContain(FACTS_FILE);
      expect((err as Error).message).toMatch(pattern);
    }
  });
});
