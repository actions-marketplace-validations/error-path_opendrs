import { describe, expect, it } from "vitest";
import type { Signal } from "../../src/domain/types.js";
import { DEFAULT_WEIGHTS } from "../../src/model/defaults.js";
import { scoreSignals } from "../../src/model/logistic.js";

const l = Math.log1p;

/** Build a full signal vector; every spec §4 id is present so priors never kick in. */
function vector(values: Record<string, number>): Signal[] {
  const base: Record<string, number> = {
    "size.churn": 0,
    "size.relative": 0,
    "size.new_files_only": 0,
    "diffusion.files": 0,
    "diffusion.dirs": 0,
    "diffusion.authors": 0,
    "history.prior_fixes": 0,
    "history.incident": 0,
    "history.churn": 0,
    "expertise.author_commits": 0,
    "expertise.owner_ratio": 0,
    "complexity.touched": 0,
    "blast.dependents": 0,
    "blast.public_surface": 0,
    "paths.critical": 0,
    "paths.blocked": 0,
    "tests.missing": 0,
  };
  return Object.entries({ ...base, ...values }).map(([id, value]) => ({ id, value, status: "observed", summary: id, evidence: [] }));
}

// (a) 2-line typo fix in README.md by an occasional contributor.
const docsTypo = vector({
  "size.churn": l(2),
  "size.relative": l(2 / 200),
  "diffusion.files": l(1),
  "diffusion.dirs": l(1),
  "diffusion.authors": l(3),
  "history.churn": l(10),
  "expertise.author_commits": l(5),
  "lang.docs": 1,
});

// (b) 100 lines over 4 files (2 src + 2 test), moderate history, experienced author.
const moderate = vector({
  "size.churn": l(100),
  "size.relative": l(100 / 800),
  "diffusion.files": l(4),
  "diffusion.dirs": l(2),
  "diffusion.authors": l(4),
  "history.prior_fixes": l(3),
  "history.churn": l(20),
  "expertise.author_commits": l(150),
  "expertise.owner_ratio": 0.5,
  "complexity.touched": l(40),
  "blast.dependents": l(10),
  "lang.js": 1,
});

// (c) 600 lines on a hub with ~200 transitive dependents, no tests, prior fixes, new author.
const hub = vector({
  "size.churn": l(600),
  "size.relative": l(600 / 1500),
  "diffusion.files": l(8),
  "diffusion.dirs": l(3),
  "diffusion.authors": l(10),
  "history.prior_fixes": l(8),
  "history.churn": l(60),
  "expertise.author_commits": l(2),
  "complexity.touched": l(150),
  "blast.dependents": l(200),
  "blast.public_surface": 1,
  "tests.missing": 1,
  "lang.js": 1,
});

// (d) like (b) but 40 lines in 2 files under a `critical` path.
const critical = vector({
  "size.churn": l(40),
  "size.relative": l(40 / 400),
  "diffusion.files": l(2),
  "diffusion.dirs": l(1),
  "diffusion.authors": l(4),
  "history.prior_fixes": l(3),
  "history.churn": l(20),
  "expertise.author_commits": l(150),
  "expertise.owner_ratio": 0.5,
  "complexity.touched": l(40),
  "blast.dependents": l(10),
  "paths.critical": 1,
  "lang.js": 1,
});

// (e) new-files-only 300-line feature (4 src + 1 test file), no history, nothing imports it yet.
const newFeature = vector({
  "size.churn": l(300),
  "size.new_files_only": 1,
  "diffusion.files": l(5),
  "diffusion.dirs": l(2),
  "expertise.author_commits": l(50),
  "complexity.touched": l(30),
  "lang.js": 1,
});

const score = (s: Signal[]) => scoreSignals(s, DEFAULT_WEIGHTS).score;

describe("DEFAULT_WEIGHTS fixtures (spec §5 targets)", () => {
  it("(a) docs-only typo fix scores about 0.05", () => {
    expect(score(docsTypo)).toBeGreaterThanOrEqual(0.03);
    expect(score(docsTypo)).toBeLessThanOrEqual(0.08);
  });

  it("(b) 100-line change with tests by an experienced author scores about 0.2", () => {
    expect(score(moderate)).toBeGreaterThanOrEqual(0.12);
    expect(score(moderate)).toBeLessThanOrEqual(0.25);
  });

  it("(c) 600-line untested hub change by a new author scores >= 0.8", () => {
    expect(score(hub)).toBeGreaterThanOrEqual(0.8);
  });

  it("(d) small change in a critical path is clearly above (b) but below 0.6", () => {
    expect(score(critical)).toBeGreaterThan(score(moderate) + 0.1);
    expect(score(critical)).toBeLessThan(0.6);
  });

  it("(e) new-files-only feature with tests stays below 0.3", () => {
    expect(score(newFeature)).toBeLessThan(0.3);
  });
});

describe("DEFAULT_WEIGHTS shape", () => {
  const ids = [
    "size.churn",
    "size.relative",
    "size.new_files_only",
    "diffusion.files",
    "diffusion.dirs",
    "diffusion.authors",
    "history.prior_fixes",
    "history.incident",
    "history.churn",
    "expertise.author_commits",
    "expertise.owner_ratio",
    "complexity.touched",
    "blast.dependents",
    "blast.public_surface",
    "paths.critical",
    "paths.blocked",
    "tests.missing",
    "llm.semantic",
    "lang.docs",
    "lang.config",
  ];

  it("has a weight for every spec §4 signal id", () => {
    for (const id of ids) expect(DEFAULT_WEIGHTS.weights, id).toHaveProperty([id]);
  });

  it("encodes the literature's signs: experience lowers risk, docs/config lower risk, LLM at 0.8", () => {
    const w = DEFAULT_WEIGHTS.weights;
    expect(w["expertise.author_commits"]).toBeLessThan(0);
    expect(w["lang.docs"]).toBeLessThan(0);
    expect(w["lang.config"]).toBeLessThan(0);
    expect(w["llm.semantic"]).toBe(0.8);
    for (const id of ["size.churn", "diffusion.files", "history.prior_fixes", "blast.dependents", "tests.missing"]) {
      expect(w[id], id).toBeGreaterThan(0);
    }
  });
});
