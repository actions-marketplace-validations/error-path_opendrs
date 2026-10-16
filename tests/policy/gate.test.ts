import { describe, expect, it, vi } from "vitest";
import { parseConfig } from "../../src/domain/config.js";
import type { ChangedFile, LlmHunkVerdict, LlmJudgement, ModelWeights, Signal } from "../../src/domain/types.js";
import { DEFAULT_WEIGHTS } from "../../src/model/defaults.js";
import { decide, sampleValue, type GateInput } from "../../src/policy/gate.js";
import { fakeCommit, fakeHistory } from "./fakes.js";

const logit = (p: number) => Math.log(p / (1 - p));

const file = (path: string, added = 10, deleted = 5, ignored = false): ChangedFile => ({
  path,
  status: "modified",
  added,
  deleted,
  binary: false,
  hunks: [],
  ignored,
});

const unknown = (id: string, value: number): Signal => ({ id, value, status: "unknown", summary: `${id} unknown`, evidence: [] });

const history = fakeHistory([
  fakeCommit("bob@x.com", ["src/a.ts"], 3),
  fakeCommit("me@x.com", ["src/a.ts"], 2),
  fakeCommit("carol@x.com", ["src/a.ts"], 400),
]);

/** A PR that passes every rule unless a test overrides something. Sampling off by default. */
function input(over: Partial<GateInput> & { cfg?: Record<string, unknown>; files?: ChangedFile[] } = {}): GateInput {
  const { cfg, files, ...rest } = over;
  const score = rest.score ?? 0.1;
  return {
    score,
    logit: logit(score),
    signals: [],
    contributions: [],
    diff: { base: "base", head: "head", files: files ?? [file("src/a.ts")], author: { name: "Me", email: "me@x.com" } },
    config: parseConfig({ autoApprove: { sampleRate: 0 }, ...cfg }),
    model: DEFAULT_WEIGHTS,
    history,
    llmFailed: false,
    ...rest,
  };
}

describe("decide: rule 7 (auto-approve)", () => {
  it("auto-approves a green, unblocked, small PR with the configured merge method", () => {
    const out = decide(input());
    expect(out).toMatchObject({ tier: "green", decision: "auto-approve", hardBlocked: false, sampled: false, mergeMethod: "queue" });
    expect(out.reasons[0]).toMatch(/auto-approve/);
  });

  it("stays informational when autoApprove.enabled=false (dry run line)", () => {
    expect(decide(input()).reasons).toContain("dry run: autoApprove.enabled=false");
    expect(decide(input({ cfg: { autoApprove: { enabled: true, sampleRate: 0 } } })).reasons).not.toContain(
      "dry run: autoApprove.enabled=false",
    );
  });

  it("suggests recent authors of the changed files, excluding the PR author", () => {
    expect(decide(input()).suggestedReviewers).toEqual(["bob@x.com", "carol@x.com"]);
  });
});

