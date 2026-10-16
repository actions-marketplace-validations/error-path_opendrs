import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseConfig } from "../src/domain/config.js";
import { buildDependencyGraph } from "../src/graph/graph.js";
import { hotspots } from "../src/hotspots.js";
import { hotspotsCommand } from "../src/cli/commands/hotspots.js";
import type { CliIo } from "../src/cli/types.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

vi.mock("../src/graph/graph.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../src/graph/graph.js")>();
  return { ...mod, buildDependencyGraph: vi.fn(mod.buildDependencyGraph) };
});

const now = Math.floor(Date.now() / 1000);
let repo: TestRepo;

/** Five commits a day apart, the first `ago` seconds before now. */
function seed(repo: TestRepo, ago: number) {
  let t = now - ago;
  const at = () => (t += 86_400);
  repo.commit(
    {
      "src/util.ts": "export const u = 1;\n",
      "src/app.ts": 'import { u } from "./util.js";\nexport const a = u;\n',
      "src/calm.ts": "export const c = 1;\n",
      "dist/bundle.js": "built\n",
    },
    "init",
    undefined,
    at(),
  );
  repo.commit({ "src/util.ts": "export const u = 2;\n" }, "fix: off by one", { name: "Bob", email: "bob@example.com" }, at());
  repo.commit({ "src/util.ts": "export const u = 3;\n" }, "fix: null check", undefined, at());
  repo.commit({ "src/calm.ts": "export const c = 2;\n" }, "feat: tweak", undefined, at());
  repo.commit({ "src/calm.ts": "export const c = 3;\n" }, "feat: tweak again", undefined, at());
}

beforeEach(() => {
  repo = makeRepo();
  seed(repo, 10 * 86_400);
});
afterEach(() => repo.cleanup());

describe("hotspots", () => {
  it("ranks a file with fix commits above one with the same churn and none", async () => {
    const { hotspots: rows, warnings } = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }));
    expect(warnings).toEqual([]);
    const paths = rows.map((r) => r.path);
    expect(paths[0]).toBe("src/util.ts");
    expect(paths.indexOf("src/util.ts")).toBeLessThan(paths.indexOf("src/calm.ts"));
    const util = rows[0]!;
    expect(util).toMatchObject({ rank: 1, commits: 3, fixCommits: 2, authors: 2, transitiveDependents: 1, critical: false, blocked: false });
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.score >= r.score)).toBe(true);
  });

  it("excludes paths.ignore matches and respects top", async () => {
    const all = (await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }))).hotspots;
    expect(all.map((r) => r.path)).not.toContain("dist/bundle.js");
    expect(all).toHaveLength(3);
    const two = (await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }), 2)).hotspots;
    expect(two.map((r) => r.rank)).toEqual([1, 2]);
    expect(two.map((r) => r.path)).toEqual(all.slice(0, 2).map((r) => r.path));
  });

  it("only counts commits inside the lookback window", async () => {
    const rows = (await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] }, history: { lookbackDays: 1 } }))).hotspots;
    expect(rows.find((r) => r.path === "src/util.ts")).toMatchObject({ commits: 0, fixCommits: 0 });
  });

  it("measures the window from the newest commit, so an archived repo still ranks", async () => {
    const archived = makeRepo();
    try {
      seed(archived, 800 * 86_400);
      const rows = (await hotspots(archived.dir, parseConfig({ paths: { ignore: ["dist/**"] }, history: { lookbackDays: 365 } }))).hotspots;
      expect(rows.find((r) => r.path === "src/util.ts")).toMatchObject({ commits: 3, fixCommits: 2 });
    } finally {
      archived.cleanup();
    }
  });

  it("warns and leaves dependents unknown when the import graph fails", async () => {
    vi.mocked(buildDependencyGraph).mockRejectedValueOnce(new Error("boom"));
    const { hotspots: rows, warnings } = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }));
    expect(warnings).toEqual(["import graph failed: boom; dependents not shown"]);
    expect(rows[0]).toMatchObject({ path: "src/util.ts", transitiveDependents: null });
  });
});

describe("hotspotsCommand", () => {
  function io(): CliIo & { lines: string[]; errs: string[] } {
    const lines: string[] = [];
    const errs: string[] = [];
    return { cwd: repo.dir, env: {}, lines, errs, out: (l) => lines.push(l), err: (l) => errs.push(l), progress: () => {} };
  }

  it("prints a table with --top rows and JSON with --json", async () => {
    const table = io();
    expect(await hotspotsCommand.run(["--top", "1"], table)).toBe(0);
    const lines = table.lines.join("\n").split("\n");
    expect(lines[0]).toMatch(/^rank\s+score\s+file\s+fixes\s+commits\s+authors\s+dependents\s+flags$/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("src/util.ts");
    expect(table.errs).toEqual([]);

    const json = io();
    await hotspotsCommand.run(["--json", "--top", "2"], json);
    const rows = JSON.parse(json.lines.join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows[0].path).toBe("src/util.ts");
  });

  it("prints a graph failure as a warning on stderr", async () => {
    vi.mocked(buildDependencyGraph).mockRejectedValueOnce(new Error("boom"));
    const run = io();
    expect(await hotspotsCommand.run(["--top", "1"], run)).toBe(0);
    expect(run.errs).toEqual(["opendrs: warning: import graph failed: boom; dependents not shown"]);
    expect(run.lines.join("\n")).toContain("src/util.ts");
  });

  it("rejects a bad --top", async () => {
    await expect(hotspotsCommand.run(["--top", "0"], io())).rejects.toThrow(/--top/);
  });
});
