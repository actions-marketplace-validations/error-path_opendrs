import { describe, expect, it, vi } from "vitest";
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

  it("uses the old path for a renamed file", async () => {
    const repo = makeRepo();
    repo.commit({ "old.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "old.ts": "1\nFIXED\n3\n" }, "fix: bug");
    repo.git("mv", "old.ts", "new.ts");
    repo.commit({ "new.ts": "1\nFIXED\nchanged\n" }, "rename and tweak");
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
