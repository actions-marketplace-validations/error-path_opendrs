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

  it.each([
    "package.json",
    "web/package.json",
    ".npmrc",
    ".yarnrc",
    "web/.yarnrc.yml",
    ".pnpmfile.cjs",
    "setup.py",
    "pkg/setup.cfg",
    "pyproject.toml",
    "pip.conf",
    "build.gradle",
    "app/build.gradle.kts",
    "settings.gradle",
    "settings.gradle.kts",
    "gradle/wrapper/gradle-wrapper.properties",
    "sub/gradle/wrapper/gradle-wrapper.jar",
    "pom.xml",
    ".mvn/wrapper/maven-wrapper.properties",
    "Cargo.toml",
    "crates/x/build.rs",
    "go.mod",
    "Gemfile",
    "Rakefile",
    "lib/x.gemspec",
    "Makefile",
    "native/Makefile",
    "Dockerfile",
    "svc/Dockerfile.dev",
    "docker-compose.yml",
    "deploy/docker-compose.prod.yml",
    ".gitlab-ci.yml",
    "Jenkinsfile",
    ".circleci/config.yml",
    "azure-pipelines.yml",
    ".buildkite/pipeline.yml",
  ])("blocks %s, which can run code at install, build or CI time", (path) => {
    expect(blocked(path)).toBe(true);
  });

  it.each([
    "makefile",
    "GNUmakefile",
    "lib/rules.mk",
    "compose.yaml",
    "deploy/compose.yml",
    "docker-compose.yaml",
    "Data/Migrations/20240101_Init.cs",
    "db/migrate/20240101_add_users.rb",
    "src/main/resources/db/migration/V1__init.sql",
    "requirements.txt",
    "requirements-dev.txt",
    "tests/conftest.py",
    ".pre-commit-config.yaml",
    "tox.ini",
    "noxfile.py",
    "App/App.csproj",
    "App.sln",
    "Directory.Build.props",
    "Directory.Build.targets",
    "NuGet.Config",
    "CMakeLists.txt",
    "cmake/deps.cmake",
    ".cargo/config.toml",
    ".husky/pre-commit",
    "Brewfile",
    "Vagrantfile",
    "Procfile",
    "default.nix",
    "flake.lock",
    ".devcontainer/devcontainer.json",
    ".envrc",
    "Taskfile.yml",
    "justfile",
    "bitbucket-pipelines.yml",
    ".drone.yml",
    ".travis.yml",
    "cloudbuild.yaml",
    "Earthfile",
    "pkg/BUILD",
    "pkg/BUILD.bazel",
    "WORKSPACE",
    "WORKSPACE.bazel",
    "MODULE.bazel",
    "tools/defs.bzl",
    "dockerfile",
    "infra/Main.TF",
    ".GITHUB/workflows/ci.yml",
  ])("blocks %s, matching case-insensitively", (path) => {
    expect(matchAny(defaultConfig().paths.block, path, { ignoreCase: true })).toBe(true);
  });

  it("keeps the original entries and leaves ordinary source alone", () => {
    expect(defaultConfig().paths.block).toEqual(
      expect.arrayContaining([".github/**", ".opendrs.yml", ".opendrs/**", "**/CODEOWNERS", "**/migrations/**", "**/*.tf"]),
    );
    for (const path of ["src/a.ts", "docs/Makefile.md", "src/package.ts", "README.md", "src/build.rs.md", "src/build/index.ts", "docs/requirements.md"]) {
      expect(matchAny(defaultConfig().paths.block, path, { ignoreCase: true }), path).toBe(false);
    }
  });
});

describe("user paths.block, paths.critical and paths.unblock", () => {
  const defaults = defaultConfig().paths;

  it("extend the default block list instead of replacing it", () => {
    const { block } = parseConfig({ paths: { block: ["infra/**"] } }).paths;
    expect(block).toEqual([...defaults.block, "infra/**"]);
    expect(matchAny(block, "package.json", { ignoreCase: true })).toBe(true);
  });

  it("extend the default critical list instead of replacing it", () => {
    expect(parseConfig({ paths: { critical: ["core/**"] } }).paths.critical).toEqual([...defaults.critical, "core/**"]);
  });

  it("do not duplicate a default the user lists again (as `opendrs init` writes them)", () => {
    expect(parseConfig({ paths: { block: [".github/**", "infra/**"], critical: ["**/auth/**"] } }).paths).toMatchObject({
      block: [...defaults.block, "infra/**"],
      critical: defaults.critical,
    });
  });

  it("an empty block list keeps every default", () => {
    expect(parseConfig({ paths: { block: [] } }).paths.block).toEqual(defaults.block);
  });

  it("unblock removes exactly the listed default globs", () => {
    const { block, unblock } = parseConfig({ paths: { unblock: ["**/go.mod", "**/Makefile"] } }).paths;
    expect(block).toEqual(defaults.block.filter((g) => g !== "**/go.mod" && g !== "**/Makefile"));
    expect(unblock).toEqual(["**/go.mod", "**/Makefile"]);
  });

  it("unblock wins over the same glob listed under block", () => {
    expect(parseConfig({ paths: { block: ["**/go.mod"], unblock: ["**/go.mod"] } }).paths.block).not.toContain("**/go.mod");
  });

  it("defaults to an empty unblock list", () => {
    expect(defaults.unblock).toEqual([]);
  });

  it.each([["go.mod"], ["**/GO.MOD"], ["infra/**"]])("rejects unblock entry %s that is not exactly a default glob, naming the valid ones", (entry) => {
    const message = configError({ paths: { unblock: [entry] } });
    expect(message).toContain(`"${entry}"`);
    expect(message).toContain('"**/go.mod"');
    expect(message).toContain('".github/**"');
  });

  it("keeps replace semantics for ignore and tests", () => {
    expect(parseConfig({ paths: { ignore: ["gen/**"], tests: ["spec/**"] } }).paths).toMatchObject({ ignore: ["gen/**"], tests: ["spec/**"] });
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

describe("history.labelHorizonDays", () => {
  it("defaults to 60 days and accepts 0 (off)", () => {
    expect(defaultConfig().history.labelHorizonDays).toBe(60);
    expect(parseConfig({ history: { labelHorizonDays: 0 } }).history.labelHorizonDays).toBe(0);
  });

  it("rejects a negative horizon", () => {
    expect(configError({ history: { labelHorizonDays: -1 } })).toMatch(/labelHorizonDays/);
  });
});
