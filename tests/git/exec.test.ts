import { afterEach, describe, expect, it } from "vitest";
import { git } from "../../src/git/exec.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

describe("git()", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("reports a timeout with an actionable message instead of swallowing it as generic stderr noise", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    await expect(git(repo.dir, ["log"], { timeoutMs: 1 })).rejects.toThrow(/^git log timed out after \d+s$/);
  });

  it("still reports a non-timeout failure the old way", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "init");
    await expect(git(repo.dir, ["log", "--not-a-real-flag"])).rejects.toThrow(/^git log failed:/);
  });
});
