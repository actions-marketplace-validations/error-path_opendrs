import { afterEach, describe, expect, it } from "vitest";
import { testsSignals } from "../../src/signals/tests.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "./context.js";

async function missing(repo: TestRepo, change: Record<string, string>) {
  repo.commit({ "seed.txt": "s\n" }, "init");
  repo.commit(change, "change");
  const signals = await testsSignals(await contextFor(repo, "HEAD~1"));
  expect(signals.map((s) => s.id)).toEqual(["tests.missing"]);
  return signals[0]!;
}

describe("testsSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("is 1 when source changed without any test change", async () => {
    repo = makeRepo();
    const s = await missing(repo, { "src/a.ts": "a\n", "README.md": "r\n" });
    expect(s).toMatchObject({ value: 1, status: "derived" });
    expect(s.evidence.map((e) => e.file)).toEqual(["src/a.ts"]);
  });

  it("is 0 when a test file changed alongside source", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "src/a.ts": "a\n", "src/a.test.ts": "t\n" })).value).toBe(0);
  });

  it("recognises test directories and python test files", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "pkg/mod.py": "a\n", "pkg/test_mod.py": "t\n" })).value).toBe(0);
  });

  it("is 0 when only docs and config changed", async () => {
    repo = makeRepo();
    const s = await missing(repo, { "docs/a.md": "a\n", "config.yml": "a: 1\n" });
    expect(s.value).toBe(0);
    expect(s.summary).toMatch(/no source/i);
  });

  it("ignores ignored files", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "vendor/lib.go": "package x\n" })).value).toBe(0);
  });
});
