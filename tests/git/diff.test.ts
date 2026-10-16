import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { changedLines, EMPTY_TREE, gitHasAttrSource, loadDiff, parseUnifiedDiff } from "../../src/git/diff.js";
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

  it("marks gitlink (submodule) changes, whether moved, added or deleted", () => {
    const files = parseUnifiedDiff(
      lines(
        "diff --git a/libs/core b/libs/core",
        "index 1111111..2222222 160000",
        "--- a/libs/core",
        "+++ b/libs/core",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111111111111111111111111111111111111",
        "+Subproject commit 2222222222222222222222222222222222222222",
        "diff --git a/libs/new b/libs/new",
        "new file mode 160000",
        "index 0000000..1111111",
        "--- /dev/null",
        "+++ b/libs/new",
        "@@ -0,0 +1 @@",
        "+Subproject commit 1111111111111111111111111111111111111111",
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1111111..2222222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-a",
        "+b",
      ),
    );
    expect(files.map((f) => [f.path, f.submodule])).toEqual([
      ["libs/core", true],
      ["libs/new", true],
      ["src/a.ts", undefined],
    ]);
  });

  it("marks a deleted gitlink from its file mode", () => {
    const [f] = parseUnifiedDiff(
      lines(
        "diff --git a/libs/core b/libs/core",
        "deleted file mode 160000",
        "index 1111111..0000000",
        "--- a/libs/core",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-Subproject commit 1111111111111111111111111111111111111111",
      ),
    );
    expect(f).toMatchObject({ path: "libs/core", status: "deleted", submodule: true });
  });

  it("marks a gitlink from its Subproject commit lines when no mode line says so", () => {
    const [f] = parseUnifiedDiff(
      lines(
        "diff --git a/libs/core b/libs/core",
        "index 1111111..2222222",
        "--- a/libs/core",
        "+++ b/libs/core",
        "@@ -1 +1 @@",
        "-Subproject commit 1111111111111111111111111111111111111111",
        "+Subproject commit 2222222222222222222222222222222222222222",
      ),
    );
    expect(f).toMatchObject({ path: "libs/core", submodule: true });
  });
});

describe("changedLines", () => {
  it("numbers added and removed rows the way the parser counts them", () => {
    // diff.suppressBlankEmpty prints a blank context line as "", and "\ No newline" rows take no line.
    const [f] = parseUnifiedDiff(
      lines("diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -10,3 +20,4 @@", " a", "", "-b", "\\ No newline at end of file", "+b", "+c"),
    );
    expect([...changedLines(f!.hunks[0]!)]).toEqual([
      { kind: "-", line: 12, text: "b" },
      { kind: "+", line: 22, text: "b" },
      { kind: "+", line: 23, text: "c" },
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

  it("marks a submodule pointer move, even when config or .gitmodules would hide or summarise it", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n", ".gitmodules": '[submodule "core"]\n\tpath = libs/core\n\turl = https://example.com/core\n\tignore = all\n' }, "init");
    repo.git("update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},libs/core`);
    repo.git("commit", "-q", "-m", "add submodule");
    repo.git("update-index", "--cacheinfo", `160000,${"2".repeat(40)},libs/core`);
    repo.git("commit", "-q", "-m", "bump submodule");
    repo.git("config", "diff.submodule", "log");
    repo.git("config", "diff.ignoreSubmodules", "all");
    const diff = await loadDiff(repo.dir, "HEAD~1", "HEAD", defaultConfig());
    expect(diff.files).toMatchObject([{ path: "libs/core", submodule: true, added: 1, deleted: 1 }]);
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

describe("gitHasAttrSource", () => {
  it.each([
    ["git version 2.40.0", true],
    ["git version 2.43.0.windows.1", true],
    ["git version 3.0.0", true],
    ["git version 2.39.5 (Apple Git-154)", false],
    ["git version 1.99.0", false],
    ["not git", false],
  ])("%s -> %s", (version, want) => {
    expect(gitHasAttrSource(version)).toBe(want);
  });
});

describe("loadDiff: binary detection the PR cannot steer", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  // An ELF header: a NUL in the first bytes, so git's own heuristic calls it binary.
  const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00, 0x0a, 0x41, 0x0a]);
  const write = (path: string, content: Buffer | string) => {
    mkdirSync(dirname(join(repo.dir, path)), { recursive: true });
    writeFileSync(join(repo.dir, path), content);
  };
  const byPath = async () => Object.fromEntries((await loadDiff(repo.dir, "HEAD~1", "HEAD", defaultConfig())).files.map((f) => [f.path, f]));
  const installedGit = execFileSync("git", ["version"], { encoding: "utf8" });

  it("calls a blob binary although the PR's .gitattributes marks it as text", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    write(".gitattributes", "tools/* diff\n");
    write("tools/helper", ELF);
    repo.commit({}, "add helper");
    expect((await byPath())["tools/helper"]!.binary).toBe(true);
  });

  it("calls a blob binary when its first NUL comes after git's 8000-byte window", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    write("lib/tool.jar", Buffer.concat([Buffer.from("x".repeat(8200)), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])]));
    repo.commit({}, "add jar");
    expect((await byPath())["lib/tool.jar"]!.binary).toBe(true);
  });

  it("calls a blob binary when it is not valid UTF-8, even without a NUL", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    write("data/latin1.txt", Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0xff, 0xfe, 0x0a]));
    repo.commit({ "src/ok.ts": "export const café = 1;\n" }, "add data");
    const files = await byPath();
    expect(files["data/latin1.txt"]!.binary).toBe(true);
    expect(files["src/ok.ts"]!.binary).toBe(false);
  });

  it("calls a file binary when its head blob cannot be read", async () => {
    repo = makeRepo();
    repo.commit({ "a.txt": "a\n" }, "init");
    repo.commit({ "evil\nname.ts": "export {};\n" }, "add");
    expect((await byPath())["evil\nname.ts"]!.binary).toBe(true);
  });

  it.skipIf(!gitHasAttrSource(installedGit))("reads attributes from the base, not the PR (git ≥ 2.40)", async () => {
    repo = makeRepo();
    write("tools/helper", ELF);
    repo.commit({ "a.txt": "a\n" }, "init");
    write(".gitattributes", "tools/* diff\n");
    repo.commit({ "tools/helper": null }, "delete helper");
    expect((await byPath())["tools/helper"]).toMatchObject({ status: "deleted", binary: true });
  });

  it.skipIf(gitHasAttrSource(installedGit))("ignores the user's global attributes file (git < 2.40)", async () => {
    repo = makeRepo();
    write("tools/helper", ELF);
    repo.commit({ "a.txt": "a\n" }, "init");
    write(".git/global-attrs", "* diff\n");
    repo.git("config", "core.attributesFile", join(repo.dir, ".git/global-attrs"));
    repo.commit({ "tools/helper": null }, "delete helper");
    expect((await byPath())["tools/helper"]).toMatchObject({ status: "deleted", binary: true });
  });
});
