import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, parseConfig } from "../../src/domain/config.js";
import { buildDependencyGraph } from "../../src/graph/graph.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

const repos: TestRepo[] = [];
function repo(): TestRepo {
  const r = makeRepo();
  repos.push(r);
  return r;
}
afterEach(() => {
  while (repos.length) repos.pop()!.cleanup();
});

const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("buildDependencyGraph: multi-language fixture", () => {
  it("links TS (relative, tsconfig alias), Go, Python, Java, Rust and Ruby imports", async () => {
    const r = repo();
    r.commit(
      {
        "tsconfig.json": `{ "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["web/lib/*"] } } }`,
        "web/lib/format.ts": "export const fmt = (x: number) => String(x);\n",
        "web/app.ts": 'import { fmt } from "@lib/format";\nimport { page } from "./page.js";\n',
        "web/page.ts": "// import { fmt } from '@lib/format';\nexport const page = 1;\n",
        "go.mod": "module example.com/shop\n\ngo 1.22\n",
        "pkg/cart/cart.go": "package cart\n\nfunc Total() int { return 1 }\n",
        "cmd/main.go": 'package main\n\nimport (\n\t"fmt"\n\t"example.com/shop/pkg/cart"\n)\n\nfunc main() { fmt.Println(cart.Total()) }\n',
        "app/__init__.py": "",
        "app/models.py": "class User: pass\n",
        "app/views.py": "from .models import User\n",
        "src/main/java/com/acme/Util.java": "package com.acme;\npublic class Util {}\n",
        "src/main/java/com/acme/app/Main.java": "package com.acme.app;\nimport com.acme.Util;\nclass Main {}\n",
        "Cargo.toml": '[package]\nname = "x"\n',
        "src/lib.rs": "mod parser;\n",
        "src/parser.rs": "use crate::lib_helpers;\npub fn parse() {}\n",
        "lib/thing.rb": "class Thing; end\n",
        "bin/run.rb": 'require_relative "../lib/thing"\n',
        "README.md": "docs\n",
      },
      "fixture",
    );
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());

    expect(g.dependentsOf("web/lib/format.ts")).toEqual(["web/app.ts"]);
    expect(g.dependentsOf("web/page.ts")).toEqual(["web/app.ts"]);
    expect(g.dependentsOf("pkg/cart/cart.go")).toEqual(["cmd/main.go"]);
    expect(g.dependentsOf("app/models.py")).toEqual(["app/views.py"]);
    expect(g.dependentsOf("src/main/java/com/acme/Util.java")).toEqual(["src/main/java/com/acme/app/Main.java"]);
    expect(g.dependentsOf("src/parser.rs")).toEqual(["src/lib.rs"]);
    expect(g.dependentsOf("lib/thing.rb")).toEqual(["bin/run.rb"]);
    expect(g.dependentsOf("web/app.ts")).toEqual([]);
    expect(g.supports("web/app.ts")).toBe(true);
    expect(g.supports("README.md")).toBe(false);
    expect(g.fileCount).toBe(18);
  });
});

describe("buildDependencyGraph: traversal", () => {
  it("limits transitive dependents by depth, excludes self and survives cycles", async () => {
    const r = repo();
    r.commit(
      {
        "d.ts": "export const d = 1;\n",
        "c.ts": 'import "./d";\n',
        "b.ts": 'import "./c";\n',
        "a.ts": 'import "./b";\n',
        "x.ts": 'import "./y";\nimport "./d";\n',
        "y.ts": 'import "./x";\n',
      },
      "chain and cycle",
    );
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());

    expect(sorted(g.dependentsOf("d.ts"))).toEqual(["c.ts", "x.ts"]);
    expect(sorted(g.transitiveDependents("d.ts", 1))).toEqual(["c.ts", "x.ts"]);
    expect(sorted(g.transitiveDependents("d.ts", 2))).toEqual(["b.ts", "c.ts", "x.ts", "y.ts"]);
    expect(sorted(g.transitiveDependents("d.ts", 3))).toEqual(["a.ts", "b.ts", "c.ts", "x.ts", "y.ts"]);
    expect(sorted(g.transitiveDependents("x.ts", 10))).toEqual(["y.ts"]);
    expect(g.transitiveDependents("missing.ts", 3).size).toBe(0);
  });
});

