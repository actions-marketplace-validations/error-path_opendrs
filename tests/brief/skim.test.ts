import { describe, expect, it } from "vitest";
import { skimList } from "../../src/brief/skim.js";
import { defaultConfig } from "../../src/domain/config.js";
import { makeContext } from "../../src/engine.js";
import { loadDiff } from "../../src/git/diff.js";
import { makeRepo } from "../helpers/repo.js";
import { fakeHistory } from "../policy/fakes.js";

async function ctxFor(before: Record<string, string>, after: Record<string, string>) {
  const repo = makeRepo();
  repo.commit(before, "base");
  repo.commit(after, "change");
  const config = defaultConfig();
  config.paths.ignore.push("pkg-lock.json");
  const diff = await loadDiff(repo.dir, "HEAD~1", "HEAD", config);
  return { repo, ctx: makeContext(repo.dir, diff, config, fakeHistory([]), undefined) };
}

describe("skimList", () => {
  it("lists docs and comment-only files, but not a file with a code change", async () => {
    const { repo, ctx } = await ctxFor(
      { "README.md": "# old\n", "a.ts": "// comment\nconst x = 1;\n", "b.ts": "const y = 1;\n" },
      { "README.md": "# updated\n", "a.ts": "// updated comment\nconst x = 1;\n", "b.ts": "const y = 2;\n" },
    );
    expect(skimList(ctx)).toEqual([
      { file: "README.md", category: "docs" },
      { file: "a.ts", category: "comment-only" },
    ]);
    repo.cleanup();
  });

  it("lists a .patch/.diff file as docs, like other records, not code", async () => {
    const { repo, ctx } = await ctxFor(
      { "archive/old.patch": "diff --git a/x b/x\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+older\n" },
      { "archive/old.patch": "diff --git a/x b/x\n--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" },
    );
    expect(skimList(ctx)).toEqual([{ file: "archive/old.patch", category: "docs" }]);
    repo.cleanup();
  });

  it("never lists an ignored file: it needs a human regardless (spec §5.7, unread-files), not a skim", async () => {
    const { repo, ctx } = await ctxFor({ "pkg-lock.json": '{"v":1}\n' }, { "pkg-lock.json": '{"v":2}\n' });
    expect(skimList(ctx)).toEqual([]);
    repo.cleanup();
  });

  it("lists a test file as safe only when the PR deletes no tests", async () => {
    const two = "it('x', () => {});\nit('y', () => {});\n";
    const added = await ctxFor({ "test/a.test.ts": two }, { "test/a.test.ts": `${two}it('z', () => {});\n` });
    expect(skimList(added.ctx)).toEqual([{ file: "test/a.test.ts", category: "tests" }]);
    added.repo.cleanup();

    const deleted = await ctxFor({ "test/a.test.ts": `${two}it('z', () => {});\n` }, { "test/a.test.ts": two });
    expect(skimList(deleted.ctx)).toEqual([]);
    deleted.repo.cleanup();
  });

  it("collapses to counts beyond 20 paths", async () => {
    const before: Record<string, string> = {};
    const after: Record<string, string> = {};
    for (let i = 0; i < 25; i++) {
      before[`docs/${i}.md`] = "# v0\n";
      after[`docs/${i}.md`] = `# v${i + 1}\n`;
    }
    const { repo, ctx } = await ctxFor(before, after);
    expect(skimList(ctx)).toEqual({ counts: { docs: 25 } });
    repo.cleanup();
  });
});
