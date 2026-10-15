import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OpendrsConfig } from "../domain/config.js";
import type { DependencyGraph } from "../domain/types.js";
import { git } from "../git/exec.js";
import { matchAny } from "../git/glob.js";
import { extractImports, languageOf } from "./imports.js";
import { baseName } from "./path-util.js";
import { createResolver } from "./resolve.js";
import { listTree, readBlobs } from "./tree.js";

const MAX_FILE_BYTES = 1024 * 1024;
const CACHE_VERSION = 1;
/** Files the resolvers read for aliases, workspace names and module paths. */
const CONFIG_FILES = new Set(["package.json", "tsconfig.json", "jsconfig.json", "go.mod"]);

export interface RepoGraph extends DependencyGraph {
  /** Files in the graph vs. non-ignored files in the tree (they differ when graph.maxFiles is hit). */
  coverage: { files: number; total: number };
}

interface GraphData {
  version: number;
  /** Config that shaped the graph; a mismatch invalidates the cache. */
  key: string;
  total: number;
  /** Covered files, sorted by path. */
  files: string[];
  /** Forward edges: edges[i] = indexes of the files that files[i] imports. */
  edges: number[][];
}

/** Build the reverse import graph of the tree at `ref` (cached by tree sha under .opendrs/cache). */
export async function buildDependencyGraph(repoDir: string, ref: string, config: OpendrsConfig): Promise<RepoGraph> {
  const treeSha = (await git(repoDir, ["rev-parse", `${ref}^{tree}`])).trim();
  const key = JSON.stringify({ ignore: config.paths.ignore, maxFiles: config.graph.maxFiles });
  const cacheFile = join(repoDir, ".opendrs", "cache", `graph-${treeSha}.json`);

  const cached = await readCache(cacheFile, key);
  if (cached) return toGraph(cached);
  const data = await computeGraph(repoDir, treeSha, config, key);
  await writeCache(cacheFile, data);
  return toGraph(data);
}

async function computeGraph(repoDir: string, treeSha: string, config: OpendrsConfig, key: string): Promise<GraphData> {
  const all = (await listTree(repoDir, treeSha))
    .filter((e) => !matchAny(config.paths.ignore, e.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const covered = all.slice(0, config.graph.maxFiles);
  const files = covered.map((e) => e.path);

  const toRead = covered.filter((e) => e.size <= MAX_FILE_BYTES && (languageOf(e.path) || CONFIG_FILES.has(baseName(e.path))));
  const specs = new Map<string, string[]>();
  const contents = new Map<string, string>();
  await readBlobs(
    repoDir,
    toRead.map((e) => e.sha),
    (i, buf) => {
      if (buf.subarray(0, 8000).includes(0)) return; // binary, as git decides
      const path = toRead[i]!.path;
      const text = buf.toString("utf8");
      const lang = languageOf(path);
      if (lang) specs.set(path, extractImports(path, text));
      if (!lang || lang === "java" || lang === "kotlin") contents.set(path, text);
    },
  );

  const resolve = createResolver(files, contents);
  const index = new Map(files.map((f, i) => [f, i]));
  const edges = files.map((from) => {
    const targets = new Set<number>();
    for (const spec of specs.get(from) ?? []) for (const to of resolve(from, spec)) targets.add(index.get(to)!);
    return [...targets];
  });
  return { version: CACHE_VERSION, key, total: all.length, files, edges };
}

function toGraph(data: GraphData): RepoGraph {
  const { files, edges } = data;
  const index = new Map(files.map((f, i) => [f, i]));
  const reverse: number[][] = files.map(() => []);
  edges.forEach((targets, from) => {
    for (const to of targets) reverse[to]!.push(from);
  });
  const lastCovered = files[files.length - 1];
  const truncated = files.length < data.total;

  return {
    fileCount: files.length,
    coverage: { files: files.length, total: data.total },
    dependentsOf(path) {
      const i = index.get(path);
      return i === undefined ? [] : reverse[i]!.map((j) => files[j]!);
    },
    transitiveDependents(path, maxDepth) {
      const start = index.get(path);
      const seen = new Set<number>(start === undefined ? [] : [start]);
      let frontier = start === undefined ? [] : [start];
      for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
        const next: number[] = [];
        for (const i of frontier) {
          for (const j of reverse[i]!) {
            if (!seen.has(j)) {
              seen.add(j);
              next.push(j);
            }
          }
        }
        frontier = next;
      }
      if (start !== undefined) seen.delete(start);
      return new Set([...seen].map((i) => files[i]!));
    },
    supports(path) {
      // Paths past the maxFiles cut-off were never parsed, so their edges are unknown.
      return languageOf(path) !== undefined && !(truncated && lastCovered !== undefined && path > lastCovered);
    },
  };
}

async function readCache(file: string, key: string): Promise<GraphData | undefined> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as GraphData;
    const n = data.files.length;
    const valid =
      data.version === CACHE_VERSION &&
      data.key === key &&
      typeof data.total === "number" &&
      data.edges.length === n &&
      data.edges.every((targets) => targets.every((t) => Number.isInteger(t) && t >= 0 && t < n));
    return valid ? data : undefined;
  } catch {
    return undefined;
  }
}

/** Best-effort: a read-only checkout must still score. Rename keeps readers from seeing a partial file. */
async function writeCache(file: string, data: GraphData): Promise<void> {
  try {
    await mkdir(join(file, ".."), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  } catch {
    // ignore: the cache is an optimisation only
  }
}
