import { describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import { OpendrsError } from "../../src/domain/types.js";
import { matchAny } from "../../src/git/glob.js";

const configError = (raw: unknown): string => {
  try {
    parseConfig(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(OpendrsError);
    return (e as OpendrsError).message;
  }
  throw new Error("expected parseConfig to throw");
};

describe("default paths.ignore", () => {
  it("does not ignore source directories named build", () => {
    const { ignore } = defaultConfig().paths;
    expect(ignore).not.toContain("**/build/**");
    expect(matchAny(ignore, "scripts/build/release.ts")).toBe(false);
  });
});

describe("default paths.block", () => {
  const blocked = (path: string) => matchAny(defaultConfig().paths.block, path);

  it("blocks .gitmodules, which can repoint a submodule at another repository", () => {
    expect(blocked(".gitmodules")).toBe(true);
  });

  it.each([".gitattributes", "tools/.gitattributes"])("blocks %s, which can make git call a binary text", (path) => {
    expect(blocked(path)).toBe(true);
  });
});

describe("glob validation", () => {
  it.each([
    ["block", "src/[ab]/**"],
    ["critical", "src/auth]/**"],
    ["ignore", "/dist/**"],
    ["tests", "./tests/**"],
    ["block", "infra\\main.tf"],
  ])("rejects paths.%s glob %s, naming it", (key, glob) => {
    expect(configError({ paths: { [key]: [glob] } })).toContain(`"${glob}"`);
  });

  it("explains what is wrong", () => {
    expect(configError({ paths: { block: ["src/[ab].ts"] } })).toMatch(/\[ or \]/);
    expect(configError({ paths: { block: ["./a/**"] } })).toMatch(/leading/);
    expect(configError({ paths: { block: ["a\\b"] } })).toMatch(/forward slash/);
  });

  it("accepts the supported syntax", () => {
    expect(() => parseConfig({ paths: { block: ["**/*.{tf,tfvars}", "src/?/x.ts", ".github/**"] } })).not.toThrow();
  });
});

describe("threshold validation", () => {
  it.each([
    [{ green: -0.1, yellow: 0.6, red: 0.8 }],
    [{ green: 0.6, yellow: 0.6, red: 0.8 }],
    [{ green: 0.3, yellow: 0.9, red: 0.8 }],
    [{ green: 0.3, yellow: 0.6, red: 1.5 }],
    [{ green: 30, yellow: 60, red: 80 }],
  ])("rejects absolute thresholds outside 0 ≤ green < yellow ≤ red ≤ 1: %o", (t) => {
    expect(configError({ thresholds: { mode: "absolute", ...t } })).toMatch(/0 ≤ green < yellow ≤ red ≤ 1/);
  });

  it("accepts absolute thresholds at the bounds", () => {
    expect(() => parseConfig({ thresholds: { green: 0, yellow: 1, red: 1 } })).not.toThrow();
  });

  it.each([
    [{ green: 0, yellow: 90, red: 95 }],
    [{ green: 90, yellow: 90, red: 95 }],
    [{ green: 50, yellow: 96, red: 95 }],
    [{ green: 50, yellow: 90, red: 100 }],
  ])("rejects percentile thresholds outside 0 < green < yellow ≤ red < 100: %o", (t) => {
    expect(configError({ thresholds: { mode: "percentile", ...t } })).toMatch(/0 < green < yellow ≤ red < 100/);
  });

  it("accepts ordered percentile thresholds", () => {
    expect(() => parseConfig({ thresholds: { mode: "percentile", green: 50, yellow: 90, red: 90 } })).not.toThrow();
  });
});
