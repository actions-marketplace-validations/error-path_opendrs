import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

describe("git()", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("reports a timeout with an actionable message instead of swallowing it as generic stderr noise", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    // `cat-file --batch` blocks reading stdin, which `git()` never closes, so the child is
    // still running after any timeoutMs and reliably gets killed — unlike `git log`, which can
    // finish inside 1ms on fast CI runners and never time out at all.
    await expect(git(repo.dir, ["cat-file", "--batch"], { timeoutMs: 1 })).rejects.toThrow(/^git cat-file timed out after \d+s$/);
  });

  it("still reports a non-timeout failure the old way", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    await expect(git(repo.dir, ["log", "--not-a-real-flag"])).rejects.toThrow(/^git log failed:/);
  });
});
