import { afterEach, describe, expect, it } from "vitest";
import { testsSignals } from "../../src/signals/tests.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "./context.js";

const src = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join("");

async function missing(repo: TestRepo, change: Record<string, string>) {
  repo.commit({ "seed.txt": "s\n" }, "init");
  repo.commit(change, "change");
  const signals = await testsSignals(await contextFor(repo, "HEAD~1"));
  expect(signals.map((s) => s.id)).toEqual(["tests.missing", "tests.deleted"]);
  return signals[0]!;
}

/** Both signals for a change on top of `base`. */
async function both(repo: TestRepo, base: Record<string, string>, change: Record<string, string | null>) {
  repo.commit({ "seed.txt": "s\n", ...base }, "init");
  repo.commit(change, "change");
  const [missingSignal, deleted] = await testsSignals(await contextFor(repo, "HEAD~1"));
  return { missing: missingSignal!, deleted: deleted! };
}

describe("tests.missing counts only added test lines", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("is 1 when a security check and its tests are deleted together", async () => {
    repo = makeRepo();
    const s = await both(repo, { "src/csrf.ts": src(20), "src/csrf.test.ts": src(30) }, { "src/csrf.ts": null, "src/csrf.test.ts": null });
    expect(s.missing).toMatchObject({ value: 1, status: "derived" });
  });

  it("ignores deleted test lines when grading the added ones", async () => {
    repo = makeRepo();
    // 100 source lines; the test file loses 40 lines and gains 15: only the 15 count.
    const s = await both(repo, { "src/a.test.ts": src(40) }, { "src/a.ts": src(100), "src/a.test.ts": src(15).replace(/line/g, "new") });
    expect(s.missing.value).toBeCloseTo(0.5);
  });
});

describe("tests.deleted", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("is 1 and observed when a whole test file is deleted, naming it", async () => {
    repo = makeRepo();
    const { deleted } = await both(repo, { "src/a.ts": src(5), "src/a.test.ts": src(3) }, { "src/a.test.ts": null });
    expect(deleted).toMatchObject({ id: "tests.deleted", value: 1, status: "observed" });
    expect(deleted.evidence.map((e) => e.file)).toEqual(["src/a.test.ts"]);
  });

  it("is 1 when a PR deletes at least 10 more test lines than it adds", async () => {
    repo = makeRepo();
    const { deleted } = await both(repo, { "src/a.test.ts": src(30) }, { "src/a.test.ts": src(20) });
    expect(deleted).toMatchObject({ value: 1, status: "observed" });
    expect(deleted.evidence.map((e) => e.file)).toEqual(["src/a.test.ts"]);
    expect(deleted.summary).toMatch(/10 test lines/);
  });

  it("is 1 when a test file is renamed out of the test globs", async () => {
    repo = makeRepo();
    const { deleted } = await both(repo, { "src/a.test.ts": src(30) }, { "src/a.test.ts": null, "src/a.fixture.ts": src(30) });
    expect(deleted.value).toBe(1);
    expect(deleted.evidence.map((e) => e.file)).toEqual(["src/a.fixture.ts"]);
  });

  it("is 0 for a net deletion under 10 lines", async () => {
    repo = makeRepo();
    const { deleted } = await both(repo, { "src/a.test.ts": src(30) }, { "src/a.test.ts": src(21) });
    expect(deleted).toMatchObject({ value: 0, status: "observed", evidence: [] });
  });

  it("is 0 when rewritten tests are as long as before", async () => {
    repo = makeRepo();
    const { deleted } = await both(repo, { "src/a.test.ts": src(30) }, { "src/a.test.ts": src(30).replace(/line/g, "new") });
    expect(deleted.value).toBe(0);
  });

  it("is 0 when tests are only added", async () => {
    repo = makeRepo();
    expect((await both(repo, {}, { "src/a.ts": src(10), "src/a.test.ts": src(10) })).deleted.value).toBe(0);
  });
});

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

  it("stays at 1 when the only test change is an empty file", async () => {
    repo = makeRepo();
    const s = await missing(repo, { "src/a.ts": src(10), "src/a.test.ts": "" });
    expect(s).toMatchObject({ value: 1, status: "derived" });
  });

  it("barely drops for a token test edit", async () => {
    repo = makeRepo();
    const s = await missing(repo, { "src/a.ts": src(100), "src/a.test.ts": "t\n" });
    expect(s.value).toBeCloseTo(1 - 1 / 30);
    expect(s.status).toBe("derived");
    expect(s.summary).toMatch(/1 test line.*100 source lines/);
  });

  it("grades by test lines against 30% of source lines", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "src/a.ts": src(100), "src/a.test.ts": src(15) })).value).toBeCloseTo(0.5);
  });

  it("is 0 with proportionate tests", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "src/a.ts": src(100), "src/a.test.ts": src(40) })).value).toBe(0);
  });

  it("ignores ignored files", async () => {
    repo = makeRepo();
    expect((await missing(repo, { "vendor/lib.go": "package x\n" })).value).toBe(0);
  });
});
