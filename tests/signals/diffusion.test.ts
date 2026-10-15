import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TREE } from "../../src/git/diff.js";
import { diffusionSignals } from "../../src/signals/diffusion.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { byId, contextFor } from "./context.js";

const ALICE = { name: "Alice", email: "alice@example.com" };
const BOB = { name: "Bob", email: "bob@example.com" };
const CAROL = { name: "Carol", email: "carol@example.com" };
const T = 1_700_000_000;

describe("diffusionSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("counts files, top-2-level directories and distinct historical authors", async () => {
    repo = makeRepo();
    repo.commit({ "src/a/x.ts": "1\n", "src/b/z.ts": "1\n", "README.md": "r\n" }, "init", ALICE, T + 100);
    repo.commit({ "src/a/x.ts": "2\n" }, "edit", BOB, T + 200);
    repo.commit({ "src/b/z.ts": "2\n" }, "edit", CAROL, T + 300);
    repo.commit({ "src/a/x.ts": "3\n" }, "edit", BOB, T + 400);
    repo.commit(
      { "src/a/x.ts": "4\n", "src/a/deep/y.ts": "y\n", "src/b/z.ts": "3\n", "README.md": "R\n", "yarn.lock": "l\n" },
      "wide change",
      ALICE,
      T + 500,
    );
    const signals = await diffusionSignals(await contextFor(repo, "HEAD~1"));
    expect(signals.map((s) => s.id)).toEqual(["diffusion.files", "diffusion.dirs", "diffusion.authors"]);

    expect(byId(signals, "diffusion.files")).toMatchObject({ value: Math.log1p(4), status: "observed" });
    const dirs = byId(signals, "diffusion.dirs");
    expect(dirs).toMatchObject({ value: Math.log1p(3), status: "observed" });
    expect(dirs.summary).toContain("src/a");
    const authors = byId(signals, "diffusion.authors");
    expect(authors).toMatchObject({ value: Math.log1p(3), status: "derived" });
    expect(authors.evidence[0]).toMatchObject({ file: "src/a/x.ts" });
  });

  it("only counts authors before asOf and follows renames to the old path", async () => {
    repo = makeRepo();
    const body = "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n";
    repo.commit({ "old.ts": body }, "init", ALICE, T + 100);
    repo.commit({ "old.ts": body + "// x\n" }, "edit", BOB, T + 200);
    repo.commit({ "old.ts": null, "new.ts": body + "// x\n" }, "move", CAROL, T + 300);
    const all = await diffusionSignals(await contextFor(repo, "HEAD~1"));
    expect(byId(all, "diffusion.authors").value).toBeCloseTo(Math.log1p(2));
    const early = await diffusionSignals(await contextFor(repo, "HEAD~1", "HEAD", { asOf: T + 150 }));
    expect(byId(early, "diffusion.authors").value).toBeCloseTo(Math.log1p(1));
  });

  it("is unknown for authors when there is no prior history", async () => {
    repo = makeRepo();
    const first = repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await diffusionSignals(await contextFor(repo, EMPTY_TREE, first));
    expect(byId(signals, "diffusion.files").value).toBeCloseTo(Math.log1p(1));
    expect(byId(signals, "diffusion.authors")).toMatchObject({ value: 0, status: "unknown" });
  });

  it("handles an empty diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await diffusionSignals(await contextFor(repo, "HEAD"));
    expect(signals.map((s) => s.value)).toEqual([0, 0, 0]);
  });

  it("reports diffusion.authors as unknown in a shallow clone, keeping the count as a lower bound", async () => {
    repo = makeRepo();
    repo.commit({ "src/a.ts": "1\n" }, "init", ALICE, T + 100);
    repo.commit({ "src/a.ts": "2\n" }, "edit", BOB, T + 200);
    repo.commit({ "src/a.ts": "3\n" }, "change", CAROL, T + 300);
    const ctx = await contextFor(repo, "HEAD~1");
    const signals = await diffusionSignals({ ...ctx, trust: { authorVerified: true, historyComplete: false } });
    const authors = byId(signals, "diffusion.authors");
    expect(authors).toMatchObject({ status: "unknown", value: Math.log1p(2) });
    expect(authors.summary).toContain("shallow clone: history incomplete");
    expect(byId(signals, "diffusion.files").status).toBe("observed");
  });
});
