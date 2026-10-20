import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import type { ChangedFile, Hunk } from "../../src/domain/types.js";
import { EMPTY_TREE } from "../../src/git/diff.js";
import { countedChangedLines, sizeSignals } from "../../src/signals/size.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { byId, contextFor } from "./context.js";

const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("sizeSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("emits exactly the size ids", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, "HEAD"));
    expect(signals.map((s) => s.id)).toEqual(["size.churn", "size.relative", "size.new_files_only", "size.comment_only"]);
  });

  it("measures churn and relative size, excluding ignored files", async () => {
    repo = makeRepo();
    repo.commit({ "src/a.ts": ten, "package-lock.json": "{}\n" }, "init");
    repo.commit(
      { "src/a.ts": ten.replace("line 3", "LINE 3"), "src/new.ts": "x\ny\nz\n", "package-lock.json": "{\n  \"a\": 1\n}\n" },
      "change",
    );
    const signals = await sizeSignals(await contextFor(repo, "HEAD~1"));

    const churn = byId(signals, "size.churn");
    expect(churn.value).toBeCloseTo(Math.log1p(2 + 3));
    expect(churn.status).toBe("observed");
    expect(churn.summary).toBe("5 lines changed across 2 files (1 new); 1 ignored");
    expect(churn.evidence.map((e) => e.file)).toEqual(["src/new.ts", "src/a.ts"]);

    const relative = byId(signals, "size.relative");
    expect(relative.value).toBeCloseTo(Math.log1p(2 / 10));
    expect(relative.status).toBe("derived");

    expect(byId(signals, "size.new_files_only")).toMatchObject({ value: 0, status: "observed" });
  });

  it("flags a diff of only new files", async () => {
    repo = makeRepo();
    const first = repo.commit({ "a.ts": "a\n", "b/c.ts": "c\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, EMPTY_TREE, first));
    expect(byId(signals, "size.new_files_only").value).toBe(1);
    expect(byId(signals, "size.relative")).toMatchObject({ value: 0, status: "derived" });
  });

  it("handles an empty diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, "HEAD"));
    expect(signals.map((s) => [s.id, s.value])).toEqual([
      ["size.churn", 0],
      ["size.relative", 0],
      ["size.new_files_only", 0],
      ["size.comment_only", 0],
    ]);
  });

  it("handles a binary-only diff", async () => {
    repo = makeRepo();
    repo.commit({ "img.bin": "\u0000\u0001" }, "init");
    repo.commit({ "img.bin": "\u0000\u0002" }, "change");
    const signals = await sizeSignals(await contextFor(repo, "HEAD~1"));
    expect(byId(signals, "size.churn").value).toBe(0);
    expect(byId(signals, "size.relative").value).toBe(0);
  });

  it("reports relative size as unknown when base contents cannot be read", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": ten }, "init");
    repo.commit({ "a.ts": ten + "more\n" }, "change");
    const ctx = await contextFor(repo, "HEAD~1");
    ctx.readBase = async () => undefined;
    const relative = byId(await sizeSignals(ctx), "size.relative");
    expect(relative).toMatchObject({ value: 0, status: "unknown" });
    expect(relative.summary).toMatch(/could not read/i);
  });

  describe("size.comment_only", () => {
    const code = "// header\nexport const a = 1;\n\n# not code in ts, but a comment line\nexport const b = 2;\n";

    async function commentOnly(before: Record<string, string>, after: Record<string, string>) {
      repo = makeRepo();
      repo.commit(before, "init");
      repo.commit(after, "change");
      return byId(await sizeSignals(await contextFor(repo, "HEAD~1")), "size.comment_only");
    }

    it("is 1 when only comments and blank lines change", async () => {
      const s = await commentOnly({ "src/a.ts": code }, { "src/a.ts": code.replace("// header", "// new header\n/* note */\n * more\n") });
      expect(s).toMatchObject({ value: 1, status: "observed" });
      expect(s.summary).toMatch(/only comments or blank lines/);
    });

    it("is 0 when a code line changes too", async () => {
      const s = await commentOnly({ "src/a.ts": code }, { "src/a.ts": code.replace("// header", "// new").replace("a = 1", "a = 2") });
      expect(s.value).toBe(0);
    });

    it("is 0 when code is commented out", async () => {
      const s = await commentOnly({ "src/a.ts": code }, { "src/a.ts": code.replace("export const a = 1;", "// export const a = 1;") });
      expect(s.value).toBe(0);
    });

    it("ignores ignored files", async () => {
      const s = await commentOnly(
        { "src/a.ts": code, "package-lock.json": "{}\n" },
        { "src/a.ts": code.replace("// header", "// new"), "package-lock.json": "{ \"a\": 1 }\n" },
      );
      expect(s.value).toBe(1);
    });

    it("is 0 when a file is renamed, since a move can break importers", async () => {
      repo = makeRepo();
      repo.commit({ "src/a.ts": code }, "init");
      repo.commit({ "src/a.ts": null, "src/b.ts": code.replace("// header", "// moved") }, "move");
      const ctx = await contextFor(repo, "HEAD~1");
      expect(ctx.diff.files.map((f) => f.status)).toEqual(["renamed"]);
      expect(byId(await sizeSignals(ctx), "size.comment_only").value).toBe(0);
    });

    it("is 0 when no line changed", async () => {
      const s = await commentOnly({ "src/a.ts": code }, { "src/empty.ts": "" });
      expect(s.value).toBe(0);
    });

    it.each([
      ["deleting block-comment delimiters re-enables code", "src/a.ts", "x();\n/*\nlegacyCheck();\n*/\n", "x();\nlegacyCheck();\n"],
      ["wrapping code in a new block comment disables it", "src/a.ts", "x();\nlegacyCheck();\n", "x();\n/*\nlegacyCheck();\n*/\n"],
      ["a go:embed directive", "main.go", "//go:embed static/*\nvar fs embed.FS\n", "//go:embed secrets/*\nvar fs embed.FS\n"],
      ["a build constraint", "main.go", "package main\n", "//go:build linux\npackage main\n"],
      ["a ts-nocheck pragma", "src/a.ts", "x();\n", "// @ts-nocheck\nx();\n"],
      ["an eslint-disable block comment", "src/a.js", "x();\n", "/* eslint-disable */\nx();\n"],
      ["a type: ignore comment", "a.py", "x = f()\n", "# type: ignore\nx = f()\n"],
      ["a shebang", "run.sh", "#!/bin/sh\necho hi\n", "#!/bin/bash\necho hi\n"],
      ["a CSS id selector", "app.css", "#main {\n  color: red;\n}\n", "#header {\n  color: red;\n}\n"],
      ["a C# directive", "A.cs", "#nullable enable\nclass A {}\n", "#nullable disable\nclass A {}\n"],
    ])("is 0 for %s", async (_, path, before, after) => {
      expect((await commentOnly({ [path]: before }, { [path]: after })).value).toBe(0);
    });

    it.each([
      ["a Python comment", "a.py", "# old note\nx = 1\n", "# new note\nx = 1\n"],
      ["a one-line block comment", "src/a.ts", "x();\n", "/* why x runs first */\nx();\n"],
      ["a SQL comment", "q.sql", "-- old\nSELECT 1;\n", "-- new\nSELECT 1;\n"],
      ["a YAML comment", "c.yml", "# old\na: 1\n", "# new\na: 1\n"],
    ])("is 1 for %s", async (_, path, before, after) => {
      expect((await commentOnly({ [path]: before }, { [path]: after })).value).toBe(1);
    });

    it("is 0 for a binary-only diff", async () => {
      const s = await commentOnly({ "img.bin": "\u0000\u0001" }, { "img.bin": "\u0000\u0002" });
      expect(s.value).toBe(0);
    });
  });
});

