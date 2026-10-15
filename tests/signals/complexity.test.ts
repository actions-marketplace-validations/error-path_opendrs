import { afterEach, describe, expect, it } from "vitest";
import { complexitySignals } from "../../src/signals/complexity.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";
import { contextFor } from "./context.js";

const code = [
  "function f(a, b) {",
  "  if (a && b) return 1;", // if, &&
  "  for (const x of a) {}", // for
  "  while (b || a) {}", // while, ||
  "  try { g(); } catch (e) {}", // catch
  "  switch (a) { case 1: break; }", // case
  "  const iffy = notif;", // no match
  "}",
].join("\n");

describe("complexitySignals", () => {
  let repo: TestRepo;
  afterEach(() => repo?.cleanup());

  it("counts branch keywords in the changed code files", async () => {
    repo = makeRepo();
    repo.commit({ "src/a.ts": code + "\n", "README.md": "if for while\n", "gone.py": "if x:\n    pass\n" }, "init");
    repo.commit({ "src/a.ts": code + "\n// tweak\n", "README.md": "if for while if\n", "gone.py": null }, "change");
    const signals = await complexitySignals(await contextFor(repo, "HEAD~1"));
    expect(signals.map((s) => s.id)).toEqual(["complexity.touched"]);
    const s = signals[0]!;
    // 7 in src/a.ts at head, 1 in gone.py at base; README.md is not code.
    expect(s.value).toBeCloseTo(Math.log1p(8));
    expect(s.status).toBe("derived");
    expect(s.evidence).toEqual([
      { file: "src/a.ts", detail: "7 branch keywords" },
      { file: "gone.py", detail: "1 branch keyword" },
    ]);
  });

  it("is 0 when no code file changed", async () => {
    repo = makeRepo();
    repo.commit({ "README.md": "a\n" }, "init");
    repo.commit({ "README.md": "if\n" }, "change");
    const [s] = await complexitySignals(await contextFor(repo, "HEAD~1"));
    expect(s).toMatchObject({ value: 0, status: "derived" });
  });

  it("is unknown when no changed code file can be read", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "a\n" }, "init");
    repo.commit({ "a.ts": "if\n" }, "change");
    const ctx = await contextFor(repo, "HEAD~1");
    ctx.readHead = async () => undefined;
    const [s] = await complexitySignals(ctx);
    expect(s).toMatchObject({ value: 0, status: "unknown" });
  });
});
