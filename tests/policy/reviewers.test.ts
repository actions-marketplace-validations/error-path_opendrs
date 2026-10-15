import { describe, expect, it } from "vitest";
import { suggestReviewers } from "../../src/policy/reviewers.js";
import { fakeCommit, fakeHistory } from "./fakes.js";

describe("suggestReviewers", () => {
  it("ranks authors of the changed files, counting the last 90 days double", () => {
    const history = fakeHistory([
      fakeCommit("old@x.com", ["a.ts"], 400),
      fakeCommit("old@x.com", ["a.ts"], 300),
      fakeCommit("old@x.com", ["b.ts"], 200),
      fakeCommit("recent@x.com", ["a.ts"], 10),
      fakeCommit("recent@x.com", ["b.ts"], 5),
      fakeCommit("other@x.com", ["unrelated.ts"], 1),
    ]);
    expect(suggestReviewers(history, ["a.ts", "b.ts"], undefined)).toEqual(["recent@x.com", "old@x.com"]);
  });

  it("excludes the PR author case-insensitively", () => {
    const history = fakeHistory([fakeCommit("Me@X.com", ["a.ts"], 1), fakeCommit("you@x.com", ["a.ts"], 1)]);
    expect(suggestReviewers(history, ["a.ts"], "me@x.com")).toEqual(["you@x.com"]);
  });

  it("excludes bots and GitHub's noreply/actions identities", () => {
    const history = fakeHistory([
      fakeCommit("49699333+dependabot[bot]@users.noreply.github.com", ["a.ts"], 1),
      fakeCommit("41898282+github-actions[bot]@users.noreply.github.com", ["a.ts"], 1),
      fakeCommit("noreply@github.com", ["a.ts"], 1),
      fakeCommit("actions@github.com", ["a.ts"], 1),
      fakeCommit("human@x.com", ["a.ts"], 300),
    ]);
    expect(suggestReviewers(history, ["a.ts"], undefined)).toEqual(["human@x.com"]);
  });

  it("counts a commit touching several changed files once", () => {
    const history = fakeHistory([
      fakeCommit("wide@x.com", ["a.ts", "b.ts", "c.ts"], 200),
      fakeCommit("narrow@x.com", ["a.ts"], 210),
      fakeCommit("narrow@x.com", ["b.ts"], 220),
    ]);
    expect(suggestReviewers(history, ["a.ts", "b.ts", "c.ts"], undefined)).toEqual(["narrow@x.com", "wide@x.com"]);
  });

  it("breaks ties by most recent commit, then by email", () => {
    const history = fakeHistory([
      fakeCommit("zed@x.com", ["a.ts"], 200),
      fakeCommit("amy@x.com", ["a.ts"], 200),
      fakeCommit("bob@x.com", ["a.ts"], 150),
    ]);
    expect(suggestReviewers(history, ["a.ts"], undefined)).toEqual(["bob@x.com", "amy@x.com", "zed@x.com"]);
  });

  it("returns at most n reviewers and nothing for no history", () => {
    const history = fakeHistory(["a", "b", "c", "d"].map((n) => fakeCommit(`${n}@x.com`, ["f.ts"], 1)));
    expect(suggestReviewers(history, ["f.ts"], undefined)).toHaveLength(3);
    expect(suggestReviewers(history, ["f.ts"], undefined, 1)).toHaveLength(1);
    expect(suggestReviewers(fakeHistory([]), ["f.ts"], undefined)).toEqual([]);
  });
});
