import { describe, expect, it } from "vitest";
import { createResolver } from "../../src/graph/resolve.js";

function resolverFor(files: Record<string, string>) {
  return createResolver(Object.keys(files), new Map(Object.entries(files)));
}

describe("resolve: TS/JS", () => {
  const r = resolverFor({
    "src/a.ts": "",
    "src/b.tsx": "",
    "src/util/index.ts": "",
    "src/data.json": "",
    "src/legacy.js": "",
    "tsconfig.json": `{
      // comments and trailing commas are tolerated
      "compilerOptions": {
        "baseUrl": "./src",
        "paths": { "@app/*": ["*"], "~lib": ["util/index.ts"], },
      },
    }`,
    "packages/core/package.json": `{ "name": "@acme/core", "main": "dist/index.js" }`,
    "packages/core/src/index.ts": "",
    "packages/core/src/math.ts": "",
  });

  it("resolves relative specifiers with extension and index probing", () => {
    expect(r("src/b.tsx", "./a")).toEqual(["src/a.ts"]);
    expect(r("src/a.ts", "./util")).toEqual(["src/util/index.ts"]);
    expect(r("src/a.ts", "./data.json")).toEqual(["src/data.json"]);
    expect(r("src/a.ts", "./legacy.js")).toEqual(["src/legacy.js"]);
  });

  it("maps ESM .js specifiers onto TypeScript sources", () => {
    expect(r("src/b.tsx", "./a.js")).toEqual(["src/a.ts"]);
  });

  it("resolves tsconfig paths aliases and baseUrl", () => {
    expect(r("src/b.tsx", "@app/a")).toEqual(["src/a.ts"]);
    expect(r("src/b.tsx", "~lib")).toEqual(["src/util/index.ts"]);
    expect(r("src/b.tsx", "util")).toEqual(["src/util/index.ts"]);
  });

  it("resolves workspace package names and subpaths", () => {
    expect(r("src/a.ts", "@acme/core")).toEqual(["packages/core/src/index.ts"]);
    expect(r("src/a.ts", "@acme/core/math")).toEqual(["packages/core/src/math.ts"]);
  });

  it("drops external and escaping specifiers", () => {
    expect(r("src/a.ts", "react")).toEqual([]);
    expect(r("src/a.ts", "../../outside")).toEqual([]);
  });
});

describe("resolve: Python", () => {
  const r = resolverFor({
    "app/__init__.py": "",
    "app/models.py": "",
    "app/sub/__init__.py": "",
    "app/sub/helpers.py": "",
    "src/lib/core.py": "",
  });

  it("maps dotted modules from the repo root and from src/", () => {
    expect(r("main.py", "app.models")).toEqual(["app/models.py"]);
    expect(r("main.py", "app.sub")).toEqual(["app/sub/__init__.py"]);
    expect(r("main.py", "lib.core")).toEqual(["src/lib/core.py"]);
    expect(r("main.py", "numpy")).toEqual([]);
  });

  it("resolves relative imports", () => {
    expect(r("app/sub/helpers.py", "..models")).toEqual(["app/models.py"]);
    expect(r("app/models.py", ".sub.helpers")).toEqual(["app/sub/helpers.py"]);
    expect(r("app/models.py", ".")).toEqual(["app/__init__.py"]);
  });
});

describe("resolve: Go", () => {
  const r = resolverFor({
    "go.mod": "module example.com/shop\n\ngo 1.22\n",
    "pkg/cart/cart.go": "",
    "pkg/cart/total.go": "",
    "pkg/cart/cart_test.go": "",
    "pkg/cart/inner/x.go": "",
  });

  it("maps a module-prefixed import to every non-test file of the package", () => {
    expect(r("cmd/main.go", "example.com/shop/pkg/cart").sort()).toEqual(["pkg/cart/cart.go", "pkg/cart/total.go"]);
    expect(r("cmd/main.go", "fmt")).toEqual([]);
  });
});

