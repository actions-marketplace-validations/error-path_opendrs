import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { testIo } from "./helpers.js";

vi.mock("../../src/explain.js", () => ({ explainFile: vi.fn() }));
const { explainFile } = await import("../../src/explain.js");
const { runCli } = await import("../../src/cli/cli.js");

const EXPLANATION = {
  path: "src/auth/login.ts",
  commits: 12,
  fixCommits: 3,
  authors: 4,
  directDependents: null,
  transitiveDependents: null,
  critical: true,
  blocked: false,
  topAuthors: ["alice@x", "bob@x"],
};

let repo: TestRepo;
beforeEach(() => {
  repo = makeRepo();
  repo.commit({ "src/auth/login.ts": "x\n" }, "init");
  vi.mocked(explainFile).mockResolvedValue(EXPLANATION);
});
afterEach(() => {
  repo.cleanup();
  vi.clearAllMocks();
});

describe("opendrs explain", () => {
  it("resolves the path relative to the current directory", async () => {
    const t = testIo(join(repo.dir, "src"));
    expect(await runCli(["explain", "auth/login.ts"], t.io)).toBe(0);
    expect(vi.mocked(explainFile).mock.calls[0]![1]).toBe("src/auth/login.ts");
  });

  it("accepts an absolute path", async () => {
    const t = testIo(repo.dir);
    await runCli(["explain", join(repo.dir, "src/auth/login.ts")], t.io);
    expect(vi.mocked(explainFile).mock.calls[0]![1]).toBe("src/auth/login.ts");
  });

  it("prints a readable profile, showing unknown dependents as unknown", async () => {
    const t = testIo(repo.dir);
    await runCli(["explain", "src/auth/login.ts"], t.io);
    expect(t.stdout()).toContain("12 commits, 3 fixes or reverts, 4 authors");
    expect(t.stdout()).toMatch(/dependents\s+unknown/);
    expect(t.stdout()).toContain("critical path");
    expect(t.stdout()).toContain("alice@x, bob@x");
  });

  it("prints JSON with --json", async () => {
    const t = testIo(repo.dir);
    await runCli(["explain", "src/auth/login.ts", "--json"], t.io);
    expect(JSON.parse(t.stdout())).toEqual(EXPLANATION);
  });

  it("requires exactly one file", async () => {
    expect(await runCli(["explain"], testIo(repo.dir).io)).toBe(2);
    expect(await runCli(["explain", "a", "b"], testIo(repo.dir).io)).toBe(2);
  });
});
