import { describe, expect, it } from "vitest";
import { moduleOf } from "../../src/architecture/module.js";

describe("moduleOf", () => {
  it("takes the first depth segments of the file's directory", () => {
    expect(moduleOf("src/auth/token.ts", 2)).toBe("src/auth");
    expect(moduleOf("src/a/b/c.ts", 2)).toBe("src/a");
  });

  it("uses the directory as is when it has fewer segments than depth", () => {
    expect(moduleOf("src/x.ts", 2)).toBe("src");
  });

  it("is empty for a file at the repo root", () => {
    expect(moduleOf("README.md", 2)).toBe("");
  });

  it("respects depth 1", () => {
    expect(moduleOf("src/auth/token.ts", 1)).toBe("src");
    expect(moduleOf("src/a/b/c.ts", 1)).toBe("src");
  });
});
