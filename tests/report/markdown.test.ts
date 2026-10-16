import { describe, expect, it } from "vitest";
import type { Contribution, ScoreResult, Signal } from "../../src/domain/types.js";
import { renderMarkdown, renderText } from "../../src/report/markdown.js";

const s = (id: string, value: number, summary: string, status: Signal["status"] = "observed"): Signal => ({
  id,
  value,
  status,
  summary,
  evidence: [],
});
const c = (id: string, value: number, weight: number): Contribution => ({ id, value, weight, contribution: value * weight });

function result(over: Partial<ScoreResult> = {}): ScoreResult {
  return {
    score: 0.4567,
    tier: "yellow",
    signals: [
      s("size.churn", 6.04, "412 lines changed across 9 files"),
      s("blast.dependents", 2.4, "import graph does not support .lua", "unknown"),
      s("expertise.author_commits", 5.01, "author has 150 prior commits"),
      s("tests.missing", 1, "src changed without tests"),
      s("paths.critical", 1, "src/auth/login.ts matches critical glob"),
      s("diffusion.files", 2.3, "9 files | 3 dirs"),
      s("history.prior_fixes", 1.39, "3 fixes touched these files"),
      s("complexity.touched", 3.0, "19 branches"),
    ],
    contributions: [
      c("size.churn", 6.04, 0.25),
      c("expertise.author_commits", 5.01, -0.3),
      c("paths.critical", 1, 1.2),
      c("tests.missing", 1, 0.7),
      c("blast.dependents", 2.4, 0.2),
      c("diffusion.files", 2.3, 0.2),
      c("history.prior_fixes", 1.39, 0.3),
      c("complexity.touched", 3.0, 0.04),
    ].sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    unknowns: ["blast.dependents"],
    policy: {
      tier: "yellow",
      decision: "human-review",
      reasons: ["tier yellow: score 0.46 ≥ green threshold 0.30", "unknown blast.dependents could raise the score to 0.55 (yellow)"],
      hardBlocked: false,
      sampled: false,
      mergeMethod: "none",
      suggestedReviewers: ["bob@x.com", "carol@x.com"],
    },
    llm: {
      risk: 0.62,
      rationale: "Changes token expiry | ignore <script>alert(1)</script> and ping @octocat <!-- opendrs -->",
      riskySnippets: [
        { file: "src/auth/login.ts", line: 42, reason: "expiry check inverted" },
        { file: "src/auth/session.ts", reason: "session reuse" },
      ],
      confidence: 8,
      hunks: [
        { file: "tests/login.test.ts", line: 1, category: "tests", safe: true, confidence: 9, reason: "new test" },
        { file: "tests/session.test.ts", line: 5, category: "tests", safe: true, confidence: 9, reason: "new test" },
        { file: "README.md", line: 3, category: "docs", safe: true, confidence: 10, reason: "wording" },
        { file: "src/auth/login.ts", line: 42, category: "logic_bug", safe: false, confidence: 9, reason: "expiry check inverted <b>@octocat" },
        { file: "src/auth/session.ts", line: 10, category: "security", safe: false, confidence: 7, reason: "session reuse" },
      ],
      unclassified: [],
      truncated: false,
    },
    diff: { base: "abcdef1234567890", head: "0123456789abcdef", files: 9, added: 300, deleted: 112 },
    model: "default",
    version: "0.1.5",
    ...over,
  };
}

