import { describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { matchAny } from "../../src/git/glob.js";

describe("default paths.ignore", () => {
  it("does not ignore source directories named build", () => {
    const { ignore } = defaultConfig().paths;
    expect(ignore).not.toContain("**/build/**");
    expect(matchAny(ignore, "scripts/build/release.ts")).toBe(false);
  });
});
