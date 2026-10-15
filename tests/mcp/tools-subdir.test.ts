import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scoreDiffTool } from "../../src/mcp/tools.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

const json = (r: { content: Array<{ type: string; text?: string }> }) => JSON.parse(r.content[0]!.text!);

describe("MCP tools with a subdirectory repoDir", () => {
  it("score_diff resolves the repository root: same config, same graph, same score", async () => {
    repo = makeRepo();
    const files: Record<string, string> = {
      ".opendrs.yml": "paths:\n  critical: ['src/**']\n",
      "src/core.ts": "export const f = 1;\n",
    };
    for (let i = 0; i < 10; i++) files[`src/m${i}.ts`] = `import { f } from "./core";\nexport const v = f;\n`;
    repo.commit(files, "init");
    repo.git("checkout", "-q", "-b", "pr");
    repo.commit({ "src/core.ts": "export const f = 2;\n" }, "change core");

    const root = json(await scoreDiffTool({ repoDir: repo.dir, base: "main" }));
    const sub = json(await scoreDiffTool({ repoDir: join(repo.dir, "src"), base: "main" }));
    expect(root.contributions.map((c: { id: string }) => c.id)).toContain("paths.critical");
    expect(sub.score).toBe(root.score);
    expect(sub.contributions).toEqual(root.contributions);
  }, 60_000);
});
