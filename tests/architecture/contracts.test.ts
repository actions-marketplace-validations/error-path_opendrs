import { afterEach, describe, expect, it } from "vitest";
import { detectContracts } from "../../src/architecture/contracts.js";
import { defaultConfig, parseConfig, type OpendrsConfig } from "../../src/domain/config.js";
import type { ScoringContext } from "../../src/domain/types.js";
import { makeContext } from "../../src/engine.js";
import { loadDiff } from "../../src/git/diff.js";
import { buildDependencyGraph } from "../../src/graph/graph.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

async function contextFor(repo: TestRepo, base: string, head = "HEAD", config: OpendrsConfig = defaultConfig()): Promise<ScoringContext> {
  const diff = await loadDiff(repo.dir, base, head, config);
  const graph = config.graph.enabled ? await buildDependencyGraph(repo.dir, diff.base, config) : undefined;
  return makeContext(repo.dir, diff, config, { commits: [], fileCommits: () => [], fileCreator: () => undefined, authorCommitCount: () => 0 }, graph);
}

let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe("detectContracts: contract.dependency", () => {
  it("a new runtime dependency is a strong fact naming the file and the line of the new key", async () => {
    repo = makeRepo();
    const base = repo.commit({ "package.json": JSON.stringify({ dependencies: { foo: "^1.0.0" } }, null, 2) }, "base");
    repo.commit({ "package.json": JSON.stringify({ dependencies: { foo: "^1.0.0", jsonwebtoken: "^9.0.0" } }, null, 2) }, "head");

    const { facts, notes } = await detectContracts(await contextFor(repo, base), {});

    expect(notes).toEqual([]);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ id: "contract.dependency", weight: "strong", file: "package.json" });
    expect(facts[0]!.line).toBe(4); // the "jsonwebtoken" line
    expect(facts[0]!.text).toContain("jsonwebtoken");
    expect(facts[0]!.text).toContain("package.json:4");
  });

  it("an invalid manifest yields a note, not a fact or a throw", async () => {
    repo = makeRepo();
    const base = repo.commit({ "package.json": JSON.stringify({ dependencies: {} }) }, "base");
    repo.commit({ "package.json": "{ not json" }, "head");

    const { facts, notes } = await detectContracts(await contextFor(repo, base), {});

    expect(facts).toEqual([]);
    expect(notes).toHaveLength(1);
  });
});

