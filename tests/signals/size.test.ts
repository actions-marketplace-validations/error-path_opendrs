import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_TREE } from "../../src/git/diff.js";
import { sizeSignals } from "../../src/signals/size.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { byId, contextFor } from "./context.js";

const ten = Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("sizeSignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("emits exactly the size ids", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, "HEAD"));
    expect(signals.map((s) => s.id)).toEqual(["size.churn", "size.relative", "size.new_files_only"]);
  });

  it("measures churn and relative size, excluding ignored files", async () => {
    repo = makeRepo();
    repo.commit({ "src/a.ts": ten, "package-lock.json": "{}\n" }, "init");
    repo.commit(
      { "src/a.ts": ten.replace("line 3", "LINE 3"), "src/new.ts": "x\ny\nz\n", "package-lock.json": "{\n  \"a\": 1\n}\n" },
      "change",
    );
    const signals = await sizeSignals(await contextFor(repo, "HEAD~1"));

    const churn = byId(signals, "size.churn");
    expect(churn.value).toBeCloseTo(Math.log1p(2 + 3));
    expect(churn.status).toBe("observed");
    expect(churn.summary).toBe("5 lines changed across 2 files (1 new); 1 ignored");
    expect(churn.evidence.map((e) => e.file)).toEqual(["src/new.ts", "src/a.ts"]);

    const relative = byId(signals, "size.relative");
    expect(relative.value).toBeCloseTo(Math.log1p(2 / 10));
    expect(relative.status).toBe("derived");

    expect(byId(signals, "size.new_files_only")).toMatchObject({ value: 0, status: "observed" });
  });

  it("flags a diff of only new files", async () => {
    repo = makeRepo();
    const first = repo.commit({ "a.ts": "a\n", "b/c.ts": "c\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, EMPTY_TREE, first));
    expect(byId(signals, "size.new_files_only").value).toBe(1);
    expect(byId(signals, "size.relative")).toMatchObject({ value: 0, status: "derived" });
  });

  it("handles an empty diff", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    const signals = await sizeSignals(await contextFor(repo, "HEAD"));
    expect(signals.map((s) => [s.id, s.value])).toEqual([
      ["size.churn", 0],
      ["size.relative", 0],
      ["size.new_files_only", 0],
    ]);
  });

  it("handles a binary-only diff", async () => {
    repo = makeRepo();
    repo.commit({ "img.bin": "\u0000\u0001" }, "init");
    repo.commit({ "img.bin": "\u0000\u0002" }, "change");
    const signals = await sizeSignals(await contextFor(repo, "HEAD~1"));
    expect(byId(signals, "size.churn").value).toBe(0);
    expect(byId(signals, "size.relative").value).toBe(0);
  });

  it("reports relative size as unknown when base contents cannot be read", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": ten }, "init");
    repo.commit({ "a.ts": ten + "more\n" }, "change");
    const ctx = await contextFor(repo, "HEAD~1");
    ctx.readBase = async () => undefined;
    const relative = byId(await sizeSignals(ctx), "size.relative");
    expect(relative).toMatchObject({ value: 0, status: "unknown" });
    expect(relative.summary).toMatch(/could not read/i);
  });
});