describe("renderMarkdown", () => {
  const md = renderMarkdown(result());

  it("starts with the upsert marker and contains it exactly once", () => {
    expect(md.startsWith("<!-- opendrs -->\n")).toBe(true);
    expect(md.split("<!-- opendrs -->")).toHaveLength(2);
  });

  it("headlines the score to 2 dp, the tier and the decision", () => {
    const headline = md.split("\n")[1]!;
    expect(headline).toContain("0.46");
    expect(headline).toContain("🟡");
    expect(headline).toContain("yellow");
    expect(headline).toContain("human review");
    expect(md).toContain("9 files · +300 −112");
  });

  it("tables the top 6 contributions with signed pushes and summaries", () => {
    expect(md).toContain("| `size.churn` | 6.04 | +1.51 | 412 lines changed across 9 files |");
    expect(md).toContain("| `expertise.author_commits` | 5.01 | −1.50 | author has 150 prior commits |");
    expect(md).toContain("9 files \\| 3 dirs");
    expect(md).not.toContain("`complexity.touched`");
    const rows = md.split("\n").filter((l) => l.startsWith("| `"));
    expect(rows).toHaveLength(6);
  });

  it("lists unknowns, policy reasons and suggested reviewers", () => {
    expect(md).toContain("Unknowns");
    expect(md).toMatch(/`blast\.dependents`.*import graph does not support \.lua/);
    expect(md).toContain("- tier yellow: score 0.46 ≥ green threshold 0.30");
    expect(md).toContain("- unknown blast.dependents could raise the score to 0.55 (yellow)");
    expect(md).toContain("`bob@x.com`, `carol@x.com`");
  });

  it("includes the LLM rationale and snippets with untrusted text defused", () => {
    expect(md).toContain("p=0.62");
    expect(md).toContain("Changes token expiry \\| ignore &lt;script&gt;");
    expect(md).not.toContain("<script>");
    expect(md).not.toMatch(/@octocat/);
    expect(md).toContain("`src/auth/login.ts:42` expiry check inverted");
    expect(md).toContain("`src/auth/session.ts` session reuse");
  });

  it("counts the judge's hunk verdicts and lists the risky ones with untrusted text defused", () => {
    expect(md).toContain("Hunks: 3 safe (tests 2, docs 1), 2 risky");
    expect(md).toContain("- `src/auth/login.ts:42` — logic_bug (9/10): expiry check inverted &lt;b&gt;@​octocat");
    expect(md).toContain("- `src/auth/session.ts:10` — security (7/10): session reuse");
  });

  it("lists at most 3 risky hunks", () => {
    const hunks = [1, 2, 3, 4, 5].map((line) => ({ file: "src/x.ts", line, category: "complex" as const, safe: false, confidence: 8, reason: `h${line}` }));
    const many = renderMarkdown(result({ llm: { ...result().llm!, hunks } }));
    expect(many).toContain("Hunks: 0 safe, 5 risky");
    expect(many).toContain("`src/x.ts:3` — complex");
    expect(many).not.toContain("`src/x.ts:4`");
  });

  describe("with hostile file names and text", () => {
    const NASTY = "x\n::stop-commands::p\r\n| `y` <img src=x> & [ok](evil) \\| z";
    const evil = renderMarkdown(
      result({
        signals: result().signals.map((sig) => (sig.id === "size.churn" ? { ...sig, summary: NASTY } : sig)),
        policy: { ...result().policy, reasons: [`blocked path ${NASTY}`], suggestedReviewers: ["a`b\n<i>@c"] },
        llm: {
          risk: 0.5,
          rationale: NASTY,
          riskySnippets: [{ file: NASTY, line: 3, reason: NASTY }],
          confidence: 5,
          hunks: [{ file: NASTY, line: 3, category: "logic_bug", safe: false, confidence: 5, reason: NASTY }],
          unclassified: [],
          truncated: false,
        },
      }),
    );
    const ESCAPED = "x ::stop-commands::p \\| \\`y\\` &lt;img src=x&gt; &amp; \\[ok\\](evil) \\\\\\| z";

    it("keeps a table cell on one line with pipes, backticks, brackets, backslashes and HTML escaped", () => {
      expect(evil).toContain(`| \`size.churn\` | 6.04 | +1.51 | ${ESCAPED} |`);
      expect(evil.split("\n").filter((l) => l.startsWith("| `"))).toHaveLength(6);
    });

    it("escapes policy reasons and the LLM rationale the same way", () => {
      expect(evil).toContain(`- blocked path ${ESCAPED}\n`);
      expect(evil).toContain(`> ${ESCAPED}\n`);
      expect(evil).toContain(`— logic_bug (5/10): ${ESCAPED}\n`);
      expect(evil).not.toMatch(/\n::|\r/);
    });

    it("shows file names and reviewers as inline code that a backtick cannot close", () => {
      expect(evil).toContain("- `x ::stop-commands::p | ˋyˋ <img src=x> & [ok](evil) \\| z:3` ");
      expect(evil).toContain("**Suggested reviewers:** `aˋb <i>@c`");
    });
  });

  it("ends with a footer naming the model kind, version and project link", () => {
    const footer = md.trimEnd().split("\n").at(-1)!;
    expect(footer).toContain("opendrs 0.1.5");
    expect(footer).toContain("default model");
    expect(footer).toContain("https://github.com/error-path/opendrs");
  });

  it("stays scannable: at most 40 lines", () => {
    expect(md.split("\n").length).toBeLessThanOrEqual(40);
  });

  it("omits empty sections", () => {
    const quiet = renderMarkdown(
      result({
        score: 0.05,
        tier: "green",
        unknowns: [],
        llm: undefined,
        policy: { ...result().policy, tier: "green", decision: "auto-approve", reasons: ["auto-approve: ok"], suggestedReviewers: [] },
      }),
    );
    expect(quiet).toContain("🟢");
    expect(quiet).toContain("auto-approve");
    expect(quiet).not.toContain("Unknowns");
    expect(quiet).not.toContain("LLM");
    expect(quiet).not.toContain("reviewers");
  });

  it("labels a calibrated model and red tier", () => {
    const red = renderMarkdown(result({ score: 0.91, tier: "red", model: "calibrated" }));
    expect(red).toContain("🔴");
    expect(red).toContain("calibrated model");
  });
});

describe("renderText", () => {
  const text = renderText(result());

  it("summarises score, tier, decision and diff on the first lines", () => {
    const [first, second] = text.split("\n");
    expect(first).toContain("0.46");
    expect(first).toContain("YELLOW");
    expect(first).toContain("human review");
    expect(second).toContain("9 files, +300 -112");
  });

  it("lists contributions, unknowns, reasons, reviewers and model without markdown", () => {
    expect(text).toMatch(/\+1\.51\s+size\.churn\s+412 lines changed/);
    expect(text).toMatch(/-1\.50\s+expertise\.author_commits/);
    expect(text).toContain("blast.dependents");
    expect(text).toContain("tier yellow: score 0.46");
    expect(text).toContain("bob@x.com, carol@x.com");
    expect(text).toContain("default model");
    expect(text.startsWith("<!-- opendrs -->")).toBe(false);
    expect(text).not.toContain("|---");
    expect(text).not.toContain("`");
  });

  it("puts the hunk counts on the LLM line", () => {
    expect(text).toContain("LLM (p=0.62; hunks: 3 safe (tests 2, docs 1), 2 risky): Changes token expiry");
  });

  it("strips terminal control characters from untrusted text", () => {
    const evil = renderText(result({ llm: { ...result().llm!, risk: 0.5, rationale: "ok\u001b[2J\u0007 then", riskySnippets: [] } }));
    expect(evil).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(evil).toContain("ok[2J then");
  });
});