describe("detectContracts: contract.api", () => {
  it("removing an exported declaration from a file with a dependent is a strong fact", async () => {
    repo = makeRepo();
    const base = repo.commit(
      {
        "src/auth/token.ts": "export function parseToken(raw: string) {\n  return raw;\n}\n",
        "src/auth/user.ts": 'import { parseToken } from "./token";\nparseToken("x");\n',
      },
      "base",
    );
    repo.commit({ "src/auth/token.ts": "export function other() {\n  return 1;\n}\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const apiFacts = facts.filter((f) => f.id === "contract.api");
    expect(apiFacts).toHaveLength(1);
    expect(apiFacts[0]).toMatchObject({ weight: "strong", file: "src/auth/token.ts" });
    expect(apiFacts[0]!.text).toContain("parseToken");
    expect(apiFacts[0]!.text).toContain("imported by 1 file");
  });

  it("an added public declaration with no matching deletion is info when the file has a dependent at base", async () => {
    repo = makeRepo();
    const base = repo.commit(
      { "src/util.ts": "export const a = 1;\n", "src/caller.ts": 'import { a } from "./util";\na;\n' },
      "base",
    );
    repo.commit({ "src/util.ts": "export const a = 1;\nexport function helper() {\n  return 2;\n}\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const apiFacts = facts.filter((f) => f.id === "contract.api");
    expect(apiFacts).toHaveLength(1);
    expect(apiFacts[0]).toMatchObject({ weight: "info", file: "src/util.ts" });
    expect(apiFacts[0]!.text).toContain("helper");
  });

  it("an added public declaration in a file with no dependent at base is not a fact", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/util.ts": "export const a = 1;\n" }, "base");
    repo.commit({ "src/util.ts": "export const a = 1;\nexport function helper() {\n  return 2;\n}\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.api")).toEqual([]);
  });

  it("a brand-new file never produces a contract.api fact, even with a dependent at head", async () => {
    repo = makeRepo();
    const base = repo.commit({}, "base");
    repo.commit(
      {
        "src/newfile.ts": "export function helper() {\n  return 2;\n}\n",
        "src/caller.ts": 'import { helper } from "./newfile";\nhelper();\n',
      },
      "head",
    );

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.api")).toEqual([]);
  });

  it("aggregates several added declarations in one file into a single info fact", async () => {
    repo = makeRepo();
    const base = repo.commit(
      { "src/util.ts": "export const a = 1;\n", "src/caller.ts": 'import { a } from "./util";\na;\n' },
      "base",
    );
    repo.commit(
      {
        "src/util.ts":
          "export const a = 1;\nexport function one() {\n  return 1;\n}\nexport function two() {\n  return 2;\n}\nexport function three() {\n  return 3;\n}\nexport function four() {\n  return 4;\n}\n",
      },
      "head",
    );

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const apiFacts = facts.filter((f) => f.id === "contract.api");
    expect(apiFacts).toHaveLength(1);
    expect(apiFacts[0]).toMatchObject({ weight: "info", file: "src/util.ts" });
    expect(apiFacts[0]!.text).toContain("4 exported declarations");
    expect(apiFacts[0]!.text).toContain("`one`");
    expect(apiFacts[0]!.text).toContain("`two`");
    expect(apiFacts[0]!.text).toContain("`three`");
    expect(apiFacts[0]!.text).not.toContain("`four`");
    expect(apiFacts[0]!.text).toContain("…");
  });
});

describe("detectContracts: contract.schema", () => {
  it("a changed migration/sql file is a strong contract.schema fact", async () => {
    repo = makeRepo();
    const base = repo.commit({ "db/migrations/001.sql": "create table a;\n" }, "base");
    repo.commit({ "db/migrations/001.sql": "create table a;\nalter table a add column b int;\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const schemaFacts = facts.filter((f) => f.id === "contract.schema");
    expect(schemaFacts).toHaveLength(1);
    expect(schemaFacts[0]).toMatchObject({ weight: "strong", file: "db/migrations/001.sql" });
  });

  it("four schema files report three facts plus a note counting the rest", async () => {
    repo = makeRepo();
    const base = repo.commit(
      { "a.sql": "1\n", "b.sql": "1\n", "c.sql": "1\n", "d.sql": "1\n" },
      "base",
    );
    repo.commit({ "a.sql": "2\n", "b.sql": "2\n", "c.sql": "2\n", "d.sql": "2\n" }, "head");

    const { facts, notes } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.schema")).toHaveLength(3);
    expect(notes).toContain("1 more schema file");
  });

  it("matches an extra glob from captain.contracts.paths", async () => {
    repo = makeRepo();
    const config = parseConfig({ captain: { contracts: { paths: ["**/*.custom-schema"] } } });
    const base = repo.commit({ "x.custom-schema": "1\n" }, "base");
    repo.commit({ "x.custom-schema": "2\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base, "HEAD", config), {});

    expect(facts.filter((f) => f.id === "contract.schema")).toHaveLength(1);
  });

  it("escapes a backtick in a schema file's path so it cannot break out of the rendered code span", async () => {
    repo = makeRepo();
    const path = "db/migrations/weird`file.sql";
    const base = repo.commit({ [path]: "create table a;\n" }, "base");
    repo.commit({ [path]: "alter table a;\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const schemaFacts = facts.filter((f) => f.id === "contract.schema");
    expect(schemaFacts).toHaveLength(1);
    expect(schemaFacts[0]!.text).not.toContain("`file.sql");
  });

  it("ignores a schema file under an ignored path", async () => {
    repo = makeRepo();
    const base = repo.commit({ "vendor/migrations/001.sql": "create table a;\n" }, "base");
    repo.commit({ "vendor/migrations/001.sql": "alter table a;\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts).toEqual([]);
  });
});

describe("detectContracts: contract.env", () => {
  it("a new environment variable not present at base is a strong fact", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/config.ts": "export const x = 1;\n" }, "base");
    repo.commit({ "src/config.ts": 'export const x = 1;\nconst secret = process.env.NEW_VAR;\n' }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    const envFacts = facts.filter((f) => f.id === "contract.env");
    expect(envFacts).toHaveLength(1);
    expect(envFacts[0]).toMatchObject({ weight: "strong", file: "src/config.ts" });
    expect(envFacts[0]!.text).toContain("NEW_VAR");
  });

  it("an environment variable already referenced at base does not fire", async () => {
    repo = makeRepo();
    const base = repo.commit({ "src/other.ts": "const existing = process.env.PATH_X;\n", "src/config.ts": "export const x = 1;\n" }, "base");
    repo.commit({ "src/config.ts": 'export const x = 1;\nconst p = process.env.PATH_X;\n' }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.env")).toEqual([]);
  });

  it("does not scan a docs file for a new environment variable", async () => {
    repo = makeRepo();
    const base = repo.commit({ "docs/plan.md": "notes\n" }, "base");
    repo.commit({ "docs/plan.md": "notes\nsee `process.env.NEW_VAR`\n" }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.env")).toEqual([]);
  });

  it("does not scan a test file for a new environment variable", async () => {
    repo = makeRepo();
    const base = repo.commit({ "tests/architecture/contracts.test.ts": "const x = 1;\n" }, "base");
    repo.commit({ "tests/architecture/contracts.test.ts": 'const x = 1;\nconst p = process.env.PATH_X;\n' }, "head");

    const { facts } = await detectContracts(await contextFor(repo, base), {});

    expect(facts.filter((f) => f.id === "contract.env")).toEqual([]);
  });
});
