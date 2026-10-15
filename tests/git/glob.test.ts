import { describe, expect, it } from "vitest";
import { matchAny, matchGlob } from "../../src/git/glob.js";

describe("matchGlob", () => {
  it("matches literal paths only exactly", () => {
    expect(matchGlob(".opendrs.yml", ".opendrs.yml")).toBe(true);
    expect(matchGlob(".opendrs.yml", "sub/.opendrs.yml")).toBe(false);
    expect(matchGlob("a.ts", "a_ts")).toBe(false);
  });

  it("* stays within one segment", () => {
    expect(matchGlob("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/x/a.ts")).toBe(false);
    expect(matchGlob("*.ts", "a.ts")).toBe(true);
  });

  it("? matches one non-slash character", () => {
    expect(matchGlob("a?.ts", "ab.ts")).toBe(true);
    expect(matchGlob("a?.ts", "a.ts")).toBe(false);
    expect(matchGlob("a?b", "a/b")).toBe(false);
  });

  it("leading **/ matches zero or more directories", () => {
    expect(matchGlob("**/*.lock", "yarn.lock")).toBe(true);
    expect(matchGlob("**/*.lock", "a/b/Cargo.lock")).toBe(true);
    expect(matchGlob("**/CODEOWNERS", "CODEOWNERS")).toBe(true);
    expect(matchGlob("**/CODEOWNERS", "docs/CODEOWNERS")).toBe(true);
  });

  it("trailing /** matches everything below", () => {
    expect(matchGlob(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(matchGlob(".github/**", "x/.github/a")).toBe(false);
    expect(matchGlob("**/dist/**", "dist/index.js")).toBe(true);
    expect(matchGlob("**/dist/**", "pkg/dist/a/b.js")).toBe(true);
    expect(matchGlob("**/dist/**", "distro/a.js")).toBe(false);
  });

  it("middle /**/ matches zero or more directories", () => {
    expect(matchGlob("src/**/x.ts", "src/x.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "src/a/b/x.ts")).toBe(true);
    expect(matchGlob("src/**/x.ts", "srcx.ts")).toBe(false);
  });

  it("supports braces, including globs inside them", () => {
    expect(matchGlob("**/*.{ts,tsx}", "a/b.tsx")).toBe(true);
    expect(matchGlob("**/*.{ts,tsx}", "a/b.js")).toBe(false);
    expect(matchGlob("{src,lib}/**", "lib/a.js")).toBe(true);
    expect(matchGlob("**/payment*/**", "svc/payments/api.ts")).toBe(true);
  });

  it("escapes regex metacharacters", () => {
    expect(matchGlob("a+b(1).ts", "a+b(1).ts")).toBe(true);
    expect(matchGlob("a.b", "aXb")).toBe(false);
  });

  it("handles unicode and spaces", () => {
    expect(matchGlob("**/*.md", "dócs/ünï code.md")).toBe(true);
  });
});

describe("matchAny", () => {
  it("is true when any pattern matches", () => {
    expect(matchAny(["**/*.lock", "**/vendor/**"], "a/vendor/x.go")).toBe(true);
    expect(matchAny(["**/*.lock"], "a.ts")).toBe(false);
    expect(matchAny([], "a.ts")).toBe(false);
  });
});
