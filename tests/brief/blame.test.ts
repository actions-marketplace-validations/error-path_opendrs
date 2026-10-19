import { afterEach, describe, expect, it, vi } from "vitest";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

// The real git, wrapped so a test can count the calls blameFixes makes.
vi.mock("../../src/git/exec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/git/exec.js")>();
  return { ...actual, git: vi.fn(actual.git) };
});
const { git } = await import("../../src/git/exec.js");
const { blameFixes } = await import("../../src/brief/blame.js");
const { candidateHunks } = await import("../../src/brief/rank.js");
const { defaultConfig } = await import("../../src/domain/config.js");
const { makeContext } = await import("../../src/engine.js");
const { loadDiff } = await import("../../src/git/diff.js");
const { buildHistoryIndex } = await import("../../src/git/history.js");
const realGit = (await vi.importActual<typeof import("../../src/git/exec.js")>("../../src/git/exec.js")).git;

// A test that overrides git's implementation (e.g. to inject delays) must not leak it into the next test.
afterEach(() => vi.mocked(git).mockImplementation(realGit));

async function ctxFor(repo: TestRepo, asOf?: number) {
  const config = defaultConfig();
  const diff = await loadDiff(repo.dir, "HEAD~1", "HEAD", config);
  const history = await buildHistoryIndex(repo.dir, diff.base, config);
  return makeContext(repo.dir, diff, config, history, undefined, asOf);
}

