import { afterEach, describe, expect, it } from "vitest";
import { languageFamily, languageSignals } from "../../src/signals/language.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "./context.js";

describe("languageFamily", () => {
  it.each([
    ["a.ts", "ts"],
    ["a.tsx", "ts"],
    ["a.mjs", "js"],
    ["a/b.py", "py"],
    ["main.go", "go"],
    ["A.java", "java"],
    ["b.kts", "kotlin"],
    ["lib.rs", "rust"],
    ["x.rb", "ruby"],
    ["x.hpp", "c_cpp"],
    ["x.c", "c_cpp"],
    ["x.cs", "csharp"],
    ["x.php", "php"],
    ["x.swift", "swift"],
    ["q.SQL", "sql"],
    ["run.sh", "shell"],
    ["c.yml", "config"],
    ["c.json", "config"],
    ["Cargo.toml", "config"],
    ["setup.ini", "config"],
    ["README.md", "docs"],
    ["notes.txt", "docs"],
    ["index.rst", "docs"],
    ["Makefile", "other"],
    ["logo.png", "other"],
  ])("%s -> %s", (path, family) => {
    expect(languageFamily(path)).toBe(family);
  });
});

describe("languageSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("emits one lang.<family> per family present among non-ignored files", async () => {
    repo = makeRepo();
    repo.commit({ "x.txt": "x\n" }, "init");
    repo.commit({ "a.ts": "a\n", "b.tsx": "b\n", "c.py": "c\n", "README.md": "r\n", "Cargo.lock": "l\n", "ü.go": "package x\n" }, "change");
    const signals = await languageSignals(await contextFor(repo, "HEAD~1"));
    expect(signals.map((s) => s.id).sort()).toEqual(["lang.docs", "lang.go", "lang.py", "lang.ts"]);
    const ts = signals.find((s) => s.id === "lang.ts")!;
    expect(ts).toMatchObject({ value: 1, status: "derived", summary: "2 ts files changed" });
    expect(ts.evidence.map((e) => e.file)).toEqual(["a.ts", "b.tsx"]);
  });

  it("emits nothing for an empty diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    expect(await languageSignals(await contextFor(repo, "HEAD"))).toEqual([]);
  });
});
