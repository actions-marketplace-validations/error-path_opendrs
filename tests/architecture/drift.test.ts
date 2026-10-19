import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import type { ScoringContext } from "../../src/domain/types.js";
import { detectDrift } from "../../src/architecture/drift.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

/** A minimal ScoringContext: detectDrift only reads repoDir, diff.base/head, paths.ignore and captain.moduleDepth. */
function ctxFor(repo: TestRepo, base: string, head: string): ScoringContext {
  return {
    repoDir: repo.dir,
    trust: { authorVerified: true, historyComplete: true },
    diff: { base, head, files: [] },
    config: defaultConfig(),
    history: { commits: [], fileCommits: () => [], fileCreator: () => undefined, authorCommitCount: () => 0 },
    readBase: async () => undefined,
    readHead: async () => undefined,
  };
}

/** `n` lines of filler content, each distinct so every line counts once in `git diff --numstat`. */
const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i}`).join("\n") + "\n";

let repo: TestRepo | undefined;
afterEach(() => {
  repo?.cleanup();
  repo = undefined;
});

describe("detectDrift", () => {
  it("reports no fact when growth stays inside the original modules", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(5, "g1") }, "first");
    const head = repo.commit({ "src/auth/gen2.ts": lines(5, "g2"), "src/auth/a.ts": lines(4, "a") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 1 });
    expect(result).toEqual({ facts: [], notes: [] });
  });

  it("fires info for one new file outside the original modules", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(5, "g1") }, "first");
    const head = repo.commit({ "src/auth/gen1.ts": lines(5, "g1"), "src/other/c.ts": lines(2, "c") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 1 });
    expect(result.notes).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.id).toBe("drift.scope");
    expect(result.facts[0]!.weight).toBe("info");
    expect(result.facts[0]!.text).toContain("src/other/c.ts");
  });

  it("fires strong for three new files outside the original modules", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(5, "g1") }, "first");
    const head = repo.commit(
      { "src/other/c1.ts": lines(2, "c1"), "src/other/c2.ts": lines(2, "c2"), "src/billing/c3.ts": lines(2, "c3") },
      "head",
    );

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 1 });
    expect(result.notes).toEqual([]);
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.weight).toBe("strong");
  });

  it("fires strong when churn at least doubles and grows by more than 100 lines", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(40, "g1") }, "first");
    // Same module throughout, and only one new (outside) file: churn alone must drive this to strong.
    const head = repo.commit({ "src/auth/gen1.ts": lines(40, "g1"), "src/other/out.ts": lines(1, "o"), "src/auth/gen2.ts": lines(100, "g2") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 1 });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.weight).toBe("strong");
  });

  it("does not escalate to strong when churn grows by 100 lines or fewer", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(40, "g1") }, "first");
    const head = repo.commit({ "src/auth/gen1.ts": lines(40, "g1"), "src/other/out.ts": lines(1, "o"), "src/auth/gen2.ts": lines(79, "g2") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 1 });
    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]!.weight).toBe("info");
  });

  it("does not count files that only arrived by merging the current base forward (both diffs are three-dot)", async () => {
    repo = makeRepo();
    const baseOld = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base old");
    const first = repo.commit({ "src/auth/gen1.ts": lines(5, "g1") }, "first"); // on main, off baseOld

    // The base ref (e.g. main) moves on independently, then the PR merges it in.
    repo.git("checkout", "-q", "-b", "upstream", baseOld);
    const baseNew = repo.commit({ "src/mainlib/extra.ts": lines(2, "e") }, "base moves on");
    repo.git("checkout", "-q", "main");
    repo.git("merge", "-q", "--no-ff", "-m", "merge upstream", "upstream");
    const head = repo.git("rev-parse", "HEAD");

    // The current base is now baseNew; three-dot diffs against it exclude extra.ts from both F1 and Fn.
    const result = await detectDrift(ctxFor(repo, baseNew, head), { firstHead: first, firstRun: 1 });
    expect(result).toEqual({ facts: [], notes: [] });
  });

  it("notes the first scored head is unreachable when it is missing and no remote has it", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const head = repo.commit({ "src/other/c.ts": lines(2, "c") }, "head");
    const unknownSha = "f".repeat(40);

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: unknownSha, firstRun: 1 });
    expect(result).toEqual({ facts: [], notes: ["drift: the first scored head is no longer reachable"] });
  });

  it("notes that drift is not tracked here when firstHead is absent", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const head = repo.commit({ "src/other/c.ts": lines(2, "c") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), {});
    expect(result).toEqual({ facts: [], notes: ["drift: not tracked here"] });
  });

  it("reports no fact and no note when the first scored head is the current head", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const head = repo.commit({ "src/other/c.ts": lines(2, "c") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: head, firstRun: 1 });
    expect(result).toEqual({ facts: [], notes: [] });
  });

  it("phrases an old marker's firstRun as 'since run k'", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/auth/a.ts": lines(3, "a") }, "base");
    const first = repo.commit({ "src/auth/gen1.ts": lines(5, "g1") }, "first");
    const head = repo.commit({ "src/auth/gen1.ts": lines(5, "g1"), "src/other/c.ts": lines(2, "c") }, "head");

    const result = await detectDrift(ctxFor(repo, base, head), { firstHead: first, firstRun: 3 });
    expect(result.facts[0]!.text).toContain(`since run 3 at \`${first.slice(0, 7)}\``.replace("since", "Since"));
    expect(result.facts[0]!.text).not.toContain("opendrs first scored this PR");
  });
});
