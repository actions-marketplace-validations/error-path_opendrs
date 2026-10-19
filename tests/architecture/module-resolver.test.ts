import { describe, expect, it } from "vitest";
import { buildModuleResolver } from "../../src/architecture/module.js";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import type { PackageRootIndex } from "../../src/graph/package-roots.js";

const EMPTY_ROOTS: PackageRootIndex = { js: [], rust: [], ruby: [], python: [], swift: [] };

describe("buildModuleResolver: JS", () => {
  it("a pnpm workspace with multiple package.json roots: each package is its own namespace", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite", "packages/create-vite"] };
    const files = ["packages/vite/src/node/server/index.ts", "packages/create-vite/src/index.ts"];
    const { moduleOf } = buildModuleResolver(files, roots, defaultConfig());
    expect(moduleOf("packages/vite/src/node/server/index.ts")).toBe("packages/vite/src/node");
    expect(moduleOf("packages/create-vite/src/index.ts")).toBe("packages/create-vite/src");
  });

  it("a file directly under a package root with no src/: the module is the root itself", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/foo"] };
    const { moduleOf } = buildModuleResolver(["packages/foo/index.ts"], roots, defaultConfig());
    expect(moduleOf("packages/foo/index.ts")).toBe("packages/foo");
  });

  it("a nested src/ package: module stops at root/src/<first segment>, deeper nesting does not matter", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite"] };
    const { moduleOf } = buildModuleResolver(["packages/vite/src/node/server/ws.ts"], roots, defaultConfig());
    expect(moduleOf("packages/vite/src/node/server/ws.ts")).toBe("packages/vite/src/node");
    expect(moduleOf("packages/vite/src/node/other.ts")).toBe("packages/vite/src/node");
  });
});

describe("buildModuleResolver: Go", () => {
  it("two sibling directories under the same parent are two modules", () => {
    const { moduleOf } = buildModuleResolver(["pkg/cmd/issue/create/create.go", "pkg/cmd/issue/list/list.go"], EMPTY_ROOTS, defaultConfig());
    expect(moduleOf("pkg/cmd/issue/create/create.go")).toBe("pkg/cmd/issue/create");
    expect(moduleOf("pkg/cmd/issue/list/list.go")).toBe("pkg/cmd/issue/list");
    expect(moduleOf("pkg/cmd/issue/create/create.go")).not.toBe(moduleOf("pkg/cmd/issue/list/list.go"));
  });

  it("a file at the repo root with no enclosing go.mod is its own (empty) module", () => {
    const { moduleOf } = buildModuleResolver(["main.go"], EMPTY_ROOTS, defaultConfig());
    expect(moduleOf("main.go")).toBe("");
  });
});

describe("buildModuleResolver: Rust", () => {
  it("a workspace with multiple Cargo.toml: each crate's src/<first segment> is a module", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, rust: ["actix-http", "actix-web"] };
    const { moduleOf } = buildModuleResolver(["actix-http/src/h1/dispatcher.rs", "actix-web/src/app.rs"], roots, defaultConfig());
    expect(moduleOf("actix-http/src/h1/dispatcher.rs")).toBe("actix-http/src/h1");
    expect(moduleOf("actix-web/src/app.rs")).toBe("actix-web/src");
  });

  it("a crate with lib.rs directly under its crate root (no src/ to skip): module is the crate root", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, rust: ["weird-crate"] };
    const { moduleOf } = buildModuleResolver(["weird-crate/lib.rs"], roots, defaultConfig());
    expect(moduleOf("weird-crate/lib.rs")).toBe("weird-crate");
  });
});

describe("buildModuleResolver: Ruby", () => {
  it("a gemspec root with no src-style nesting: module is root/lib/<first segment>", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, ruby: ["fastlane"] };
    const { moduleOf } = buildModuleResolver(["fastlane/lib/fastlane/actions/upload_to_play_store.rb"], roots, defaultConfig());
    expect(moduleOf("fastlane/lib/fastlane/actions/upload_to_play_store.rb")).toBe("fastlane/lib/fastlane");
  });

  it("the lib/<gemname>/ repeat collapses to one module for every file beneath it (documented limit, spec §8)", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, ruby: ["fastlane"] };
    const { moduleOf } = buildModuleResolver([], roots, defaultConfig());
    expect(moduleOf("fastlane/lib/fastlane/actions/a.rb")).toBe(moduleOf("fastlane/lib/fastlane/helper/b.rb"));
  });

  it("a tool directory with no nested lib/<name>/ still splits at the first segment beneath lib/", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, ruby: ["match"] };
    const { moduleOf } = buildModuleResolver(["match/lib/match/options.rb"], roots, defaultConfig());
    expect(moduleOf("match/lib/match/options.rb")).toBe("match/lib/match");
  });
});

describe("buildModuleResolver: Python", () => {
  it("pyproject.toml at the repo root with a src/ layout", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, python: [""] };
    const { moduleOf } = buildModuleResolver(["src/black/linegen.py"], roots, defaultConfig());
    expect(moduleOf("src/black/linegen.py")).toBe("src/black");
    // A flat package has no finer boundary to find: every file under it lands in the same module (spec §8).
    expect(moduleOf("src/black/nodes.py")).toBe("src/black");
  });

  it("a flat package with no src/ and no further subdirectories: module is the root, no crash", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, python: ["mypkg"] };
    const { moduleOf } = buildModuleResolver(["mypkg/foo.py"], roots, defaultConfig());
    expect(moduleOf("mypkg/foo.py")).toBe("mypkg");
  });
});

