import { describe, expect, it } from "vitest";
import { globMatch, globMatchAny } from "../../src/graph/glob-lite.js";

describe("glob-lite", () => {
  it.each([
    [".github/**", ".github/workflows/ci.yml", true],
    [".github/**", "src/.github/x", false],
    ["**/*.lock", "yarn.lock", true],
    ["**/*.lock", "a/b/Cargo.lock", true],
    ["**/*.lock", "a/lock", false],
    ["**/auth/**", "auth/login.ts", true],
    ["**/auth/**", "src/auth/login.ts", true],
    ["**/auth/**", "src/oauth/login.ts", false],
    ["**/payment*/**", "svc/payments/api.go", true],
    ["src/*.ts", "src/a.ts", true],
    ["src/*.ts", "src/x/a.ts", false],
    ["file?.md", "file1.md", true],
    ["file?.md", "file12.md", false],
    ["**/*.{ts,tsx}", "a/b.tsx", true],
    ["**/*.{ts,tsx}", "a/b.js", false],
    [".opendrs.yml", ".opendrs.yml", true],
    [".opendrs.yml", "xopendrs.yml", false],
    ["**/CODEOWNERS", "CODEOWNERS", true],
    ["**/CODEOWNERS", "docs/CODEOWNERS", true],
  ])("%s vs %s -> %s", (pattern, path, expected) => {
    expect(globMatch(pattern, path)).toBe(expected);
  });

  it("matches any of several patterns", () => {
    expect(globMatchAny(["**/*.md", "**/dist/**"], "pkg/dist/a.js")).toBe(true);
    expect(globMatchAny(["**/*.md"], "a.ts")).toBe(false);
    expect(globMatchAny([], "a.ts")).toBe(false);
  });
});