describe("resolve: Go — duplicate module path", () => {
  // Reproduces a repo where a nested fixture (e.g. a CodeQL test fixture under .github/) declares
  // the same module path as the real root go.mod. The resolver must still map imports to the real
  // package files, not silently resolve to the fixture's (empty, for this import) directory.
  it("resolves against the real module when a nested go.mod declares the identical path", () => {
    // The fixture's go.mod is listed (and so visited) before the real root go.mod, reproducing the
    // file-order dependence of the original bug rather than relying on insertion order to pass.
    const r = resolverFor({
      ".github/codeql/tests/some-check/go.mod": "module example.com/shop\n\ngo 1.22\n",
      "go.mod": "module example.com/shop\n\ngo 1.22\n",
      "pkg/cart/cart.go": "",
      "pkg/cart/total.go": "",
    });
    expect(r("cmd/main.go", "example.com/shop/pkg/cart").sort()).toEqual(["pkg/cart/cart.go", "pkg/cart/total.go"]);
  });

  it("ignores a go.mod under testdata/ when it collides with the real module path", () => {
    const r = resolverFor({
      "testdata/fixture/go.mod": "module example.com/shop\n\ngo 1.22\n",
      "testdata/fixture/pkg/cart/cart.go": "",
      "go.mod": "module example.com/shop\n\ngo 1.22\n",
      "pkg/cart/cart.go": "",
    });
    expect(r("cmd/main.go", "example.com/shop/pkg/cart")).toEqual(["pkg/cart/cart.go"]);
  });
});

describe("resolve: Java/Kotlin", () => {
  const r = resolverFor({
    "src/main/java/com/acme/util/Strings.java": "package com.acme.util;\npublic class Strings {}\n",
    "src/main/java/com/acme/util/MathUtil.java": "package com.acme.util;\npublic final class MathUtil {}\n",
    "src/main/kotlin/com/acme/model/Models.kt": "package com.acme.model\n\ndata class User(val id: Int)\nobject Registry\n",
  });

  it("resolves class, nested-class, static and wildcard imports", () => {
    expect(r("App.java", "com.acme.util.Strings")).toEqual(["src/main/java/com/acme/util/Strings.java"]);
    expect(r("App.java", "com.acme.util.MathUtil.max")).toEqual(["src/main/java/com/acme/util/MathUtil.java"]);
    expect(r("App.java", "com.acme.util.*").sort()).toEqual([
      "src/main/java/com/acme/util/MathUtil.java",
      "src/main/java/com/acme/util/Strings.java",
    ]);
    expect(r("App.kt", "com.acme.model.User")).toEqual(["src/main/kotlin/com/acme/model/Models.kt"]);
    expect(r("App.kt", "java.util.List")).toEqual([]);
  });
});

describe("resolve: Rust", () => {
  const r = resolverFor({
    "Cargo.toml": "",
    "src/lib.rs": "",
    "src/parser.rs": "",
    "src/parser/lexer.rs": "",
    "src/net/mod.rs": "",
    "src/net/http.rs": "",
  });

  it("maps mod declarations to x.rs or x/mod.rs", () => {
    expect(r("src/lib.rs", "mod:parser")).toEqual(["src/parser.rs"]);
    expect(r("src/lib.rs", "mod:net")).toEqual(["src/net/mod.rs"]);
    expect(r("src/parser.rs", "mod:lexer")).toEqual(["src/parser/lexer.rs"]);
    expect(r("src/net/mod.rs", "mod:http")).toEqual(["src/net/http.rs"]);
  });

  it("maps crate, self and super paths best-effort", () => {
    expect(r("src/lib.rs", "crate::parser::lexer::Token")).toEqual(["src/parser/lexer.rs"]);
    expect(r("src/net/http.rs", "super::super::parser::parse")).toEqual(["src/parser.rs"]);
    expect(r("src/parser/lexer.rs", "super::parse")).toEqual(["src/parser.rs"]);
    expect(r("src/net/mod.rs", "self::http::get")).toEqual(["src/net/http.rs"]);
    expect(r("src/lib.rs", "std::io")).toEqual([]);
  });
});

describe("resolve: Ruby", () => {
  const r = resolverFor({ "app/helpers/format.rb": "", "lib/thing.rb": "" });

  it("resolves require_relative and lib/ requires", () => {
    expect(r("app/x.rb", "./helpers/format")).toEqual(["app/helpers/format.rb"]);
    expect(r("app/x.rb", "../lib/thing")).toEqual(["lib/thing.rb"]);
    expect(r("app/x.rb", "thing")).toEqual(["lib/thing.rb"]);
    expect(r("app/x.rb", "json")).toEqual([]);
  });
});