const hunk = (lines: string[]): Hunk => ({ oldStart: 1, oldLines: 0, newStart: 1, newLines: lines.length, lines });

const changedFile = (path: string, over: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  status: "modified",
  added: 0,
  deleted: 0,
  binary: false,
  hunks: [],
  ignored: false,
  ...over,
});

describe("countedChangedLines", () => {
  it("counts a binary file as 1 regardless of path", () => {
    const f = changedFile("CLAUDE.md", { binary: true });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("counts an instructions file in full even though it is also docs-family", () => {
    const f = changedFile("CLAUDE.md", { added: 50, deleted: 10, hunks: [hunk(Array(60).fill("+x"))] });
    expect(countedChangedLines([f], defaultConfig())).toBe(60);
  });

  it("counts a test file in full even when sizeCapExempt matches everything", () => {
    const config = parseConfig({ autoApprove: { sizeCapExempt: ["**/*"] } });
    const f = changedFile("tests/a.test.ts", { added: 40, deleted: 0, hunks: [hunk(Array(40).fill("+x"))] });
    expect(countedChangedLines([f], config)).toBe(40);
  });

  it("zeroes a file matched by autoApprove.sizeCapExempt", () => {
    const config = parseConfig({ autoApprove: { sizeCapExempt: ["notes/**"] } });
    const f = changedFile("notes/a.txt", { added: 30, deleted: 0, hunks: [hunk(Array(30).fill("+x"))] });
    expect(countedChangedLines([f], config)).toBe(0);
  });

  it("zeroes a docs-family file (.md) with no sizeCapExempt entry needed", () => {
    const f = changedFile("README.md", { added: 100, deleted: 5, hunks: [hunk(Array(105).fill("+x"))] });
    expect(countedChangedLines([f], defaultConfig())).toBe(0);
  });

  it("excludes only a comment-only hunk, counting a sibling real-code hunk in full", () => {
    const f = changedFile("src/a.ts", {
      added: 3,
      deleted: 0,
      hunks: [hunk(["+// just a comment", "+// another"]), hunk(["+const x = 1;"])],
    });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("a mixed hunk (one real-code line among comments) counts every line in that hunk", () => {
    const f = changedFile("src/a.ts", { hunks: [hunk(["+// comment", "+const x = 1;"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(2);
  });

  it("a renamed file is never comment-only even if every hunk line is a comment", () => {
    const f = changedFile("src/b.ts", { status: "renamed", oldPath: "src/a.ts", added: 1, deleted: 0, hunks: [hunk(["+// comment"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });

  it("countInertLines: true restores the raw count, ignoring every exclusion", () => {
    const config = parseConfig({ autoApprove: { countInertLines: true } });
    const f = changedFile("README.md", { added: 20, deleted: 0 });
    expect(countedChangedLines([f], config)).toBe(20);
  });

  it("everything else (a plain source line) counts in full", () => {
    const f = changedFile("src/a.ts", { hunks: [hunk(["+const x = 1;"])] });
    expect(countedChangedLines([f], defaultConfig())).toBe(1);
  });
});
