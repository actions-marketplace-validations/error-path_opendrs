import { afterEach, describe, expect, it } from "vitest";
import { expertiseSignals } from "../../src/signals/expertise.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { byId, contextFor } from "./context.js";

const ALICE = { name: "Alice", email: "alice@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };
const T = 1_700_000_000;

describe("expertiseSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  function seed() {
    repo = makeRepo();
    repo.commit({ "own.ts": "1\n" }, "alice creates own", ALICE, T + 100);
    repo.commit({ "major.ts": "1\n", "other.ts": "1\n" }, "bob creates two", BOB, T + 200);
    repo.commit({ "major.ts": "2\n" }, "alice edits major", ALICE, T + 300);
    repo.commit({ "major.ts": "3\n" }, "alice edits major", ALICE, T + 400);
  }

  it("counts the author's prior commits and the share of pre-existing files they own", async () => {
    seed();
    repo.commit({ "own.ts": "x\n", "major.ts": "x\n", "other.ts": "x\n", "brand-new.ts": "n\n" }, "change", { name: "A", email: "ALICE@example.com" }, T + 500);
    const signals = await expertiseSignals(await contextFor(repo, "HEAD~1"));
    expect(signals.map((s) => s.id)).toEqual(["expertise.author_commits", "expertise.owner_ratio"]);
    expect(byId(signals, "expertise.author_commits")).toMatchObject({ value: Math.log1p(3), status: "derived" });
    const owner = byId(signals, "expertise.owner_ratio");
    expect(owner).toMatchObject({ value: 2 / 3, status: "derived" });
    expect(owner.evidence.map((e) => e.file).sort()).toEqual(["major.ts", "own.ts"]);
  });

  it("honours asOf", async () => {
    seed();
    repo.commit({ "major.ts": "x\n" }, "change", ALICE, T + 500);
    const signals = await expertiseSignals(await contextFor(repo, "HEAD~1", "HEAD", { asOf: T + 350 }));
    expect(byId(signals, "expertise.author_commits").value).toBeCloseTo(Math.log1p(2));
    // Before T+400 alice has 1 of 2 commits on major.ts: not a majority.
    expect(byId(signals, "expertise.owner_ratio").value).toBe(0);
  });

  it("is unknown when the author email is missing", async () => {
    seed();
    repo.commit({ "own.ts": "x\n" }, "change", ALICE, T + 500);
    const ctx = await contextFor(repo, "HEAD~1");
    ctx.diff.author = undefined;
    const signals = await expertiseSignals(ctx);
    expect(signals.map((s) => [s.id, s.value, s.status])).toEqual([
      ["expertise.author_commits", 0, "unknown"],
      ["expertise.owner_ratio", 0, "unknown"],
    ]);
    expect(signals[0]!.summary).toMatch(/author/i);
  });

  it.each([
    [{ authorVerified: false, historyComplete: true }, /could not be verified/i],
    [{ authorVerified: true, historyComplete: false }, /shallow/i],
  ])("is unknown when the scoring context cannot be trusted (%j)", async (trust, why) => {
    seed();
    repo.commit({ "own.ts": "x\n", "major.ts": "x\n" }, "change", ALICE, T + 500);
    const ctx = await contextFor(repo, "HEAD~1");
    ctx.trust = trust;
    const signals = await expertiseSignals(ctx);
    expect(signals.map((s) => [s.id, s.value, s.status])).toEqual([
      ["expertise.author_commits", 0, "unknown"],
      ["expertise.owner_ratio", 0, "unknown"],
    ]);
    for (const s of signals) expect(s.summary).toMatch(why);
  });

  it("reports 0 ownership when only new files changed", async () => {
    seed();
    repo.commit({ "fresh.ts": "x\n" }, "change", ALICE, T + 500);
    const owner = byId(await expertiseSignals(await contextFor(repo, "HEAD~1")), "expertise.owner_ratio");
    expect(owner).toMatchObject({ value: 0, status: "derived" });
    expect(owner.summary).toMatch(/no pre-existing/i);
  });
});
