import { afterEach, describe, expect, it } from "vitest";
import { createBlobReader, readBlobs } from "../../src/git/blobs.js";
import { makeRepo, type TestRepo } from "../helpers/repo.js";

let repo: TestRepo;
afterEach(() => repo?.cleanup());

describe("createBlobReader", () => {
  it("returns undefined for a path with a newline without desyncing the other reads", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "AAA\n", "evil\nx.ts": "EVIL\n", "cr\rx.ts": "CR\n", "b.ts": "BBB\n", "c.ts": "CCC\n" }, "init");
    const read = createBlobReader(repo.dir);
    const names = ["a.ts", "evil\nx.ts", "cr\rx.ts", "b.ts", "c.ts"];
    expect(await Promise.all(names.map((n) => read("HEAD", n)))).toEqual(["AAA\n", undefined, undefined, "BBB\n", "CCC\n"]);
  });

  it("treats a missing path whose name looks like a blob header as missing", async () => {
    repo = makeRepo();
    repo.commit({ "a.ts": "AAA\n", "b.ts": "BBB\n" }, "init");
    const read = createBlobReader(repo.dir);
    expect(await Promise.all(["nope 1 5", "a.ts", "b.ts"].map((n) => read("HEAD", n)))).toEqual([undefined, "AAA\n", "BBB\n"]);
  });
});

describe("readBlobs", () => {
  // 20 MB already took ~0.3 s with quadratic buffering; 100 MB makes the difference unmistakable (~8 s vs ~0.5 s).
  it("streams a 100 MB blob in linear time", async () => {
    repo = makeRepo();
    const big = "x".repeat(100 * 1024 * 1024);
    repo.commit({ "big.txt": big, "small.txt": "s\n" }, "init");
    const shas = [repo.git("rev-parse", "HEAD:big.txt"), repo.git("rev-parse", "HEAD:small.txt")];
    const sizes: number[] = [];
    const start = Date.now();
    await readBlobs(repo.dir, shas, (i, content) => (sizes[i] = content.length));
    expect(Date.now() - start).toBeLessThan(3000);
    expect(sizes).toEqual([big.length, 2]);
  }, 60_000);
});