describe("blameFixes", () => {
  it("attributes a hunk's old-side lines to a fix commit", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: NPE in a.ts");
    repo.commit({ "a.ts": "1\nchanged again\n3\n" }, "later change");
    const ctx = await ctxFor(repo);

    const { hits, notes } = await blameFixes(ctx, candidateHunks(ctx));
    const hit = [...hits.values()].flat();
    expect(hit).toHaveLength(1);
    expect(hit[0]!.subject).toBe("fix: NPE in a.ts");
    expect(notes).toEqual([]);
    repo.cleanup();
  });

  it("skips an added-only hunk without calling git blame on it", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "b.ts": "new file\n" }, "add b");
    const ctx = await ctxFor(repo);
    vi.mocked(git).mockClear();
    const { hits } = await blameFixes(ctx, candidateHunks(ctx));
    expect(hits.size).toBe(0);
    expect(git).not.toHaveBeenCalled();
    repo.cleanup();
  });

  it("does not blame a fix commit when only an unrelated line next to its change is inserted", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n4\n5\n6\n7\n8\n" }, "base");
    repo.commit({ "a.ts": "1\nFIXED\n3\n4\n5\n6\n7\n8\n" }, "fix: bug");
    // Inserts a line within the fix's 3-line context window without touching the fixed line itself.
    repo.commit({ "a.ts": "1\nFIXED\n3\n4\nNEW\n5\n6\n7\n8\n" }, "insert near the fix");
    const ctx = await ctxFor(repo);
    const { hits } = await blameFixes(ctx, candidateHunks(ctx));
    expect(hits.size).toBe(0);
    repo.cleanup();
  });

  it("uses the old path for a renamed file", async () => {
    const repo = makeRepo();
    // A big-enough file that git still detects the rename (-M50) once one line changes again.
    const lines = Array.from({ length: 10 }, (_, i) => `${i + 1}`);
    const withLine2 = (v: string) => [lines[0], v, ...lines.slice(2)].join("\n") + "\n";
    repo.commit({ "old.ts": withLine2(lines[1]!) }, "base");
    repo.commit({ "old.ts": withLine2("FIXED") }, "fix: bug");
    repo.git("mv", "old.ts", "new.ts");
    repo.commit({ "new.ts": withLine2("changed") }, "rename and tweak");
    const ctx = await ctxFor(repo);
    expect(ctx.diff.files[0]!.oldPath).toBe("old.ts");
    const { hits, notes } = await blameFixes(ctx, candidateHunks(ctx));
    expect(notes).toEqual([]);
    expect([...hits.values()].flat().some((h) => h.subject === "fix: bug")).toBe(true);
    repo.cleanup();
  });

  it("ignores a fix commit at or after asOf", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: NPE in a.ts", undefined, 1_800_000_000);
    repo.commit({ "a.ts": "1\nchanged again\n3\n" }, "later change", undefined, 1_800_000_100);
    const ctx = await ctxFor(repo, 1_800_000_000);
    const { hits } = await blameFixes(ctx, candidateHunks(ctx));
    expect(hits.size).toBe(0);
    repo.cleanup();
  });

  it("runs up to 4 blames concurrently instead of one at a time", async () => {
    const repo = makeRepo();
    const files: Record<string, string> = {};
    for (const n of ["a", "b", "c", "d", "e"]) files[`${n}.ts`] = "1\n2\n";
    repo.commit(files, "base");
    for (const n of ["a", "b", "c", "d", "e"]) repo.commit({ [`${n}.ts`]: "1\nFIXED\n" }, `fix: ${n}`);
    const touched: Record<string, string> = {};
    for (const n of ["a", "b", "c", "d", "e"]) touched[`${n}.ts`] = `${n.toUpperCase()}1\n${n.toUpperCase()}2\n`;
    repo.commit(touched, "touch all five");
    const ctx = await ctxFor(repo);

    let inFlight = 0;
    let maxInFlight = 0;
    vi.mocked(git).mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      throw new Error("boom");
    });

    const { notes } = await blameFixes(ctx, candidateHunks(ctx));
    expect(notes).toHaveLength(5);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    repo.cleanup();
  });

  it("keeps notes in candidate order even though blames run concurrently and finish out of order", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n", "b.ts": "1\n2\n", "c.ts": "1\n2\n" }, "base");
    repo.commit({ "a.ts": "1\nFIXED-A\n" }, "fix: a");
    repo.commit({ "b.ts": "1\nFIXED-B\n" }, "fix: b");
    repo.commit({ "c.ts": "1\nFIXED-C\n" }, "fix: c");
    repo.commit({ "a.ts": "A1\nA2\n", "b.ts": "B1\nB2\n", "c.ts": "C1\nC2\n" }, "touch all three");
    const ctx = await ctxFor(repo);

    // The slowest blame (a.ts) is requested first; the fastest (c.ts) finishes first. A pool that
    // records results in completion order, instead of candidate order, would reorder the notes.
    vi.mocked(git).mockImplementation(async (_repoDir, args) => {
      const path = (args as string[]).at(-1)!;
      const delay = path === "a.ts" ? 40 : path === "b.ts" ? 20 : 0;
      await new Promise((r) => setTimeout(r, delay));
      throw new Error(`boom ${path}`);
    });

    const { hits, notes } = await blameFixes(ctx, candidateHunks(ctx));
    expect(hits.size).toBe(0);
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain("boom a.ts");
    expect(notes[1]).toContain("boom b.ts");
    expect(notes[2]).toContain("boom c.ts");
    repo.cleanup();
  });

  it("records a note and keeps going when one hunk's blame fails", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n" }, "base");
    repo.commit({ "a.ts": "1\nX\n" }, "change");
    const ctx = await ctxFor(repo);
    // A hostile path: the note names it as inline code and git's error text (which echoes it) is cell-escaped, on one line.
    const nasty = "does/`not`\n<exist> @octocat.ts";
    const bogus = candidateHunks(ctx).map((c) => ({ ...c, file: { ...c.file, path: nasty, oldPath: nasty } }));
    const { hits, notes } = await blameFixes(ctx, bogus);
    expect(hits.size).toBe(0);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^blame unavailable for `does\/ˋnotˋ <exist> @octocat\.ts`: git blame failed: /);
    expect(notes[0]).not.toContain("\n");
    expect(notes[0]!.slice(notes[0]!.indexOf(": ") + 2)).toContain("does/\\`not\\` &lt;exist&gt; @​octocat.ts");
    repo.cleanup();
  });
});
