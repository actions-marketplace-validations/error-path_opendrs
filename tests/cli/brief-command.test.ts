import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/cli.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { testIo } from "./helpers.js";

let repo: TestRepo | undefined;
afterEach(() => repo?.cleanup());

/** main: a.ts with a fix commit; the branch edits the fixed lines. */
function repoWithFix(): TestRepo {
  const r = makeRepo();
  r.commit({ "a.ts": "1\n2\n3\n" }, "base");
  r.commit({ "a.ts": "1\nFIXED\n3\n" }, "fix: NPE in a.ts");
  r.git("checkout", "-q", "-b", "feature");
  r.commit({ "a.ts": "1\nchanged again\n3\n" }, "change");
  return r;
}

describe("opendrs brief", () => {
  it("prints the markdown brief by default with a fix-blame reason and a fix-regression question, exit 0", async () => {
    repo = repoWithFix();
    const { io, stdout, stderr } = testIo(repo.dir);
    const code = await runCli(["brief", "--base", "main"], io);
    expect(code).toBe(0);
    expect(stderr()).toBe("");
    const out = stdout();
    expect(out.split("\n")[0]).toMatch(/^opendrs review brief v1 · /);
    expect(out).toContain("## Review first");
    expect(out).toContain("«fix: NPE in a.ts»");
    expect(out).toContain("Does this change bring that problem back?");
  });

  it("--json prints a parseable ReviewBrief", async () => {
    repo = repoWithFix();
    const { io, stdout } = testIo(repo.dir);
    expect(await runCli(["brief", "--base", "main", "--json"], io)).toBe(0);
    const brief = JSON.parse(stdout());
    expect(brief.version).toBe(1);
    expect(brief.reviewFirst[0].hunks[0].reasons.some((r: { kind: string }) => r.kind === "fix-blame")).toBe(true);
  });

  it("--max-tokens overrides config.brief.maxTokens and rejects a bad value", async () => {
    repo = repoWithFix();
    const { io, stdout } = testIo(repo.dir);
    await runCli(["brief", "--base", "main", "--json", "--max-tokens", "500"], io);
    expect(JSON.parse(stdout()).budget.maxTokens).toBe(500);

    const bad = testIo(repo.dir);
    expect(await runCli(["brief", "--base", "main", "--max-tokens", "lots"], bad.io)).toBe(2);
    expect(bad.stderr()).toContain("--max-tokens must be a positive integer");
  });

  it("--max-tokens rejects a value too small to fit the brief's mandatory sections", async () => {
    repo = repoWithFix();
    const { io, stderr } = testIo(repo.dir);
    expect(await runCli(["brief", "--base", "main", "--max-tokens", "100"], io)).toBe(2);
    expect(stderr()).toContain("--max-tokens must be at least 300");
  });

  it("--no-llm is accepted and still exits 0", async () => {
    repo = repoWithFix();
    const { io } = testIo(repo.dir);
    expect(await runCli(["brief", "--base", "main", "--no-llm"], io)).toBe(0);
  });

  it("is listed in the top-level help", async () => {
    repo = makeRepo();
    const { io, stdout } = testIo(repo.dir);
    await runCli(["--help"], io);
    expect(stdout()).toMatch(/^\s+brief\s+Build the review brief/m);
  });
});
