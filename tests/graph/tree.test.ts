import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listTree } from "../../src/graph/tree.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe("listTree", () => {
  it("lists the whole tree even when run from a subdirectory", async () => {
    repo = makeRepo();
    repo.commit({ "top.ts": "t\n", "src/a.ts": "a\n", "src/deep/b.ts": "b\n" }, "init");
    const tree = repo.git("rev-parse", "HEAD^{tree}");
    const paths = (await listTree(join(repo.dir, "src"), tree)).map((e) => e.path).sort();
    expect(paths).toEqual(["src/a.ts", "src/deep/b.ts", "top.ts"]);
  });
});
