import { afterEach, describe, expect, it } from "vitest";
import { detectRisk } from "../../src/architecture/risk.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "../signals/context.js";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe("detectRisk: change.concurrency", () => {
  it("fires strong on a changed line using a concurrency primitive, naming the file and line", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/C.java": "class C {\n  int n;\n}\n" }, "base");
    repo.commit({ "src/C.java": "class C {\n  private final AtomicInteger n = new AtomicInteger();\n}\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const risk = facts.filter((f) => f.id === "change.concurrency");
    expect(risk).toHaveLength(1);
    expect(risk[0]).toMatchObject({ weight: "strong", file: "src/C.java", line: 2 });
    expect(risk[0]!.text).toContain("AtomicInteger");
    expect(risk[0]!.text).toContain("src/C.java:2");
  });

  it("sees a removed synchronized block too (added or deleted both count)", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/C.java": "void f() {\n  synchronized (lock) {\n    n++;\n  }\n}\n" }, "base");
    repo.commit({ "src/C.java": "void f() {\n  n++;\n}\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.concurrency")).toHaveLength(1);
  });

  it("recognizes the added TS/JS equivalents: new Worker(, Atomics., SharedArrayBuffer", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.ts": "const x = 1;\n", "src/b.ts": "const y = 1;\n", "src/c.ts": "const z = 1;\n" }, "base");
    repo.commit(
      { "src/a.ts": "const x = 1;\nconst w = new Worker(url);\n", "src/b.ts": "const y = 1;\nAtomics.add(buf, 0, 1);\n", "src/c.ts": "const z = 1;\nconst s = new SharedArrayBuffer(8);\n" },
      "head",
    );

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const risk = facts.filter((f) => f.id === "change.concurrency");
    expect(risk.map((f) => f.file).sort()).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
  });

  it("recognizes the added Swift equivalents: DispatchQueue, actor, async let, Task {", async () => {
    repo = makeRepo();
    const base = repo.commit(
      { "a.swift": "struct A {}\n", "b.swift": "struct B {}\n", "c.swift": "struct C {}\n", "d.swift": "struct D {}\n" },
      "base",
    );
    repo.commit(
      {
        "a.swift": "struct A {}\nDispatchQueue.main.async {}\n",
        "b.swift": "struct B {}\nactor Counter {}\n",
        "c.swift": "struct C {}\nfunc f() async { async let x = g() }\n",
        "d.swift": "struct D {}\nTask { await f() }\n",
      },
      "head",
    );

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const risk = facts.filter((f) => f.id === "change.concurrency");
    expect(risk.map((f) => f.file).sort()).toEqual(["a.swift", "b.swift", "c.swift", "d.swift"]);
  });

  it("ignores a concurrency primitive inside a comment", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.go": "package a\n" }, "base");
    repo.commit({ "src/a.go": "package a\n// uses a sync.Mutex upstream, see go func below\nx := 1\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.concurrency")).toEqual([]);
  });

  it("ignores a test file", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.test.ts": "const x = 1;\n" }, "base");
    repo.commit({ "src/a.test.ts": "const x = 1;\nnew Worker(url);\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.concurrency")).toEqual([]);
  });

  it("ignores a docs file", async () => {
    repo = makeRepo();
    const base = repo.commit({ "docs/threads.md": "notes\n" }, "base");
    repo.commit({ "docs/threads.md": "notes\nsynchronized volatile Mutex\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.concurrency")).toEqual([]);
  });

  it("reports only one fact per file, at the first matching line", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/C.java": "class C {\n}\n" }, "base");
    repo.commit(
      { "src/C.java": "class C {\n  volatile int a;\n  synchronized void f() {}\n  Mutex m;\n}\n" },
      "head",
    );

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const risk = facts.filter((f) => f.id === "change.concurrency");
    expect(risk).toHaveLength(1);
    expect(risk[0]!.line).toBe(2);
    expect(risk[0]!.text).toContain("volatile");
  });

});

