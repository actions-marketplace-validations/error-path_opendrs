import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/domain/config.js";
import type { PolicyOutcome } from "../src/domain/types.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const POLICY: PolicyOutcome = { tier: "green", decision: "auto-approve", reasons: [], hardBlocked: false, sampled: false, mergeMethod: "queue", suggestedReviewers: [] };
vi.mock("../src/policy/gate.js", () => ({ decide: vi.fn(() => POLICY) }));

const { decide } = await import("../src/policy/gate.js");
const { scoreDiff } = await import("../src/engine.js");

const CLAUDE = "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>";
const DEPENDABOT = { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" };

describe("scoreDiff source", () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = makeRepo();
    repo.commit({ "a.ts": "1\n" }, "base");
  });
  afterEach(() => {
    repo.cleanup();
    vi.clearAllMocks();
  });

  const score = (head: string, account?: { login: string; type?: string }) =>
    scoreDiff({ repoDir: repo.dir, base: "main", head, config: defaultConfig(), llm: null, graph: null, account });
  const gateInput = () => vi.mocked(decide).mock.calls[0]![0] as unknown as Record<string, unknown>;

  it("classifies the PR from its own commits only and hands the gate the source and the PR's shas", async () => {
    repo.commit({ "a.ts": "2\n" }, CLAUDE); // on the base branch: does not count
    repo.git("checkout", "-q", "-b", "side");
    const s1 = repo.commit({ "a.ts": "3\n" }, "human work");
    repo.git("checkout", "-q", "main");
    repo.commit({ "b.ts": "1\n" }, "more base");
    repo.git("checkout", "-q", "side");
    repo.git("merge", "-q", "--no-edit", "main");
    const s2 = repo.commit({ "a.ts": "4\n" }, CLAUDE);

    const r = await score("side");
    expect(r.source).toEqual({ kind: "agent", name: "Claude Code", evidence: [`commit ${s2.slice(0, 7)}: trailer "Co-Authored-By: Claude <noreply@anthropic.com>"`], verified: false });
    expect(gateInput().source).toEqual(r.source);
    // Newest first, merges left out.
    expect(gateInput().prCommits).toEqual([s2, s1]);
  });

  it("is human for a plain branch", async () => {
    repo.git("checkout", "-q", "-b", "side");
    repo.commit({ "a.ts": "3\n" }, "human work");
    expect((await score("side")).source).toEqual({ kind: "human", name: "human", evidence: [], verified: false });
  });

  it("takes the PR account from the Action over the commits", async () => {
    repo.git("checkout", "-q", "-b", "side");
    repo.commit({ "a.ts": "3\n" }, "chore: bump", DEPENDABOT);
    expect((await score("side")).source).toMatchObject({ kind: "bot", name: "dependabot[bot]", verified: false });
    expect((await score("side", { login: "dependabot[bot]", type: "Bot" })).source).toMatchObject({ kind: "bot", verified: true });
  });

  it("scores a root commit against the empty tree", async () => {
    repo.git("checkout", "-q", "--orphan", "fresh");
    const root = repo.commit({ "z.ts": "1\n" }, CLAUDE);
    const { EMPTY_TREE } = await import("../src/git/diff.js");
    const r = await scoreDiff({ repoDir: repo.dir, base: EMPTY_TREE, head: root, config: defaultConfig(), llm: null, graph: null });
    expect(r.source.kind).toBe("agent");
    expect(gateInput().prCommits).toEqual([root]);
  });
});