describe("buildDependencyGraph: skipped files", () => {
  it("does not parse ignored, binary or oversized files", async () => {
    const r = repo();
    r.commit(
      {
        "lib.ts": "export const x = 1;\n",
        "dist/bundle.js": 'require("../lib");\n',
        "blob.js": `require("./lib");\u0000binary`,
        "huge.js": `require("./lib");\n${"// pad\n".repeat(160_000)}`,
        "ok.js": 'require("./lib");\n',
      },
      "skips",
    );
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(g.dependentsOf("lib.ts")).toEqual(["ok.js"]);
  });

  it("builds a partial graph over the first maxFiles paths and reports coverage", async () => {
    const r = repo();
    r.commit({ "a.ts": 'import "./c";\n', "b.ts": 'import "./c";\n', "c.ts": "", "d.ts": 'import "./c";\n' }, "four");
    const config = parseConfig({ graph: { maxFiles: 3 } });
    const g = await buildDependencyGraph(r.dir, "HEAD", config);

    expect(g.coverage).toEqual({ files: 3, total: 4 });
    expect(g.fileCount).toBe(3);
    expect(sorted(g.dependentsOf("c.ts"))).toEqual(["a.ts", "b.ts"]);
    expect(g.supports("c.ts")).toBe(true);
    expect(g.supports("d.ts")).toBe(false);
  });
});

describe("buildDependencyGraph: cache", () => {
  const cachePath = (r: TestRepo) => join(r.dir, ".opendrs", "cache", `graph-${r.git("rev-parse", "HEAD^{tree}")}.json`);

  it("writes the graph keyed by tree sha and loads it on the next build", async () => {
    const r = repo();
    r.commit({ "a.ts": 'import "./b";\n', "b.ts": "" }, "init");
    await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    const path = cachePath(r);
    expect(existsSync(path)).toBe(true);

    // Prove the second build reads the cache: blank out its edges and observe the effect.
    const cached = JSON.parse(readFileSync(path, "utf8")) as { edges: number[][] };
    cached.edges = cached.edges.map(() => []);
    writeFileSync(path, JSON.stringify(cached));
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(g.dependentsOf("b.ts")).toEqual([]);
  });

  it("rebuilds when the tree changes or the graph config changes", async () => {
    const r = repo();
    r.commit({ "a.ts": 'import "./b";\n', "b.ts": "" }, "init");
    const g1 = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(g1.dependentsOf("b.ts")).toEqual(["a.ts"]);

    r.commit({ "c.ts": 'import "./b";\n' }, "add c");
    const g2 = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(sorted(g2.dependentsOf("b.ts"))).toEqual(["a.ts", "c.ts"]);

    const ignoringC = parseConfig({ paths: { ignore: ["c.ts"] } });
    const g3 = await buildDependencyGraph(r.dir, "HEAD", ignoringC);
    expect(g3.dependentsOf("b.ts")).toEqual(["a.ts"]);
  });

  it("treats a corrupt cache as a miss", async () => {
    const r = repo();
    r.commit({ "a.ts": 'import "./b";\n', "b.ts": "" }, "init");
    await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    writeFileSync(cachePath(r), "{ not json");
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(g.dependentsOf("b.ts")).toEqual(["a.ts"]);
  });

  it("reads the tree at the given ref, not the working copy", async () => {
    const r = repo();
    const first = r.commit({ "a.ts": 'import "./b";\n', "b.ts": "" }, "init");
    r.commit({ "a.ts": "" }, "drop import");
    const g = await buildDependencyGraph(r.dir, first, defaultConfig());
    expect(g.dependentsOf("b.ts")).toEqual(["a.ts"]);
  });
});