describe("detectRisk: change.safety_removed", () => {
  it("fires info, counting net deleted guard/error-handling lines, located at the first one", async () => {
    repo = makeRepo();
    const guarded = [
      "class A {",
      "  int f(String s) {",
      "    if (s == null) throw new IllegalArgumentException();",
      "    Preconditions.checkArgument(s.length() > 0);",
      "    try {",
      "      return g(s);",
      "    } catch (IOException e) {",
      "      return -1;",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const bare = ["class A {", "  int f(String s) {", "    return g(s);", "  }", "}", ""].join("\n");
    const base = repo.commit({ "src/A.java": guarded }, "base");
    repo.commit({ "src/A.java": bare }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const safety = facts.filter((f) => f.id === "change.safety_removed");
    expect(safety).toHaveLength(1);
    expect(safety[0]).toMatchObject({ weight: "info", file: "src/A.java" });
    expect(safety[0]!.text).toContain("3 error-handling or guard lines");
    expect(safety[0]!.text).toContain("src/A.java:3"); // the first deleted guard line (the null check's throw)
  });

  it("is net per hunk: a guard reworded in the same hunk does not fire", async () => {
    repo = makeRepo();
    const before = "class A {\n  int f(String s) {\n    if (s == null) throw new IllegalArgumentException();\n    return g(s);\n  }\n}\n";
    const after = "class A {\n  int f(String s) {\n    if (s == null) throw new NullPointerException(\"s\");\n    return g(s);\n  }\n}\n";
    const base = repo.commit({ "src/A.java": before }, "base");
    repo.commit({ "src/A.java": after }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.safety_removed")).toEqual([]);
  });

  it("ignores a guard removed from a test file", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.test.ts": "assert(x != null);\nf();\n" }, "base");
    repo.commit({ "src/a.test.ts": "f();\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.safety_removed")).toEqual([]);
  });

  it("ignores a guard removed inside a comment", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.ts": "// throw if x == null\nx();\n" }, "base");
    repo.commit({ "src/a.ts": "x();\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.safety_removed")).toEqual([]);
  });

  it("ignores a docs or config file even when it contains the word catch", async () => {
    repo = makeRepo();
    const base = repo.commit({ "conf.yml": "catch: true\nkeep: this\n" }, "base");
    repo.commit({ "conf.yml": "keep: this\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.safety_removed")).toEqual([]);
  });

  it("is 0 when there is nothing to remove", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/a.ts": "function f() {\n  return 1;\n}\n" }, "base");
    repo.commit({ "src/a.ts": "function f() {\n  return 2;\n}\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "change.safety_removed")).toEqual([]);
  });
});

describe("detectRisk: ordering and escaping", () => {
  it("returns change.concurrency facts before change.safety_removed, both with no notes", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/A.java": "class A {\n  int f() {\n    assert true;\n    return 1;\n  }\n}\n" }, "base");
    repo.commit({ "src/A.java": "class A {\n  synchronized int f() {\n    return 1;\n  }\n}\n" }, "head");

    const { facts, notes } = await detectRisk(await contextFor(repo, base), {});

    expect(notes).toEqual([]);
    expect(facts.map((f) => f.id)).toEqual(["change.concurrency", "change.safety_removed"]);
  });

  it("escapes a backtick in a changed file's path", async () => {
    repo = makeRepo();
    const path = "src/weird`file.java";
    const base = repo.commit({ [path]: "class A {\n}\n" }, "base");
    repo.commit({ [path]: "class A {\n  synchronized void f() {}\n}\n" }, "head");

    const { facts } = await detectRisk(await contextFor(repo, base), {});

    const risk = facts.filter((f) => f.id === "change.concurrency");
    expect(risk).toHaveLength(1);
    expect(risk[0]!.text).not.toContain("`file.java");
  });
});
