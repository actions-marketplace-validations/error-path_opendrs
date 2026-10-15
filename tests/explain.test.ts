import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitInfo, HistoryIndex } from "../src/domain/types.js";
import type { RepoGraph } from "../src/graph/graph.js";
import { OpendrsError } from "../src/domain/types.js";
import { parseConfig } from "../src/domain/config.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

vi.mock("../src/git/history.js", () => ({ buildHistoryIndex: vi.fn() }));
vi.mock("../src/graph/graph.js", () => ({ buildDependencyGraph: vi.fn() }));

const { buildHistoryIndex } = await import("../src/git/history.js");
const { buildDependencyGraph } = await import("../src/graph/graph.js");
const { explainFile } = await import("../src/explain.js");

function commit(sha: string, email: string, subject: string, files: string[], isFix = false, isRevert = false): CommitInfo {
  return { sha, parents: [], authorName: email.split("@")[0]!, authorEmail: email, time: 0, subject, files, isFix, isRevert };
}

function fakeHistory(commits: CommitInfo[]): HistoryIndex {
  return {
    commits,
    fileCommits: (path) => commits.filter((c) => c.files.includes(path)),
    fileCreator: () => undefined,
    authorCommitCount: () => 0,
  };
}

function fakeGraph(supported: boolean): RepoGraph {
  return {
    coverage: { files: 10, total: 10 },
    dependentsOf: () => ["a.ts", "b.ts"],
    transitiveDependents: (_p, depth) => new Set(depth >= 3 ? ["a.ts", "b.ts", "c.ts", "d.ts"] : ["a.ts", "b.ts"]),
    supports: () => supported,
    fileCount: 10,
  };
}

const HISTORY = [
  commit("5", "bob@x", "fix: null check", ["src/auth/login.ts"], true),
  commit("4", "alice@x", "feat: sso", ["src/auth/login.ts", "README.md"]),
  commit("3", "carol@x", "Revert \"feat\"", ["src/auth/login.ts"], false, true),
  commit("2", "alice@x", "refactor", ["src/auth/login.ts"]),
  commit("1", "dave@x", "unrelated", ["docs/x.md"]),
];

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
  repo.commit({ "src/auth/login.ts": "export const x = 1;\n", ".github/workflows/ci.yml": "on: push\n" }, "init");
  vi.mocked(buildHistoryIndex).mockResolvedValue(fakeHistory(HISTORY));
  vi.mocked(buildDependencyGraph).mockResolvedValue(fakeGraph(true));
});
afterEach(() => {
  repo.cleanup();
  vi.clearAllMocks();
});

describe("explainFile", () => {
  it("summarises history, dependents and path policy for a file", async () => {
    const config = parseConfig({});
    const out = await explainFile(repo.dir, "src/auth/login.ts", config);
    expect(out).toEqual({
      path: "src/auth/login.ts",
      commits: 4,
      fixCommits: 2,
      authors: 3,
      directDependents: 2,
      transitiveDependents: 4,
      critical: true,
      blocked: false,
      topAuthors: ["alice@x", "bob@x", "carol@x"],
    });
    expect(buildHistoryIndex).toHaveBeenCalledWith(repo.dir, "HEAD", config);
    expect(buildDependencyGraph).toHaveBeenCalledWith(repo.dir, "HEAD", config);
  });

  it("uses graph.maxDepth for transitive dependents", async () => {
    const out = await explainFile(repo.dir, "src/auth/login.ts", parseConfig({ graph: { maxDepth: 1 } }));
    expect(out.transitiveDependents).toBe(2);
  });

  it("reports blocked paths", async () => {
    const out = await explainFile(repo.dir, ".github/workflows/ci.yml", parseConfig({}));
    expect(out.blocked).toBe(true);
    expect(out.critical).toBe(false);
  });

  it("matches blocked and critical paths case-insensitively, like the gate", async () => {
    repo.commit({ "db/Migrations/1.sql": "create table t();\n", "lib/Auth/x.ts": "export const y = 1;\n" }, "add");
    expect((await explainFile(repo.dir, "db/Migrations/1.sql", parseConfig({}))).blocked).toBe(true);
    expect((await explainFile(repo.dir, "lib/Auth/x.ts", parseConfig({}))).critical).toBe(true);
  });

  it("gives null dependent counts when the graph build fails", async () => {
    vi.mocked(buildDependencyGraph).mockRejectedValue(new Error("boom"));
    const out = await explainFile(repo.dir, "src/auth/login.ts", parseConfig({}));
    expect(out.directDependents).toBeNull();
    expect(out.transitiveDependents).toBeNull();
    expect(out.commits).toBe(4);
  });

  it("gives null dependent counts when the language is unsupported", async () => {
    vi.mocked(buildDependencyGraph).mockResolvedValue(fakeGraph(false));
    const out = await explainFile(repo.dir, "src/auth/login.ts", parseConfig({}));
    expect(out.directDependents).toBeNull();
    expect(out.transitiveDependents).toBeNull();
  });

  it("does not build the graph when it is disabled", async () => {
    const out = await explainFile(repo.dir, "src/auth/login.ts", parseConfig({ graph: { enabled: false } }));
    expect(buildDependencyGraph).not.toHaveBeenCalled();
    expect(out.directDependents).toBeNull();
  });

  it("normalises ./ prefixes", async () => {
    const out = await explainFile(repo.dir, "./src/auth/login.ts", parseConfig({}));
    expect(out.path).toBe("src/auth/login.ts");
    expect(out.commits).toBe(4);
  });

  it("rejects a path that is neither at HEAD nor in history", async () => {
    await expect(explainFile(repo.dir, "nope.ts", parseConfig({}))).rejects.toBeInstanceOf(OpendrsError);
  });
});
