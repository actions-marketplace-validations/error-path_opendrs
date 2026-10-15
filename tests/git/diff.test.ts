import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { EMPTY_TREE, loadDiff, parseUnifiedDiff } from "../../src/git/diff.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

const lines = (...l: string[]) => l.join("\n") + "\n";

describe("parseUnifiedDiff", () => {
  it("returns [] for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });

  it("parses a modification with multiple hunks", () => {
    const files = parseUnifiedDiff(
      lines(
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,3 +1,3 @@ function f() {",
        " one",
        "-two",
        "+TWO",
        " three",
        "@@ -10 +10,2 @@",
        " ten",
        "+eleven",
      ),
    );
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f).toMatchObject({ path: "src/a.ts", status: "modified", added: 2, deleted: 1, binary: false, ignored: false });
    expect(f.oldPath).toBeUndefined();
    expect(f.hunks).toEqual([
      { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [" one", "-two", "+TWO", " three"] },
      { oldStart: 10, oldLines: 1, newStart: 10, newLines: 2, lines: [" ten", "+eleven"] },
    ]);
  });

  it("does not mistake hunk content that looks like a header for a new file", () => {
    const files = parseUnifiedDiff(
      lines(
        "diff --git a/x.patch b/x.patch",
        "--- a/x.patch",
        "+++ b/x.patch",
        "@@ -1,2 +1,2 @@",
        "--- a/old",
        "+diff --git a/y b/y",
        " ",
      ),
    );
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: "x.patch", added: 1, deleted: 1 });
  });

  it("parses renames with edits and keeps the old path", () => {
    const [f] = parseUnifiedDiff(
      lines(
        "diff --git a/d/old.txt b/d/new.txt",
        "similarity index 85%",
        "rename from d/old.txt",
        "rename to d/new.txt",
        "index b2f931a..b566061 100644",
        "--- a/d/old.txt",
        "+++ b/d/new.txt",
        "@@ -3,3 +3,4 @@ two",
        " three",
        " four",
        " five",
        "+six",
      ),
    );
    expect(f).toMatchObject({ path: "d/new.txt", oldPath: "d/old.txt", status: "renamed", added: 1, deleted: 0 });
  });

  it("parses a pure rename (no hunks) with spaces in paths", () => {
    const [f] = parseUnifiedDiff(
      lines("diff --git a/my dir/a b.txt b/other dir/a b.txt", "similarity index 100%", "rename from my dir/a b.txt", "rename to other dir/a b.txt"),
    );
    expect(f).toMatchObject({ path: "other dir/a b.txt", oldPath: "my dir/a b.txt", status: "renamed", added: 0, deleted: 0, hunks: [] });
  });

  it("parses new and deleted files, including quoted paths", () => {
    const files = parseUnifiedDiff(
      lines(
        'diff --git "a/n\\tew.txt" "b/n\\tew.txt"',
        "new file mode 100644",
        "index 0000000..8ba3a16",
        "--- /dev/null",
        '+++ "b/n\\tew.txt"',
        "@@ -0,0 +1 @@",
        "+n",
        'diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"',
        "deleted file mode 100644",
        "index c1b0730..0000000",
        '--- "a/q\\"uote.txt"',
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-x",
        "\\ No newline at end of file",
      ),
    );
    expect(files.map((f) => [f.path, f.status, f.added, f.deleted])).toEqual([
      ["n\tew.txt", "added", 1, 0],
      ['q"uote.txt', "deleted", 0, 1],
    ]);
    expect(files[1]!.hunks[0]!.lines).toEqual(["-x", "\\ No newline at end of file"]);
  });

  it("decodes octal escapes in quoted paths as UTF-8", () => {
    const [f] = parseUnifiedDiff(
      lines('diff --git "a/\\303\\274.txt" "b/\\303\\274.txt"', "new file mode 100644", "--- /dev/null", '+++ "b/\\303\\274.txt"', "@@ -0,0 +1 @@", "+u"),
    );
    expect(f!.path).toBe("ü.txt");
  });

  it("strips the trailing tab git adds to ---/+++ paths with spaces", () => {
    const [f] = parseUnifiedDiff(
      lines(
        "diff --git a/sp ace.txt b/sp ace.txt",
        "index de98044..36ef1ba 100644",
        "--- a/sp ace.txt\t",
        "+++ b/sp ace.txt\t",
        "@@ -1,3 +1,3 @@",
        " a",
        "-b",
        "-c",
        "+B",
        "+c",
        "\\ No newline at end of file",
      ),
    );
    expect(f).toMatchObject({ path: "sp ace.txt", status: "modified", added: 2, deleted: 2 });
  });

  it("parses binary files and mode-only changes", () => {
    const files = parseUnifiedDiff(
      lines(
        "diff --git a/bin.dat b/bin.dat",
        "index bdc955b..8835708 100644",
        "Binary files a/bin.dat and b/bin.dat differ",
        "diff --git a/img.png b/img.png",
        "new file mode 100644",
        "index 0000000..8835708",
        "Binary files /dev/null and b/img.png differ",
        "diff --git a/ünï.txt b/ünï.txt",
        "old mode 100644",
        "new mode 100755",
      ),
    );
    expect(files.map((f) => [f.path, f.status, f.binary, f.added, f.deleted])).toEqual([
      ["bin.dat", "modified", true, 0, 0],
      ["img.png", "added", true, 0, 0],
      ["ünï.txt", "modified", false, 0, 0],
    ]);
  });
});

