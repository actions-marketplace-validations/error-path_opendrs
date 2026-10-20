import { describe, expect, it } from "vitest";
import { computePackageRoots } from "../../src/graph/package-roots.js";

describe("computePackageRoots: JS", () => {
  it("indexes every directory with a package.json that has a name field", () => {
    const files = ["packages/a/package.json", "packages/a/src/index.ts", "packages/b/package.json", "packages/b/src/index.ts"];
    const contents = new Map([
      ["packages/a/package.json", JSON.stringify({ name: "a" })],
      ["packages/b/package.json", JSON.stringify({ name: "b" })],
    ]);
    const roots = computePackageRoots(files, contents);
    expect(roots.js).toEqual(expect.arrayContaining(["packages/a", "packages/b"]));
    expect(roots.js).toHaveLength(2);
  });

  it("ignores a package.json with no name field", () => {
    const files = ["tools/fixture/package.json"];
    const contents = new Map([["tools/fixture/package.json", JSON.stringify({ private: true })]]);
    expect(computePackageRoots(files, contents).js).toEqual([]);
  });

  it("ignores a package.json that is not valid JSON", () => {
    const files = ["broken/package.json"];
    const contents = new Map([["broken/package.json", "{ not json"]]);
    expect(computePackageRoots(files, contents).js).toEqual([]);
  });
});

describe("computePackageRoots: Rust, Ruby, Python (existence only, no content needed)", () => {
  it("indexes every directory with a Cargo.toml", () => {
    const files = ["actix-http/Cargo.toml", "actix-http/src/lib.rs", "actix-web/Cargo.toml", "actix-web/src/lib.rs"];
    expect(computePackageRoots(files, new Map()).rust).toEqual(expect.arrayContaining(["actix-http", "actix-web"]));
  });

  it("indexes every directory with a *.gemspec", () => {
    const files = ["fastlane/fastlane.gemspec", "fastlane/lib/fastlane/actions/x.rb", "match/match.gemspec"];
    expect(computePackageRoots(files, new Map()).ruby).toEqual(expect.arrayContaining(["fastlane", "match"]));
  });

  it("indexes every directory with a pyproject.toml or a setup.cfg", () => {
    const files = ["pyproject.toml", "src/black/linegen.py", "legacy/setup.cfg", "legacy/pkg/x.py"];
    expect(computePackageRoots(files, new Map()).python).toEqual(expect.arrayContaining(["", "legacy"]));
  });
});

describe("computePackageRoots: Swift", () => {
  it("a single-target Package.swift defaults the target's dir to Sources/<name>", () => {
    const text = 'let package = Package(\n  name: "Vapor",\n  targets: [\n    .target(name: "Vapor", dependencies: []),\n  ]\n)\n';
    const roots = computePackageRoots(["Package.swift"], new Map([["Package.swift", text]]));
    expect(roots.swift).toEqual(["Sources/Vapor"]);
  });

  it("a multi-target Package.swift with an explicit path per target", () => {
    const text =
      'let package = Package(\n  targets: [\n    .target(name: "Core", path: "Sources/Core"),\n    .executableTarget(name: "CLI", path: "Sources/CLITool"),\n  ]\n)\n';
    const roots = computePackageRoots(["Package.swift"], new Map([["Package.swift", text]]));
    expect(roots.swift).toEqual(expect.arrayContaining(["Sources/Core", "Sources/CLITool"]));
    expect(roots.swift).toHaveLength(2);
  });

  it("an unterminated .target(...) call stops scanning rather than mis-parsing", () => {
    const text = 'let package = Package(\n  targets: [\n    .target(name: "Vapor"\n';
    expect(computePackageRoots(["Package.swift"], new Map([["Package.swift", text]])).swift).toEqual([]);
  });
});
