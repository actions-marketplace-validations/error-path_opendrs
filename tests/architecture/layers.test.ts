import { afterEach, describe, expect, it } from "vitest";
import { detectLayers } from "../../src/architecture/layers.js";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import type { ChangedFile, ScoringContext } from "../../src/domain/types.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

function changed(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return { path, status: "modified", added: 1, deleted: 0, binary: false, hunks: [], ignored: false, ...extra };
}

function ctxFor(repo: TestRepo, base: string, head: string, files: ChangedFile[], config = defaultConfig()): ScoringContext {
  return {
    repoDir: repo.dir,
    trust: { authorVerified: true, historyComplete: true },
    diff: { base, head, files },
    config,
    history: { commits: [], fileCommits: () => [], fileCreator: () => undefined, authorCommitCount: () => 0 },
    readBase: async () => undefined,
    readHead: async (path) => {
      try {
        return repo.git("show", `${head}:${path}`);
      } catch {
        return undefined;
      }
    },
  };
}

describe("detectLayers", () => {
  let repo: TestRepo;
  afterEach(() => repo.cleanup());

  it("reports a new module import edge, with the importing file and line", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/api/users.ts": "export function listUsers() {}\n", "src/db/q.ts": "export function q() {}\n" }, "base");
    const head = repo.commit({ "src/api/users.ts": 'import { q } from "../db/q";\nexport function listUsers() { return q; }\n' }, "head");

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/api/users.ts")]), {});

    expect(result.notes).toEqual([]);
    expect(result.facts).toEqual([
      { id: "layers.edge", weight: "strong", file: "src/api/users.ts", line: 1, text: "`src/api` now imports `src/db` for the first time (`src/api/users.ts:1`)." },
    ]);
  });

  it("reports no fact when the module edge already existed at base via another file", async () => {
    repo = makeRepo();
    const base = repo.commit(
      {
        "src/api/admin.ts": 'import { q } from "../db/q";\n',
        "src/api/users.ts": "export function listUsers() {}\n",
        "src/db/q.ts": "export function q() {}\n",
      },
      "base",
    );
    const head = repo.commit({ "src/api/users.ts": 'import { q } from "../db/q";\nexport function listUsers() { return q; }\n' }, "head");

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/api/users.ts")]), {});

    expect(result.facts).toEqual([]);
  });

  it("reports no fact when the only importer is a test file", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/api/users.test.ts": "export const x = 1;\n", "src/db/q.ts": "export function q() {}\n" }, "base");
    const head = repo.commit({ "src/api/users.test.ts": 'import { q } from "../db/q";\nexport const x = q;\n' }, "head");

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/api/users.test.ts")]), {});

    expect(result.facts).toEqual([]);
  });

  it("reports a new cycle when the reverse module edge is added", async () => {
    repo = makeRepo();
    const base = repo.commit(
      {
        "src/api/users.ts": 'import { q } from "../db/q";\nexport function listUsers() { return q; }\n',
        "src/db/q.ts": "export function q() {}\n",
      },
      "base",
    );
    const head = repo.commit({ "src/db/q.ts": 'import { listUsers } from "../api/users";\nexport function q() { return listUsers; }\n' }, "head");

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/db/q.ts")]), {});

    const cycle = result.facts.find((f) => f.id === "layers.cycle");
    expect(cycle).toBeDefined();
    expect(cycle?.weight).toBe("strong");
    expect(cycle?.text).toContain("`src/api`");
    expect(cycle?.text).toContain("`src/db`");
    expect(cycle?.text).toContain("→");
  });

  it("notes when no changed file is in a supported language", async () => {
    repo = makeRepo();
    const sha = repo.commit({ "main.c": "int main() { return 0; }\n" }, "only commit");

    const result = await detectLayers(ctxFor(repo, sha, sha, [changed("main.c")]), {});

    expect(result.facts).toEqual([]);
    expect(result.notes).toEqual(["layers: no changed file is in a supported language"]);
  });

  it("notes when graph.enabled is false", async () => {
    repo = makeRepo();
    const sha = repo.commit({ "src/api/users.ts": "export function listUsers() {}\n" }, "only commit");
    const config = parseConfig({ graph: { enabled: false } });

    const result = await detectLayers(ctxFor(repo, sha, sha, [changed("src/api/users.ts")], config), {});

    expect(result.facts).toEqual([]);
    expect(result.notes).toEqual(["layers: graph.enabled is false"]);
  });

  it("treats same-module edges as intra-module when moduleDepth is 1", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/api/users.ts": "export function listUsers() {}\n", "src/db/q.ts": "export function q() {}\n" }, "base");
    const head = repo.commit({ "src/api/users.ts": 'import { q } from "../db/q";\nexport function listUsers() { return q; }\n' }, "head");
    const config = parseConfig({ captain: { moduleDepth: 1 } });

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/api/users.ts")], config), {});

    expect(result.facts).toEqual([]);
  });

  it("reports no edge fact when the importing module has no files at base", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/db/q.ts": "export function q() {}\n" }, "base");
    const head = repo.commit({ "src/newmod/a.ts": 'import { q } from "../db/q";\nexport const x = q;\n' }, "head");

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/newmod/a.ts")]), {});

    expect(result.facts).toEqual([]);
  });

  it("reports no edge fact when the imported module has no files at base", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/api/users.ts": "export function listUsers() {}\n" }, "base");
    const head = repo.commit(
      {
        "src/api/users.ts": 'import { q } from "../newmod/q";\nexport function listUsers() { return q; }\n',
        "src/newmod/q.ts": "export function q() {}\n",
      },
      "head",
    );

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/api/users.ts"), changed("src/newmod/q.ts")]), {});

    expect(result.facts).toEqual([]);
  });

  it("reports no new cycle when a new module extends an already-cyclic pair of existing modules", async () => {
    repo = makeRepo();
    const base = repo.commit(
      {
        "src/a/x.ts": 'import "../b/y";\nexport const a = 1;\n',
        "src/b/y.ts": 'import "../a/x";\nexport const b = 1;\n',
      },
      "base",
    );
    const head = repo.commit(
      {
        "src/b/y.ts": 'import "../a/x";\nimport "../c/z";\nexport const b = 1;\n',
        "src/c/z.ts": 'import "../a/x";\nexport const c = 1;\n',
      },
      "head",
    );

    const result = await detectLayers(ctxFor(repo, base, head, [changed("src/b/y.ts"), changed("src/c/z.ts")]), {});

    expect(result.facts).toEqual([]);
  });
});