describe("decide: rule 1 (hard block)", () => {
  it("routes a paths.block glob hit to human review, even for ignored files", () => {
    const out = decide(input({ files: [file("src/a.ts"), file(".github/workflows/ci.yml", 1, 0, true)] }));
    expect(out).toMatchObject({ decision: "human-review", hardBlocked: true, mergeMethod: "none" });
    expect(out.reasons[0]).toContain(".github/workflows/ci.yml");
  });

  it("also honours a paths.blocked signal", () => {
    const signals: Signal[] = [{ id: "paths.blocked", value: 1, status: "observed", summary: "infra/main.tf is blocked", evidence: [] }];
    const out = decide(input({ signals }));
    expect(out).toMatchObject({ decision: "human-review", hardBlocked: true });
  });

  it("matches paths.block case-insensitively (makefile, EF Core Migrations/)", () => {
    for (const path of ["makefile", "src/Data/Migrations/20240101_Init.cs"]) {
      expect(decide(input({ files: [file(path)] })), path).toMatchObject({ decision: "human-review", hardBlocked: true });
    }
  });

  it("keeps the default blocks when the config sets its own paths.block", () => {
    const out = decide(input({ cfg: { autoApprove: { sampleRate: 0 }, paths: { block: ["infra/**"] } }, files: [file("package.json", 1, 1)] }));
    expect(out).toMatchObject({ decision: "human-review", hardBlocked: true });
  });

  it("routes a net test deletion to human review, whatever the score", () => {
    const signals: Signal[] = [{ id: "tests.deleted", value: 1, status: "observed", summary: "1 test file deleted", evidence: [] }];
    const out = decide(input({ signals, score: 0.05 }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review", hardBlocked: false });
    expect(out.reasons[0]).toBe("test deletion: 1 test file deleted");
  });

  it("ignores a tests.deleted signal of 0", () => {
    const signals: Signal[] = [{ id: "tests.deleted", value: 0, status: "observed", summary: "no test deletion", evidence: [] }];
    expect(decide(input({ signals })).decision).toBe("auto-approve");
  });

  it("matches the old path of a rename", () => {
    const renamed: ChangedFile = { ...file("src/moved.sql"), status: "renamed", oldPath: "db/migrations/001.sql" };
    expect(decide(input({ files: [renamed] })).hardBlocked).toBe(true);
  });

  it("lists every rule that fired, the decisive one first", () => {
    const out = decide(input({ score: 0.9, files: [file(".opendrs.yml", 600, 0)] }));
    expect(out.reasons[0]).toMatch(/block/);
    expect(out.reasons[1]).toMatch(/600 changed lines/);
    expect(out.reasons[2]).toMatch(/red/);
    expect(out.tier).toBe("red");
  });
});

describe("decide: ignored or binary files", () => {
  const binary = (path: string): ChangedFile => ({ ...file(path, 0, 0), binary: true });

  it("never auto-approves a PR that changes an ignored file, but keeps its green tier", () => {
    const out = decide(input({ files: [file("src/a.ts"), file("package-lock.json", 1, 1, true)] }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review", hardBlocked: false, mergeMethod: "none" });
    expect(out.reasons[0]).toMatch(/ignored or binary/);
    expect(out.reasons[0]).toContain("package-lock.json");
  });

  it("never auto-approves a PR that changes a binary file", () => {
    const out = decide(input({ files: [file("src/a.ts"), binary("gradle/wrapper/gradle-wrapper.jar")] }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toContain("gradle/wrapper/gradle-wrapper.jar");
  });

  it("never auto-approves a PR whose paths contain control characters", () => {
    const out = decide(input({ files: [file("src/a.ts"), file("docs/x\n::notice::ok\n.md")] }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toMatch(/control characters/);
  });

  it("never auto-approves a PR that moves a submodule pointer, but keeps its green tier", () => {
    const gitlink: ChangedFile = { ...file("libs/core", 1, 1), submodule: true };
    const out = decide(input({ files: [file("src/a.ts"), gitlink] }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review", hardBlocked: false, mergeMethod: "none" });
    expect(out.reasons[0]).toMatch(/submodule/);
    expect(out.reasons[0]).toContain("libs/core");
  });

  it("names at most 3 such files", () => {
    const files = ["a.lock", "b.lock", "c.lock", "d.lock", "e.lock"].map((p) => file(p, 1, 0, true));
    const reason = decide(input({ files })).reasons[0]!;
    expect(reason).toContain("a.lock, b.lock, c.lock (+2 more)");
    expect(reason).not.toContain("d.lock");
  });

  it("fires right after the hard block", () => {
    const out = decide(input({ score: 0.9, files: [file(".github/x.yml"), file("vendor/x.go", 1, 0, true)] }));
    expect(out.reasons[0]).toMatch(/hard block/);
    expect(out.reasons[1]).toMatch(/ignored or binary.*vendor\/x\.go/);
    expect(out.reasons[2]).toMatch(/red/);
  });
});

describe("decide: content.block", () => {
  const hunk = (newStart: number, lines: string[]) => ({ oldStart: newStart, oldLines: 0, newStart, newLines: 0, lines });
  const withHunks = (path: string, ...hunks: ReturnType<typeof hunk>[]): ChangedFile => ({ ...file(path), hunks });
  const blockCfg = (...block: string[]) => ({ cfg: { autoApprove: { sampleRate: 0 }, content: { block } } });

  it("routes an added line matching a pattern to human review, naming the new-side line", () => {
    const f = withHunks("src/a.ts", hunk(10, [" a", "-eval(old)", "+b", " c"]), hunk(40, [" d", "+e", "+x = eval(y)", " f"]));
    const out = decide(input({ files: [f], ...blockCfg("\\beval\\(") }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review", hardBlocked: false, mergeMethod: "none" });
    expect(out.reasons[0]).toBe("content.block /\\beval\\(/ matched src/a.ts:42");
  });

  it("never matches deleted or context lines", () => {
    const f = withHunks("src/a.ts", hunk(1, [" eval(a)", "-eval(b)", "+ok"]));
    expect(decide(input({ files: [f], ...blockCfg("eval") })).decision).toBe("auto-approve");
  });

  it("does not count a \\ No newline marker as a line", () => {
    const f = withHunks("src/a.ts", hunk(5, ["-old", "\\ No newline at end of file", "+new", "+eval(z)"]));
    expect(decide(input({ files: [f], ...blockCfg("eval") })).reasons[0]).toBe("content.block /eval/ matched src/a.ts:6");
  });

  it("counts an empty row as a context line, as the diff parser does", () => {
    const f = withHunks("src/a.ts", hunk(1, [" a", "", "+eval(z)"]));
    expect(decide(input({ files: [f], ...blockCfg("eval") })).reasons[0]).toBe("content.block /eval/ matched src/a.ts:3");
  });

  it("names at most 3 locations", () => {
    const f = withHunks("src/a.ts", hunk(1, ["+eval", "+eval", " x", "+eval", "+eval", "+eval"]));
    expect(decide(input({ files: [f], ...blockCfg("eval") })).reasons[0]).toBe(
      "content.block /eval/ matched src/a.ts:1, src/a.ts:2, src/a.ts:4 (+2 more)",
    );
  });

  it("gives one reason per matching pattern, in config order", () => {
    const f = withHunks("src/a.ts", hunk(1, ["+eval(x)", "+el.innerHTML = y"]));
    const out = decide(input({ files: [f], ...blockCfg("innerHTML", "nope", "eval") }));
    expect(out.reasons.slice(0, 2)).toEqual(["content.block /innerHTML/ matched src/a.ts:2", "content.block /eval/ matched src/a.ts:1"]);
    expect(out.reasons.join("\n")).not.toContain("nope");
  });

  it("has no effect without patterns", () => {
    const f = withHunks("src/a.ts", hunk(1, ["+eval(x)"]));
    expect(decide(input({ files: [f] })).decision).toBe("auto-approve");
  });

  it("skips binary files", () => {
    const f: ChangedFile = { ...withHunks("img.png", hunk(1, ["+eval"])), binary: true };
    expect(decide(input({ files: [f], ...blockCfg("eval") })).reasons.join("\n")).not.toContain("content.block");
  });

  it("scans ignored files too, after the other never-auto-approve rules", () => {
    const f: ChangedFile = { ...withHunks("vendor/x.go", hunk(1, ["+eval"])), ignored: true };
    const out = decide(input({ files: [f], ...blockCfg("eval") }));
    expect(out.reasons[0]).toMatch(/ignored or binary/);
    expect(out.reasons[1]).toBe("content.block /eval/ matched vendor/x.go:1");
  });
});

describe("decide: rule 2 (size cap)", () => {
  it("routes more than maxChangedLines to human review, not counting ignored files", () => {
    expect(decide(input({ files: [file("src/a.ts", 300, 101)] })).decision).toBe("human-review");
    const out = decide(input({ files: [file("src/a.ts", 300, 100), file("package-lock.json", 5000, 0, true)] }));
    expect(out.reasons.some((r) => /maxChangedLines/.test(r))).toBe(false);
  });

  it("counts a binary file as one changed line", () => {
    const bin: ChangedFile = { ...file("img.png", 0, 0), binary: true };
    const out = decide(input({ files: [file("src/a.ts", 300, 100), bin] }));
    expect(out.reasons).toContain("401 changed lines exceeds autoApprove.maxChangedLines (400)");
  });
});

describe("decide: rule 3 (tier)", () => {
  it("maps absolute thresholds: < green → green, ≥ red → red, else yellow", () => {
    expect(decide(input({ score: 0.29 })).tier).toBe("green");
    expect(decide(input({ score: 0.3 })).tier).toBe("yellow");
    expect(decide(input({ score: 0.79 })).tier).toBe("yellow");
    expect(decide(input({ score: 0.8 })).tier).toBe("red");
  });

  it("routes a non-green tier to human review and says why", () => {
    const out = decide(input({ score: 0.45 }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toMatch(/yellow.*0\.45.*0\.30/);
  });

  it("maps percentile thresholds through the model's history percentiles, interpolating", () => {
    const model: ModelWeights = { ...DEFAULT_WEIGHTS, percentiles: { "50": 0.1, "75": 0.2, "90": 0.4, "95": 0.5, "99": 0.7 } };
    const cfg = { thresholds: { mode: "percentile", green: 60, yellow: 90, red: 95 } };
    expect(decide(input({ cfg, model, score: 0.13 })).tier).toBe("green");
    expect(decide(input({ cfg, model, score: 0.15 })).tier).toBe("yellow");
    expect(decide(input({ cfg, model, score: 0.5 })).tier).toBe("red");
  });

  it("falls back to absolute defaults when the model has no percentiles", () => {
    const out = decide(input({ cfg: { thresholds: { mode: "percentile", green: 50, yellow: 90, red: 95 } }, score: 0.25 }));
    expect(out.tier).toBe("green");
    expect(out.reasons.some((r) => /percentile.*absolute defaults/.test(r))).toBe(true);
  });
});

describe("decide: freezes", () => {
  // Friday 20:00 in UTC, already Saturday 05:00 in Tokyo.
  const now = Date.UTC(2026, 9, 16, 20);
  const freeze = (window: Record<string, unknown>, cfg: Record<string, unknown> = {}) => ({
    cfg: { autoApprove: { sampleRate: 0 }, ...cfg, freezes: [{ name: "x", ...window }] },
    now,
  });

  it("matches the weekday in the window's own timezone", () => {
    expect(decide(input(freeze({ days: ["sat", "sun"] }))).decision).toBe("auto-approve");
    const out = decide(input(freeze({ name: "weekend", timezone: "Asia/Tokyo", days: ["sat", "sun"] })));
    expect(out).toMatchObject({ tier: "green", decision: "human-review", mergeMethod: "none" });
    expect(out.reasons[0]).toBe('freeze "weekend": auto-approval suspended');
  });

  it("treats from and to as inclusive local dates", () => {
    expect(decide(input(freeze({ from: "2026-10-16", to: "2026-10-16" }))).decision).toBe("human-review");
    expect(decide(input(freeze({ to: "2026-10-15" }))).decision).toBe("auto-approve");
    expect(decide(input(freeze({ from: "2026-10-17" }))).decision).toBe("auto-approve");
    expect(decide(input(freeze({ timezone: "Asia/Tokyo", from: "2026-10-17" }))).decision).toBe("human-review");
  });

  it("needs every condition it sets", () => {
    expect(decide(input(freeze({ days: ["fri"], from: "2026-10-17" }))).decision).toBe("auto-approve");
    expect(decide(input(freeze({ days: ["fri"], from: "2026-10-16" }))).decision).toBe("human-review");
  });

  it("with a green of its own, holds the score to that stricter threshold; the tier stays", () => {
    const window = { name: "black-friday", days: ["fri"], green: 0.15 };
    const out = decide(input({ ...freeze(window), score: 0.2 }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review" });
    expect(out.reasons[0]).toBe('freeze "black-friday": score 0.20 ≥ freeze green 0.15');
    expect(decide(input({ ...freeze(window), score: 0.1 })).decision).toBe("auto-approve");
  });

  it("maps a percentile freeze green through the model's percentiles", () => {
    const model: ModelWeights = { ...DEFAULT_WEIGHTS, percentiles: { "50": 0.1, "75": 0.2, "90": 0.4, "95": 0.5, "99": 0.7 } };
    const cfg = { thresholds: { mode: "percentile", green: 60, yellow: 90, red: 95 } };
    const out = decide(input({ ...freeze({ days: ["fri"], green: 50 }, cfg), model, score: 0.12 }));
    expect(out).toMatchObject({ tier: "green", decision: "human-review" });
    expect(out.reasons[0]).toBe('freeze "x": score 0.12 ≥ freeze green 0.10');
    expect(decide(input({ ...freeze({ days: ["fri"], green: 50 }, cfg), model, score: 0.08 })).decision).toBe("auto-approve");
  });

  it("suspends auto-approval when a percentile freeze green cannot be mapped", () => {
    const cfg = { thresholds: { mode: "percentile", green: 50, yellow: 90, red: 95 } };
    const out = decide(input({ ...freeze({ days: ["fri"], green: 25 }, cfg), score: 0.01 }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toBe('freeze "x": percentile green 25 needs a calibrated model; auto-approval suspended');
  });

  it("uses the current time when none is given", () => {
    vi.useFakeTimers({ now });
    try {
      expect(decide(input({ cfg: { autoApprove: { sampleRate: 0 }, freezes: [{ name: "x", days: ["fri"] }] } })).decision).toBe("human-review");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("decide: rule 4 (unknowns and LLM failure)", () => {
  it("routes an LLM failure to human review", () => {
    expect(decide(input({ llmFailed: true })).decision).toBe("human-review");
  });

  describe("llm.requireSafe", () => {
    const requireSafe = { llm: { enabled: true, requireSafe: true } };
    const judgement = (over: Partial<LlmJudgement> = {}): LlmJudgement => ({
      risk: 0.1,
      rationale: "",
      riskySnippets: [],
      confidence: 9,
      hunks: [],
      unclassified: [],
      truncated: false,
      ...over,
    });
    const verdict = (over: Partial<LlmHunkVerdict> = {}): LlmHunkVerdict => ({
      file: "src/a.ts",
      line: 1,
      category: "refactor",
      safe: true,
      confidence: 9,
      reason: "renames",
      ...over,
    });
    const risky = verdict({ file: "src/b.ts", line: 7, category: "logic_bug", safe: false, confidence: 9, reason: "off by one" });

    it("is off by default: a risky hunk does not block when requireSafe is false", () => {
      expect(decide(input({ cfg: { llm: { enabled: true } }, llm: judgement({ hunks: [risky] }) })).decision).toBe("auto-approve");
    });

    it("blocks when the judge did not run (e.g. --no-llm): requireSafe needs a verdict", () => {
      const out = decide(input({ cfg: requireSafe }));
      expect(out.decision).toBe("human-review");
      expect(out.reasons).toContain("LLM judge did not run; llm.requireSafe needs its verdict");
    });

    it("passes when every hunk is safe at or above minConfidence", () => {
      const out = decide(input({ cfg: requireSafe, llm: judgement({ hunks: [verdict(), verdict({ line: 20, category: "tests", confidence: 8 })] }) }));
      expect(out.decision).toBe("auto-approve");
    });

    it("blocks on a safe hunk below minConfidence, naming it with its confidence", () => {
      const out = decide(input({ cfg: requireSafe, llm: judgement({ hunks: [verdict({ confidence: 7 })] }) }));
      expect(out.decision).toBe("human-review");
      expect(out.reasons[0]).toBe("LLM judge: not all hunks safe: src/a.ts:1 refactor (confidence 7)");
    });

    it("honours a configured minConfidence", () => {
      const cfg = { llm: { enabled: true, requireSafe: true, minConfidence: 6 } };
      expect(decide(input({ cfg, llm: judgement({ hunks: [verdict({ confidence: 7 })] }) })).decision).toBe("auto-approve");
    });

    it("blocks on a risk-category hunk even at full confidence", () => {
      const out = decide(input({ cfg: requireSafe, llm: judgement({ hunks: [verdict(), risky] }) }));
      expect(out.decision).toBe("human-review");
      expect(out.reasons[0]).toBe("LLM judge: not all hunks safe: src/b.ts:7 logic_bug (confidence 9)");
    });

    it("blocks on a truncated diff", () => {
      const out = decide(input({ cfg: requireSafe, llm: judgement({ truncated: true }) }));
      expect(out.decision).toBe("human-review");
      expect(out.reasons[0]).toBe("LLM judge saw a truncated diff");
    });

    it("blocks on unclassified hunks, naming them", () => {
      const out = decide(input({ cfg: requireSafe, llm: judgement({ unclassified: [{ file: "src/a.ts", line: 3 }, { file: "src/c.ts", line: 9 }] }) }));
      expect(out.decision).toBe("human-review");
      expect(out.reasons[0]).toBe("LLM judge did not classify 2 hunks: src/a.ts:3, src/c.ts:9");
    });

    it("names at most 3 hunks, then counts the rest", () => {
      const hunks = [1, 2, 3, 4, 5].map((line) => verdict({ line, confidence: 2 }));
      const out = decide(input({ cfg: requireSafe, llm: judgement({ hunks }) }));
      expect(out.reasons[0]).toBe(
        "LLM judge: not all hunks safe: src/a.ts:1 refactor (confidence 2), src/a.ts:2 refactor (confidence 2), src/a.ts:3 refactor (confidence 2) and 2 more",
      );
    });

    it("only adds human-review: it never clears another rule or lowers the tier", () => {
      const out = decide(input({ score: 0.5, cfg: requireSafe, llm: judgement({ hunks: [verdict()] }) }));
      expect(out).toMatchObject({ tier: "yellow", decision: "human-review" });
    });
  });

  it("routes an unknown signal that could lift the score out of green", () => {
    const out = decide(input({ score: 0.25, signals: [unknown("blast.dependents", Math.log1p(10))] }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toMatch(/blast\.dependents/);
  });

  it("lets an unknown signal pass when even its plausible worst case stays green", () => {
    expect(decide(input({ score: 0.05, signals: [unknown("blast.dependents", Math.log1p(10))] })).decision).toBe("auto-approve");
  });

  it("routes unknowns whose joint worst case changes the tier, though none does alone", () => {
    const signals = [unknown("history.prior_fixes", 0), unknown("diffusion.authors", 0), unknown("history.churn", 0)];
    for (const s of signals) expect(decide(input({ score: 0.15, signals: [s] })).decision, s.id).toBe("auto-approve");

    const out = decide(input({ score: 0.15, signals }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toMatch(/together raise the score to 0\.4\d \(yellow\)/);
    for (const s of signals) expect(out.reasons[0]).toContain(s.id);
  });

  it("measures the lift from the value the model used, i.e. the prior for an unknown", () => {
    // blast.dependents is scored at its prior log1p(10), so only the rest of the range is at stake.
    expect(decide(input({ score: 0.15, signals: [unknown("blast.dependents", 0)] })).decision).toBe("auto-approve");
  });

  it("uses the risky end of the range for negative weights", () => {
    const out = decide(input({ score: 0.2, signals: [unknown("expertise.author_commits", Math.log1p(100))] }));
    expect(out.decision).toBe("human-review");
  });

  it("ignores unknowns with zero weight and treats unknowns without a known range as risk", () => {
    expect(decide(input({ signals: [unknown("lang.js", 0)] })).decision).toBe("auto-approve");
    const model: ModelWeights = { ...DEFAULT_WEIGHTS, weights: { ...DEFAULT_WEIGHTS.weights, "custom.feature": 0.1 } };
    expect(decide(input({ model, signals: [unknown("custom.feature", 0)] })).decision).toBe("human-review");
  });
});

describe("decide: PR state (draft, changes requested)", () => {
  it("never auto-approves a draft PR", () => {
    const out = decide(input({ pr: { successfulChecks: [], draft: true } }));
    expect(out).toMatchObject({ decision: "human-review", mergeMethod: "none" });
    expect(out.reasons[0]).toBe("draft PR: never auto-approved while in draft");
  });

  it("never auto-approves while changes are requested, naming every reviewer", () => {
    const out = decide(input({ pr: { successfulChecks: [], changesRequestedBy: ["alice", "bob"] } }));
    expect(out.decision).toBe("human-review");
    expect(out.reasons[0]).toBe("changes requested by @alice, @bob: never auto-approved until resolved");
  });

  it("has no effect when the PR is ready, nobody requests changes, or the state is unknown (local run)", () => {
    expect(decide(input({ pr: { successfulChecks: [], draft: false, changesRequestedBy: [] } })).decision).toBe("auto-approve");
    expect(decide(input({ pr: { successfulChecks: [] } })).decision).toBe("auto-approve");
    expect(decide(input()).decision).toBe("auto-approve");
  });

  it("takes precedence over waiting for the AI review", () => {
    const cfg = { autoApprove: { sampleRate: 0, requireAiReview: { checks: ["claude-review"] } } };
    expect(decide(input({ cfg, pr: { successfulChecks: [], draft: true } })).decision).toBe("human-review");
  });
});

describe("decide: rule 5 (AI review)", () => {
  const cfg = { autoApprove: { sampleRate: 0, requireAiReview: { checks: ["claude-review", "security-review"] } } };

  it("waits when requirements are configured but PR state is unknown (local run)", () => {
    const out = decide(input({ cfg }));
    expect(out.decision).toBe("waiting-ai-review");
    expect(out.reasons[0]).toMatch(/claude-review/);
  });

  it("waits until every listed check has passed on the head commit", () => {
    const out = decide(input({ cfg, pr: { successfulChecks: ["security-review"] } }));
    expect(out.decision).toBe("waiting-ai-review");
    expect(out.reasons[0]).toBe("AI review pending: missing check claude-review");
    expect(decide(input({ cfg, pr: { successfulChecks: ["claude-review", "security-review"] } })).decision).toBe("auto-approve");
  });

  it("accepts { name, app } entries and reports them by name", () => {
    const pinned = { autoApprove: { sampleRate: 0, requireAiReview: { checks: [{ name: "claude-review", app: "coderabbitai" }, "security-review"] } } };
    expect(decide(input({ cfg: pinned, pr: { successfulChecks: ["security-review"] } })).reasons[0]).toBe("AI review pending: missing check claude-review");
    expect(decide(input({ cfg: pinned, pr: { successfulChecks: ["claude-review", "security-review"] } })).decision).toBe("auto-approve");
  });

  it.each([[{ name: "claude-review" }], [{ name: "claude-review", app: "" }], [{ name: "claude-review", app: "x", extra: 1 }]])(
    "rejects a check entry %j that is not a name or { name, app }",
    (entry) => {
      expect(() => parseConfig({ autoApprove: { requireAiReview: { checks: [entry] } } })).toThrow(/requireAiReview/);
    },
  );

  it("passes when no checks are configured", () => {
    expect(decide(input()).decision).toBe("auto-approve");
  });

  it("rejects a config that still lists requireAiReview.labels, even an empty list", () => {
    const removed =
      "requireAiReview.labels was removed in 0.1.1: labels are not tied to a commit and can be added by anyone with triage access; " +
      "require a check run instead (requireAiReview.checks)";
    for (const labels of [["ai-reviewed"], []]) {
      expect(() => parseConfig({ autoApprove: { requireAiReview: { checks: ["claude-review"], labels } } })).toThrow(removed);
    }
  });
});

describe("decide: rule 6 (sampling)", () => {
  it("routes sampled PRs to a human", () => {
    const out = decide(input({ cfg: { autoApprove: { sampleRate: 1 } } }));
    expect(out).toMatchObject({ decision: "human-review", sampled: true, mergeMethod: "none" });
  });

  it("hashes diff.head to a uniform, deterministic value", () => {
    expect(sampleValue("abc")).toBe(sampleValue("abc"));
    const values = Array.from({ length: 2000 }, (_, i) => sampleValue(`sha-${i}`));
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThan(1);
    const share = values.filter((v) => v < 0.1).length / values.length;
    expect(share).toBeGreaterThan(0.08);
    expect(share).toBeLessThan(0.12);
  });

  it("is deterministic per head", () => {
    const cfg = { autoApprove: { sampleRate: 0.5 } };
    expect(decide(input({ cfg }))).toEqual(decide(input({ cfg })));
    expect(decide(input({ cfg })).sampled).toBe(sampleValue("head") < 0.5);
  });

  it("hashes pr.samplingKey instead of the head, so a new push cannot re-roll the sample", () => {
    const cfg = { autoApprove: { sampleRate: 0.5 } };
    const pr = { successfulChecks: [], number: 7, samplingKey: "o/r#7#salt" };
    const sampled = Array.from({ length: 20 }, (_, i) => {
      const base = input({ cfg, pr });
      return decide({ ...base, diff: { ...base.diff, head: `sha-${i}` } }).sampled;
    });
    expect(sampled).toEqual(Array(20).fill(sampleValue("o/r#7#salt") < 0.5));
  });
});
