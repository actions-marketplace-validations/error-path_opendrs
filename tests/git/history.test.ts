import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import { buildHistoryIndex } from "../../src/git/history.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

const ALICE = { name: "Alice", email: "alice@example.com" };
const BOB = { name: "Bob", email: "Bob@Example.com" };
const CAROL = { name: "Carol", email: "carol@example.com" };
const T = 1_700_000_000;

describe("buildHistoryIndex", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("parses commits newest-first with parents, author, time, subject and files", async () => {
    repo = makeRepo();
    const c1 = repo.commit({ "a.ts": "1\n", "sp ace/ü.md": "x\n", "t\tab.txt": "t\n" }, "init", ALICE, T + 1000);
    const c2 = repo.commit({ "a.ts": "2\n" }, "Fix crash in parser", BOB, T + 2000);
    const h = await buildHistoryIndex(repo.dir, "HEAD", defaultConfig());
    expect(h.commits.map((c) => c.sha)).toEqual([c2, c1]);
    expect(h.commits[1]).toMatchObject({ parents: [], authorName: "Alice", authorEmail: "alice@example.com", time: T + 1000, subject: "init", isFix: false, isRevert: false });
    expect([...h.commits[1]!.files].sort()).toEqual(["a.ts", "sp ace/ü.md", "t\tab.txt"]);
    expect(h.commits[0]).toMatchObject({ parents: [c1], subject: "Fix crash in parser", isFix: true, files: ["a.ts"] });
  });

  it("detects reverts by subject and by body, and extracts the reverted sha", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    const bad = repo.commit({ "a.ts": "2\n" }, "feat: risky");
    repo.git("revert", "--no-edit", bad);
    repo.commit({ "b.ts": "1\n" }, `undo things\n\nThis reverts commit ${bad.slice(0, 10)}.`);
    const h = await buildHistoryIndex(repo.dir, "HEAD", defaultConfig());
    const [manual, gitRevert] = h.commits;
    expect(gitRevert).toMatchObject({ isRevert: true, revertsSha: bad });
    expect(gitRevert!.subject).toBe('Revert "feat: risky"');
    expect(manual).toMatchObject({ isRevert: true, revertsSha: bad.slice(0, 10), isFix: false });
  });

  it("uses history.fixPattern case-insensitively", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "HOTFIX: urgent");
    repo.commit({ "a.ts": "2\n" }, "prefix things");
    const h = await buildHistoryIndex(repo.dir, "HEAD", parseConfig({ history: { fixPattern: "\\bhotfix\\b" } }));
    expect(h.commits.map((c) => c.isFix)).toEqual([false, true]);
  });

  it("answers file and author queries point-in-time", async () => {
    repo = makeRepo();
    const c1 = repo.commit({ "src/a.ts": "1\n" }, "add a", ALICE, T + 1000);
    const c2 = repo.commit({ "src/a.ts": "2\n" }, "edit a", BOB, T + 2000);
    const c3 = repo.commit({ "src/a.ts": "3\n", "src/b.ts": "b\n" }, "edit a, add b", BOB, T + 3000);
    const h = await buildHistoryIndex(repo.dir, "HEAD", defaultConfig());

    expect(h.fileCommits("src/a.ts").map((c) => c.sha)).toEqual([c3, c2, c1]);
    expect(h.fileCommits("src/a.ts", T + 3000).map((c) => c.sha)).toEqual([c2, c1]);
    expect(h.fileCommits("src/a.ts", T + 1000)).toEqual([]);
    expect(h.fileCommits("missing.ts")).toEqual([]);

    expect(h.fileCreator("src/a.ts")).toBe("alice@example.com");
    expect(h.fileCreator("src/b.ts")).toBe("bob@example.com");
    expect(h.fileCreator("src/b.ts", T + 3000)).toBeUndefined();

    expect(h.authorCommitCount("bob@example.com")).toBe(2);
    expect(h.authorCommitCount("BOB@example.com", T + 2500)).toBe(1);
    expect(h.authorCommitCount("alice@example.com", T + 1000)).toBe(0);
    expect(h.authorCommitCount("nobody@example.com")).toBe(0);
  });

  it("attributes history across renames", async () => {
    repo = makeRepo();
    const body = "export function f() {\n  return 1;\n}\n// padding line\n// padding line\n";
    const c1 = repo.commit({ "old/a.ts": body }, "add", ALICE, T + 1000);
    const c2 = repo.commit({ "old/a.ts": body + "// more\n" }, "edit", BOB, T + 2000);
    const c3 = repo.commit({ "old/a.ts": null, "new/a.ts": body + "// more\n" }, "move", CAROL, T + 3000);
    const h = await buildHistoryIndex(repo.dir, "HEAD", defaultConfig());
    expect(h.commits[0]!.files).toEqual(["new/a.ts"]);
    expect(h.fileCommits("new/a.ts").map((c) => c.sha)).toEqual([c3, c2, c1]);
    expect(h.fileCreator("new/a.ts")).toBe("alice@example.com");
  });

  it("keeps merge commits with both parents and no files", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init", ALICE, T + 1000);
    repo.git("checkout", "-q", "-b", "side");
    const side = repo.commit({ "b.ts": "1\n" }, "side work", BOB, T + 2000);
    repo.git("checkout", "-q", "main");
    const main = repo.commit({ "c.ts": "1\n" }, "main work", ALICE, T + 3000);
    repo.git("merge", "-q", "--no-ff", "-m", "Merge side", "side");
    const h = await buildHistoryIndex(repo.dir, "HEAD", defaultConfig());
    const merge = h.commits[0]!;
    expect(merge.subject).toBe("Merge side");
    expect(merge.parents).toEqual([main, side]);
    expect(merge.files).toEqual([]);
    expect(h.commits).toHaveLength(4);
    // Merges are not landed diffs.
    expect(h.authorCommitCount("alice@example.com")).toBe(2);
  });

  it("is bounded by history.maxCommits", async () => {
    repo = makeRepo();
    for (let i = 0; i < 5; i++) repo.commit({ "a.ts": `${i}\n` }, `c${i}`);
    const h = await buildHistoryIndex(repo.dir, "HEAD", parseConfig({ history: { maxCommits: 3 } }));
    expect(h.commits.map((c) => c.subject)).toEqual(["c4", "c3", "c2"]);
  });

  it("indexes a 20k-commit repository in a few seconds", async () => {
    repo = makeRepo();
    const N = 20_000;
    const parts: string[] = [];
    for (let i = 1; i <= N; i++) {
      const content = `v${i}\n`;
      parts.push(
        "commit refs/heads/main",
        `committer Dev${i % 50} <dev${i % 50}@example.com> ${1_600_000_000 + i} +0000`,
        `data ${`c${i}`.length}`,
        `c${i}`,
        `M 644 inline src/m${i % 300}/f${i % 7}.ts`,
        `data ${Buffer.byteLength(content)}`,
        content,
      );
    }
    execFileSync("git", ["fast-import", "--quiet"], { cwd: repo.dir, input: parts.join("\n") + "\n" });

    const start = performance.now();
    const h = await buildHistoryIndex(repo.dir, "main", defaultConfig());
    let total = 0;
    for (let i = 0; i < 300; i++) total += h.fileCommits(`src/m${i}/f${i % 7}.ts`, 1_600_010_000).length;
    const ms = performance.now() - start;

    expect(h.commits).toHaveLength(N);
    expect(total).toBeGreaterThan(0);
    expect(ms).toBeLessThan(8000);
  }, 60_000);
});