describe("loadDiff", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("diffs from the merge-base, resolves shas, reads author/title and applies ignore globs", async () => {
    repo = makeRepo();
    const root = repo.commit({ "src/a.ts": "a\n", "README.md": "r\n" }, "init");
    repo.git("checkout", "-q", "-b", "feature");
    repo.commit({ "src/a.ts": "a\nb\n", "package-lock.json": "{}\n", "sp ace/ü.ts": "x\n" }, "feat: add b", { name: "Bob", email: "bob@example.com" });
    repo.git("checkout", "-q", "main");
    const mainTip = repo.commit({ "README.md": "changed on main\n" }, "docs: main moves on");

    const diff = await loadDiff(repo.dir, "main", "feature", defaultConfig());
    expect(diff.base).toBe(root);
    expect(diff.base).not.toBe(mainTip);
    expect(diff.head).toBe(repo.git("rev-parse", "feature"));
    expect(diff.author).toEqual({ name: "Bob", email: "bob@example.com" });
    expect(diff.title).toBe("feat: add b");
    const byPath = Object.fromEntries(diff.files.map((f) => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(["package-lock.json", "sp ace/ü.ts", "src/a.ts"]);
    expect(byPath["package-lock.json"]!.ignored).toBe(true);
    expect(byPath["src/a.ts"]).toMatchObject({ ignored: false, added: 1, deleted: 0 });
    expect(byPath["sp ace/ü.ts"]!.status).toBe("added");
  });

  it("returns no files for an empty diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    const diff = await loadDiff(repo.dir, "HEAD", "HEAD", defaultConfig());
    expect(diff.files).toEqual([]);
  });

  it("detects a rename-only diff", async () => {
    repo = makeRepo();
    repo.commit({ "old/name.ts": "export const x = 1;\nexport const y = 2;\n" }, "init");
    repo.commit({ "old/name.ts": null, "new/name.ts": "export const x = 1;\nexport const y = 2;\n" }, "move");
    const diff = await loadDiff(repo.dir, "HEAD~1", "HEAD", defaultConfig());
    expect(diff.files).toEqual([
      { path: "new/name.ts", oldPath: "old/name.ts", status: "renamed", added: 0, deleted: 0, binary: false, hunks: [], ignored: false },
    ]);
  });

  it("detects a binary-only diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.bin": "\u0000\u0001" }, "init");
    repo.commit({ "a.bin": "\u0000\u0002" }, "change");
    const diff = await loadDiff(repo.dir, "HEAD~1", "HEAD", defaultConfig());
    expect(diff.files).toMatchObject([{ path: "a.bin", binary: true, added: 0, deleted: 0 }]);
  });

  it("scores a root commit against the empty tree", async () => {
    repo = makeRepo();
    const first = repo.commit({ "a.txt": "a\nb\n" }, "init");
    const diff = await loadDiff(repo.dir, EMPTY_TREE, first, defaultConfig());
    expect(diff.base).toBe(EMPTY_TREE);
    expect(diff.files).toMatchObject([{ path: "a.txt", status: "added", added: 2 }]);
  });

  it("rejects unknown refs and option-like refs", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    await expect(loadDiff(repo.dir, "nope", "HEAD", defaultConfig())).rejects.toThrow(/nope/);
    await expect(loadDiff(repo.dir, "--output=/tmp/x", "HEAD", defaultConfig())).rejects.toThrow();
  });
});
