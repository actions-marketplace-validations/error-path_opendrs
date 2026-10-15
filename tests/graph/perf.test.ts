import { afterAll, describe, expect, it } from "vitest";
import { defaultConfig } from "../../src/domain/config.js";
import { buildDependencyGraph } from "../../src/graph/graph.js";
import { makeRepo } from "../helpers/repo.js";

describe("buildDependencyGraph: performance", () => {
  const r = makeRepo();
  afterAll(() => r.cleanup());

  it("builds a ~5k-file mixed-language graph well within budget", { timeout: 120_000 }, async () => {
    const files: Record<string, string> = { "go.mod": "module example.com/big\n" };
    const body = "export function f(x: number): number {\n  // some body text to read\n  return x * 2;\n}\n".repeat(20);
    for (let i = 0; i < 3000; i++) {
      const dir = `web/m${Math.floor(i / 50)}`;
      const imports = [i - 1, i - 7, i - 31].filter((j) => j >= 0).map((j) => `import { f } from "../m${Math.floor(j / 50)}/f${j}";`);
      files[`${dir}/f${i}.ts`] = `${imports.join("\n")}\n${body}`;
    }
    for (let i = 0; i < 1000; i++) {
      files[`py/p${Math.floor(i / 40)}/m${i}.py`] = `${i > 0 ? `from py.p${Math.floor((i - 1) / 40)}.m${i - 1} import thing\n` : ""}def thing():\n    return ${i}\n`;
    }
    for (let i = 0; i < 1000; i++) {
      const prev = i > 0 ? `import "example.com/big/pkg/p${Math.floor((i - 1) / 10)}"\n` : "";
      files[`pkg/p${Math.floor(i / 10)}/g${i}.go`] = `package p${Math.floor(i / 10)}\n\n${prev}\nfunc G${i}() {}\n`;
    }
    r.commit(files, "big tree");

    const started = performance.now();
    const g = await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    const coldMs = performance.now() - started;

    expect(g.fileCount).toBe(5001);
    expect(g.dependentsOf("web/m0/f0.ts").sort()).toEqual(["web/m0/f1.ts", "web/m0/f31.ts", "web/m0/f7.ts"]);
    expect(g.transitiveDependents("web/m0/f0.ts", 3).size).toBeGreaterThan(10);
    expect(coldMs).toBeLessThan(10_000);

    const warmStarted = performance.now();
    await buildDependencyGraph(r.dir, "HEAD", defaultConfig());
    expect(performance.now() - warmStarted).toBeLessThan(coldMs);
    console.log(`graph build: cold ${coldMs.toFixed(0)} ms, warm ${(performance.now() - warmStarted).toFixed(0)} ms`);
  });
});
