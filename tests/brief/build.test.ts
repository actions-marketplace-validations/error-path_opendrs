import { describe, expect, it } from "vitest";
import { buildBrief } from "../../src/brief/build.js";
import { renderBriefMarkdown } from "../../src/brief/render.js";
import { defaultConfig } from "../../src/domain/config.js";
import { makeContext } from "../../src/engine.js";
import { loadDiff } from "../../src/git/diff.js";
import { buildHistoryIndex } from "../../src/git/history.js";
import { fakeResult } from "../cli/helpers.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

async function ctxFor(repo: TestRepo, base: string, asOf?: number, trust?: { authorVerified: boolean; historyComplete: boolean }) {
  const config = defaultConfig();
  const diff = await loadDiff(repo.dir, base, "HEAD", config);
  const history = await buildHistoryIndex(repo.dir, diff.base, config);
  return makeContext(repo.dir, diff, config, history, undefined, asOf, trust);
}

describe("buildBrief", () => {
  it("finds a fix-blame reason and a fix-regression question on a real repo", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n3\n4\n5\n" }, "base");
    repo.commit({ "a.ts": "1\nFIXED\n3\n4\n5\n" }, "fix: NPE in a.ts");
    repo.commit({ "a.ts": "1\nFIXED but changed again\n3\n4\n5\n" }, "touch it");
    const ctx = await ctxFor(repo, "HEAD~1");

    const brief = await buildBrief(fakeResult(0.3), ctx, { maxTokens: 2500 });
    expect(brief.version).toBe(1);
    expect(brief.verdict).toEqual({ tier: "green", score: 0.3, decision: "auto-approve", why: "low risk" });
    const hunk = brief.reviewFirst.flatMap((f) => f.hunks).find((h) => h.reasons.some((r) => r.kind === "fix-blame"));
    expect(hunk).toMatchObject({ id: 1, oldStart: 1, newStart: 1, newLines: 5 });
    expect(brief.reviewFirst[0]!.reasons.some((r) => r.kind === "fix-history")).toBe(true);
    expect(brief.checks.some((c) => c.question.includes("bring that problem back"))).toBe(true);
    expect(brief.notRanked).toEqual({ hunks: 0, files: 0 });
    expect(brief.human).toEqual([]);
    expect(brief.notes).toEqual([]);
    expect(brief.budget).toMatchObject({ maxTokens: 2500, truncated: false });
    expect(renderBriefMarkdown(brief)).toContain("«fix: NPE in a.ts»");
    repo.cleanup();
  });

  it("never cites a commit at or after asOf", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n" }, "base", undefined, 1_600_000_000);
    const asOfSha = repo.commit({ "a.ts": "1\nX\n" }, "fix: before cutoff", undefined, 1_700_000_000);
    const futureFix = repo.commit({ "a.ts": "1\nX\n" }, "fix: after cutoff", undefined, 1_900_000_000);
    repo.commit({ "a.ts": "1\nY\n" }, "change", undefined, 1_950_000_000);
    const asOf = 1_800_000_000; // between the two fixes
    const ctx = await ctxFor(repo, asOfSha, asOf);

    const brief = await buildBrief(fakeResult(0.1), ctx, { maxTokens: 2500 });
    const shas = brief.reviewFirst.flatMap((f) => [...f.reasons, ...f.hunks.flatMap((h) => h.reasons)]).map((r) => r.sha);
    expect(shas).toContain(asOfSha);
    expect(shas).not.toContain(futureFix);
    repo.cleanup();
  });

  it("ignores an incidents file that exists only at the PR head: incidents come from the base commit", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n" }, "base");
    repo.commit({ "a.ts": "1\nX\n", ".opendrs/incidents.jsonl": '{"paths":["a.ts"],"note":"queue stalled"}\n' }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.checks.some((c) => c.question.startsWith("An incident"))).toBe(false);
    expect(brief.notes).toEqual([]);
    repo.cleanup();
  });

  it("asks the incident question from the base commit's incidents file", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n2\n", ".opendrs/incidents.jsonl": '{"paths":["a.ts"],"note":"queue stalled"}\n' }, "base");
    repo.commit({ "a.ts": "1\nX\n", ".opendrs/incidents.jsonl": null }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.checks.some((c) => c.question.includes("«queue stalled»"))).toBe(true);
    repo.cleanup();
  });

  it("builds a brief with no graph, no llm and a shallow-history note without throwing", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "a.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1", undefined, { authorVerified: true, historyComplete: false });
    const brief = await buildBrief(fakeResult(0.1), ctx, { maxTokens: 500, llm: false });
    expect(brief.version).toBe(1);
    expect(brief.notes).toEqual(["history is incomplete (shallow clone): blame and fix counts are lower bounds"]);
    repo.cleanup();
  });

  it("caps review-first at 8 files and 3 hunks per file and counts the rest as not ranked, on a 50-file diff", async () => {
    const repo = makeRepo();
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      before[`src/f${i}.ts`] = "a\n".repeat(20);
      // Three edits per file, each outside the others' 3-line context: three hunks.
      after[`src/f${i}.ts`] = ["b", "a", "a", "a", "a", "a", "a", "a", "b", "a", "a", "a", "a", "a", "a", "a", "b", "a", "a", "a"].join("\n") + "\n";
    }
    repo.commit(before, "base");
    repo.commit(after, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    const total = ctx.diff.files.reduce((n, f) => n + f.hunks.length, 0);
    expect(total).toBe(150);
    const brief = await buildBrief(fakeResult(0.5), ctx, { maxTokens: 6000 });
    expect(brief.reviewFirst).toHaveLength(8);
    for (const f of brief.reviewFirst) expect(f.hunks).toHaveLength(3);
    expect(brief.notRanked).toEqual({ files: 42, hunks: total - 24 });
    expect(brief.budget.maxTokens).toBe(6000);
    repo.cleanup();
  });

  it("picks a file's top 3 hunks by score but lists them in diff order", async () => {
    const repo = makeRepo();
    const before = Array.from({ length: 60 }, () => "a");
    const after = [...before];
    // Four hunks, each more than 6 unchanged lines from the next so they do not merge; the first is the
    // smallest and the last the largest, so a sort by score alone would list them backwards.
    after[0] = "b";
    for (let i = 14; i < 17; i++) after[i] = "if (x && y) {";
    for (let i = 29; i < 34; i++) after[i] = "if (x && y) {";
    for (let i = 44; i < 52; i++) after[i] = "if (x && y) {";
    repo.commit({ "src/a.ts": `${before.join("\n")}\n` }, "base");
    repo.commit({ "src/a.ts": `${after.join("\n")}\n` }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    expect(ctx.diff.files[0]!.hunks).toHaveLength(4);
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.reviewFirst[0]!.hunks.map((h) => h.id)).toEqual([2, 3, 4]);
    expect(brief.notRanked).toEqual({ hunks: 1, files: 0 });
    repo.cleanup();
  });

  it("clamps the budget to the 6000-token ceiling and defaults to 2500", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "a.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    expect((await buildBrief(fakeResult(0.1), ctx, { maxTokens: 9000 })).budget.maxTokens).toBe(6000);
    expect((await buildBrief(fakeResult(0.1), ctx)).budget.maxTokens).toBe(2500);
    repo.cleanup();
  });

  it("takes the verdict's why from the first hard rule, else the top contribution's summary", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "a.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");

    const blocked = fakeResult(0.2, "green", "human-review");
    blocked.policy.hardBlocked = true;
    blocked.policy.rules = [{ rule: "paths.block", reason: "hard block: Makefile matches paths.block" }];
    expect((await buildBrief(blocked, ctx)).verdict.why).toBe("hard block: Makefile matches paths.block");
    expect((await buildBrief(blocked, ctx)).human).toEqual(blocked.policy.rules);
    // A hard-blocked result from an older caller, with no rules at all, falls back to the policy line.
    const legacy = { ...blocked, policy: { ...blocked.policy, rules: undefined } };
    expect((await buildBrief(legacy, ctx)).verdict.why).toBe(blocked.policy.reasons[0]);

    const scored = fakeResult(0.4, "yellow", "human-review");
    scored.signals = [{ id: "blast.dependents", value: 3, status: "observed", summary: "37 files depend on the changed files", evidence: [] }];
    scored.contributions = [{ id: "blast.dependents", value: 3, weight: 0.5, contribution: 1.5 }];
    expect((await buildBrief(scored, ctx)).verdict.why).toBe("37 files depend on the changed files");
    repo.cleanup();
  });

  it("keeps a skimmable doc file out of Review first when the PR has a non-skimmable hunk, listing it only under Safe to skim", async () => {
    const repo = makeRepo();
    repo.commit({ "README.md": "# old\n", "src/a.ts": "1\n2\n3\n" }, "base");
    repo.commit({ "README.md": "# fix 1\n" }, "fix: typo in README");
    repo.commit({ "README.md": "# fix 2\n" }, "fix: another typo in README");
    repo.commit({ "README.md": "# updated\n", "src/a.ts": "1\n2\nCHANGED\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");

    const brief = await buildBrief(fakeResult(0.2), ctx, { llm: false });
    expect(brief.reviewFirst.map((f) => f.file)).toEqual(["src/a.ts"]);
    expect(brief.reviewFirstScope).toBe("code");
    expect(Array.isArray(brief.skim) ? brief.skim.map((s) => s.file) : "collapsed").toEqual(["README.md"]);

    const md = renderBriefMarkdown(brief);
    const reviewFirstSection = md.split("## Review first")[1]!.split(/\n## /)[0]!;
    expect(reviewFirstSection).not.toContain("README.md");
    expect(md).toContain("## Safe to skim\n- `README.md` (docs)");
    repo.cleanup();
  });

  it("lists skim-only files in Review first with an explicit note on a docs-only PR, and never doubles them under Safe to skim", async () => {
    const repo = makeRepo();
    repo.commit({ "README.md": "# old\n", "CHANGELOG.md": "# old\n" }, "base");
    repo.commit({ "README.md": "# updated\n", "CHANGELOG.md": "# updated\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");

    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.reviewFirstScope).toBe("skim-only");
    expect(brief.reviewFirst.map((f) => f.file).sort()).toEqual(["CHANGELOG.md", "README.md"]);
    expect(brief.skim).toEqual([]);

    const md = renderBriefMarkdown(brief);
    expect(md).toContain("Only docs/tests/generated files changed; nothing ranks above skim level.");
    expect(md).not.toContain("## Safe to skim");
    repo.cleanup();
  });

  it("builds a quick-confirm captain brief by default, since the stub detectors report no facts", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "a.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.captain).toEqual({ priority: "quick", why: [], facts: [], notes: [] });
    repo.cleanup();
  });

  it("omits the captain brief when captain.enabled is false", async () => {
    const repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
    repo.commit({ "a.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    ctx.config.captain.enabled = false;
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.captain).toBeUndefined();
    repo.cleanup();
  });

  it("is careful for a changed file matching paths.critical, even at a quiet tier", async () => {
    const repo = makeRepo();
    repo.commit({ "src/auth/token.ts": "1\n" }, "base");
    repo.commit({ "src/auth/token.ts": "2\n" }, "change");
    const ctx = await ctxFor(repo, "HEAD~1");
    const brief = await buildBrief(fakeResult(0.1), ctx, { llm: false });
    expect(brief.captain?.priority).toBe("careful");
    repo.cleanup();
  });
});
