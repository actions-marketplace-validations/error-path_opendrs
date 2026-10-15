import { describe, expect, it } from "vitest";
import { matchAny, matchGlob } from "../../src/git/glob.js";

describe("matchGlob", () => {
  it.each([
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", "src/.github/x", false],
    [".opendrs.yml", ".opendrs.yml", true],
    [".opendrs.yml", "x.opendrs.yml", false],
    [".opendrs.yml", "sub/.opendrs.yml", false],
    ["**/auth/**", "auth/login.ts", true],
    ["**/auth/**", "src/auth/deep/login.ts", true],
    ["**/auth/**", "src/oauth/login.ts", false],
    ["**/payment*/**", "svc/payments/api.go", true],
    ["**/payment*/**", "svc/payment.go", false],
    ["**/*.lock", "yarn.lock", true],
    ["**/*.lock", "a/b/Cargo.lock", true],
    ["**/*.lock", "a/lock", false],
    ["**/*.test.*", "src/a.test.ts", true],
    ["**/test_*.py", "pkg/test_x.py", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/a/b.ts", false],
    ["src/?.ts", "src/a.ts", true],
    ["src/?.ts", "src/ab.ts", false],
    ["a+b/(x).ts", "a+b/(x).ts", true],
    ["a+b/(x).ts", "aab/x.ts", false],
  ])("%s vs %s -> %s", (pattern, path, want) => {
    expect(matchGlob(pattern, path)).toBe(want);
  });
});

describe("matchAny", () => {
  it("is true when any pattern matches", () => {
    expect(matchAny(["docs/**", "**/*.tf"], "infra/main.tf")).toBe(true);
    expect(matchAny(["docs/**", "**/*.tf"], "src/main.ts")).toBe(false);
    expect(matchAny([], "src/main.ts")).toBe(false);
  });
});
