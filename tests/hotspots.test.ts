import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/domain/config.js";
import { hotspots } from "../src/hotspots.js";
import { hotspotsCommand } from "../src/cli/commands/hotspots.js";
import type { CliIo } from "../src/cli/types.js";
import { makeRepo, type TestRepo } from "./helpers/repo.js";

const now = Math.floor(Date.now() / 1000);
let repo: TestRepo;

beforeEach(() => {
  repo = makeRepo();
  let t = now - 10 * 86_400;
  const at = () => (t += 3600);
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
});
afterEach(() => repo.cleanup());

describe("hotspots", () => {
  it("ranks a file with fix commits above one with the same churn and none", async () => {
    const rows = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }));
    const paths = rows.map((r) => r.path);
    expect(paths[0]).toBe("src/util.ts");
    expect(paths.indexOf("src/util.ts")).toBeLessThan(paths.indexOf("src/calm.ts"));
    const util = rows[0]!;
    expect(util).toMatchObject({ rank: 1, commits: 3, fixCommits: 2, authors: 2, transitiveDependents: 1, critical: false, blocked: false });
    expect(rows.every((r, i) => i === 0 || rows[i - 1]!.score >= r.score)).toBe(true);
  });

  it("excludes paths.ignore matches and respects top", async () => {
    const all = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }));
    expect(all.map((r) => r.path)).not.toContain("dist/bundle.js");
    expect(all).toHaveLength(3);
    const two = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] } }), 2);
    expect(two.map((r) => r.rank)).toEqual([1, 2]);
    expect(two.map((r) => r.path)).toEqual(all.slice(0, 2).map((r) => r.path));
  });

  it("only counts commits inside the lookback window", async () => {
    const rows = await hotspots(repo.dir, parseConfig({ paths: { ignore: ["dist/**"] }, history: { lookbackDays: 1 } }));
    expect(rows.find((r) => r.path === "src/util.ts")).toMatchObject({ commits: 0, fixCommits: 0 });
  });
});

describe("hotspotsCommand", () => {
  function io(): CliIo & { lines: string[] } {
    const lines: string[] = [];
    return { cwd: repo.dir, env: {}, lines, out: (l) => lines.push(l), err: () => {}, progress: () => {} };
  }

  it("prints a table with --top rows and JSON with --json", async () => {
    const table = io();
    expect(await hotspotsCommand.run(["--top", "1"], table)).toBe(0);
    const lines = table.lines.join("\n").split("\n");
    expect(lines[0]).toMatch(/^rank\s+score\s+file\s+fixes\s+commits\s+authors\s+dependents\s+flags$/);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("src/util.ts");

    const json = io();
    await hotspotsCommand.run(["--json", "--top", "2"], json);
    const rows = JSON.parse(json.lines.join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows[0].path).toBe("src/util.ts");
  });

  it("rejects a bad --top", async () => {
    await expect(hotspotsCommand.run(["--top", "0"], io())).rejects.toThrow(/--top/);
  });
});
