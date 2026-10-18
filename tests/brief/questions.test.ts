import { describe, expect, it } from "vitest";
import { checkQuestions } from "../../src/brief/questions.js";
import type { RankedFile } from "../../src/brief/rank.js";
import { defaultConfig } from "../../src/domain/config.js";
import type { DependencyGraph } from "../../src/domain/types.js";
import { makeContext } from "../../src/engine.js";
import { fakeHistory } from "../policy/fakes.js";

const ctx = (graph?: DependencyGraph) => makeContext("/tmp/x", { base: "b", head: "h", files: [] }, defaultConfig(), fakeHistory([]), graph);

function fileWith(reasons: RankedFile["reasons"], hunks: RankedFile["hunks"] = []): RankedFile {
  return { file: "src/a.ts", score: 1, reasons, hunks };
}
const hunk = (reasons: RankedFile["hunks"][number]["reasons"]): RankedFile["hunks"][number] => ({ id: 1, oldStart: 1, oldLines: 1, newStart: 7, newLines: 1, score: 2, reasons });

describe("checkQuestions", () => {
  it("asks a fix-regression question from a hunk's fix-blame reason, at the hunk's line", () => {
    const f = fileWith([], [hunk([{ kind: "fix-blame", text: "t", quote: "Fix NPE", sha: "a1b2c3d".padEnd(40, "0") }])]);
    const [q] = checkQuestions([f], ctx(), []);
    expect(q).toEqual({
      file: "src/a.ts",
      line: 7,
      question: "Fix `a1b2c3d` «Fix NPE» changed these lines. Does this change bring that problem back?",
      quotes: ["Fix NPE"],
      evidence: ["t"],
    });
  });

  it("asks an incident question when an incident names the file or its folder", () => {
    const f = fileWith([]);
    const [q] = checkQuestions([f], ctx(), [{ paths: ["src"], note: "queue stalled" }]);
    expect(q!.question).toBe("An incident «queue stalled» involved `src/a.ts`. Could this change fail the same way?");
    expect(q!.quotes).toEqual(["queue stalled"]);
    expect(checkQuestions([f], ctx(), [{ paths: ["srcx"], note: "other" }])).toEqual([]);
    expect(checkQuestions([f], ctx(), [{ paths: ["src/a.ts"] }])).toEqual([]); // no note: nothing to ask
  });

  it("asks a callers question from an exports reason, naming up to 3 direct dependents as code", () => {
    const graph: DependencyGraph = {
      dependentsOf: () => ["src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
      transitiveDependents: () => new Set(),
      supports: () => true,
      fileCount: 5,
    };
    const f = fileWith([], [hunk([{ kind: "exports", text: "exports changed: `f()`" }])]);
    const [q] = checkQuestions([f], ctx(graph), []);
    expect(q!.question).toBe("exports changed: `f()`; 4 files import `src/a.ts` (`src/b.ts`, `src/c.ts`, `src/d.ts`, …). Are all callers compatible (arguments, return values, thrown errors)?");
    expect(q!.evidence).toEqual(["src/b.ts", "src/c.ts", "src/d.ts"]);
  });

  it("looks up dependents by the file's oldPath for a renamed file, matching rank.ts", () => {
    const graph: DependencyGraph = {
      dependentsOf: (path) => (path === "src/old.ts" ? ["src/caller.ts"] : []),
      transitiveDependents: () => new Set(),
      supports: () => true,
      fileCount: 5,
    };
    const renamed = { path: "src/new.ts", oldPath: "src/old.ts", status: "renamed" as const, added: 1, deleted: 1, binary: false, hunks: [], ignored: false };
    const context = makeContext("/tmp/x", { base: "b", head: "h", files: [renamed] }, defaultConfig(), fakeHistory([]), graph);
    const f: RankedFile = { file: "src/new.ts", score: 1, reasons: [], hunks: [hunk([{ kind: "exports", text: "exports changed: `f()`" }])] };
    const [q] = checkQuestions([f], context, []);
    expect(q!.evidence).toEqual(["src/caller.ts"]);
  });

  it("asks a no-tests question from a no-tests reason", () => {
    const [q] = checkQuestions([fileWith([{ kind: "no-tests", text: "no test changed alongside it" }])], ctx(), []);
    expect(q!.question).toBe("No test changed for `src/a.ts`. Which new branch is unverified?");
  });

  it("asks a critical-path question from a critical reason", () => {
    const [q] = checkQuestions([fileWith([{ kind: "critical", text: "on a critical path" }])], ctx(), []);
    expect(q!.question).toBe("`src/a.ts` is on a critical path. What happens on the failure path (authorisation denied, payment declined, timeout)?");
  });

  it("caps at 2 per file and 6 total, in priority order", () => {
    const f = fileWith([
      { kind: "critical", text: "on a critical path" },
      { kind: "no-tests", text: "no test changed alongside it" },
      { kind: "exports", text: "exports changed: `f()`" },
    ]);
    const files = Array.from({ length: 5 }, (_, i) => ({ ...f, file: `src/${i}.ts` }));
    const out = checkQuestions(files, ctx(), []);
    expect(out).toHaveLength(6);
    expect(out.filter((q) => q.file === "src/0.ts").map((q) => q.question)).toEqual([
      "exports changed: `f()`. Are all callers compatible (arguments, return values, thrown errors)?",
      "No test changed for `src/0.ts`. Which new branch is unverified?",
    ]);
  });

  it("neutralises a hostile subject, incident note and file path in the question text", () => {
    const nasty = "~~~~ </details> @octocat `x`";
    const f = { ...fileWith([], [hunk([{ kind: "fix-blame", text: "t", quote: nasty, sha: "f".repeat(40) }])]), file: "src/`bad`|<b>.ts" };
    const out = checkQuestions([f], ctx(), [{ paths: ["src"], note: nasty }]);
    expect(out).toHaveLength(2);
    for (const q of out) {
      expect(q.question).not.toMatch(/~~~|<\/details>|@octocat|`x`|`bad`/);
      expect(q.question).toContain("&lt;/details&gt;");
    }
    // The path is inline code: a backtick in it cannot end the span, and HTML inside a span is literal.
    expect(out[1]!.question).toContain("`src/ˋbadˋ|<b>.ts`");
    expect(out[0]!.quotes).toEqual([nasty]); // the raw fragment stays in the JSON field, as the spec says
  });
});