describe("buildModuleResolver: Swift", () => {
  it("a single-target package: the whole target is one module, no finer split", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, swift: ["Sources/Vapor"] };
    const { moduleOf } = buildModuleResolver(["Sources/Vapor/HTTP/Headers.swift"], roots, defaultConfig());
    expect(moduleOf("Sources/Vapor/HTTP/Headers.swift")).toBe("Sources/Vapor");
  });

  it("a multi-target package: each target is its own module", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, swift: ["Sources/Core", "Sources/CLITool"] };
    const { moduleOf } = buildModuleResolver(["Sources/Core/A.swift", "Sources/CLITool/Main.swift"], roots, defaultConfig());
    expect(moduleOf("Sources/Core/A.swift")).toBe("Sources/Core");
    expect(moduleOf("Sources/CLITool/Main.swift")).toBe("Sources/CLITool");
  });
});

describe("buildModuleResolver: fallback and precedence", () => {
  it("no manifest found for the file's language falls back to moduleDepth 2", () => {
    const { moduleOf } = buildModuleResolver(["src/auth/token.ts"], EMPTY_ROOTS, defaultConfig());
    expect(moduleOf("src/auth/token.ts")).toBe("src/auth");
  });

  it("a language with no auto-detection rule at all (e.g. Java) falls back to moduleDepth", () => {
    const { moduleOf } = buildModuleResolver(["src/main/java/com/example/App.java"], EMPTY_ROOTS, defaultConfig());
    expect(moduleOf("src/main/java/com/example/App.java")).toBe("src/main");
  });

  it("captain.modules overrides auto-detection when both are present", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite"] };
    const config = parseConfig({ captain: { modules: ["packages/vite/src/node/**", "packages/vite/src/client/**"] } });
    const { moduleOf } = buildModuleResolver(["packages/vite/src/node/server/index.ts", "packages/vite/src/client/client.ts"], roots, config);
    expect(moduleOf("packages/vite/src/node/server/index.ts")).toBe("packages/vite/src/node");
    expect(moduleOf("packages/vite/src/client/client.ts")).toBe("packages/vite/src/client");
  });

  it("a path matching no captain.modules glob still falls through to auto-detection", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite"] };
    const config = parseConfig({ captain: { modules: ["packages/vite/src/node/**"] } });
    const { moduleOf } = buildModuleResolver(["packages/vite/src/client/client.ts"], roots, config);
    expect(moduleOf("packages/vite/src/client/client.ts")).toBe("packages/vite/src/client");
  });

  it("an explicit moduleDepth in config disables auto-detection repo-wide", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite"] };
    const config = parseConfig({ captain: { moduleDepth: 4 } });
    const { moduleOf } = buildModuleResolver(["packages/vite/src/node/server/index.ts"], roots, config);
    // Flat depth 4, ignoring the detected package root entirely.
    expect(moduleOf("packages/vite/src/node/server/index.ts")).toBe("packages/vite/src/node");
    expect(moduleOf("packages/vite/src/node/x.ts")).toBe("packages/vite/src/node");
    expect(moduleOf("a/b/c/d/e/f.ts")).toBe("a/b/c/d");
  });
});

describe("buildModuleResolver: the note line", () => {
  it("names the per-ecosystem detection method, one line per language present", () => {
    const roots: PackageRootIndex = { ...EMPTY_ROOTS, js: ["packages/vite", "packages/create-vite"] };
    const { notes } = buildModuleResolver(["packages/vite/src/index.ts", "pkg/cmd/foo.go"], roots, defaultConfig());
    expect(notes).toEqual(expect.arrayContaining(["modules: auto-detected 2 JS/TS packages from package.json", "modules: Go packages (one per directory)"]));
  });

  it("names the fallback when no manifest is found for a present language", () => {
    const { notes } = buildModuleResolver(["src/black/linegen.py"], EMPTY_ROOTS, defaultConfig());
    expect(notes).toEqual(["modules: no pyproject.toml/setup.cfg found; falling back to moduleDepth: 2"]);
  });

  it("names captain.modules when it is configured, instead of the per-ecosystem lines", () => {
    const config = parseConfig({ captain: { modules: ["packages/vite/src/node/**"] } });
    const { notes } = buildModuleResolver(["packages/vite/src/node/x.ts"], EMPTY_ROOTS, config);
    expect(notes).toEqual(["modules: captain.modules override (1 glob)"]);
  });

  it("names the explicit moduleDepth when auto-detection is disabled", () => {
    const config = parseConfig({ captain: { moduleDepth: 3 } });
    const { notes } = buildModuleResolver(["src/a/b/c.ts"], EMPTY_ROOTS, config);
    expect(notes).toEqual(["modules: captain.moduleDepth is set explicitly (3); auto-detection is disabled"]);
  });
});
