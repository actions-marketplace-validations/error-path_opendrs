import type { ArchitectureFact, ScoringContext } from "../domain/types.js";
import { buildDependencyGraph, type RepoGraph } from "../graph/graph.js";
import { languageOf } from "../graph/imports.js";
import { baseName, dirOf } from "../graph/path-util.js";
import { untrusted } from "../report/escape.js";
import { isTestPath } from "../signals/tests.js";
import type { Detector } from "./index.js";
import { moduleOf } from "./module.js";

type Adjacency = Map<string, Set<string>>;

/** Module-to-module edges of a graph, excluding intra-module edges and edges imported only by a test file. */
function moduleAdjacency(graph: RepoGraph, depth: number, isTest: (path: string) => boolean): Adjacency {
  const adjacency: Adjacency = new Map();
  for (const file of graph.files) {
    if (isTest(file)) continue;
    const from = moduleOf(file, depth);
    for (const target of graph.importsOf(file)) {
      const to = moduleOf(target, depth);
      if (to === from) continue;
      if (!adjacency.has(from)) adjacency.set(from, new Set());
      adjacency.get(from)!.add(to);
    }
  }
  return adjacency;
}

/** The first file (by path order) in `from` that imports into `to`, and which of its targets land there. */
function firstEdgeFile(graph: RepoGraph, depth: number, isTest: (path: string) => boolean, from: string, to: string): { file: string; targets: string[] } | undefined {
  for (const file of graph.files) {
    if (isTest(file)) continue;
    if (moduleOf(file, depth) !== from) continue;
    const targets = graph.importsOf(file).filter((t) => moduleOf(t, depth) === to);
    if (targets.length > 0) return { file, targets };
  }
  return undefined;
}

/** The import's resolved target, as the specifier text written in source would likely read: "<parent dir>/<stem>". */
function specifierStem(targetFile: string): string {
  const stem = baseName(targetFile).replace(/\.[^./]+$/, "");
  const dir = dirOf(targetFile);
  const parent = dir.includes("/") ? dir.slice(dir.lastIndexOf("/") + 1) : dir;
  return parent ? `${parent}/${stem}` : stem;
}

/** First line (1-based) of the importer's head content naming one of `targets`; undefined if not found. */
async function findImportLine(ctx: ScoringContext, file: string, targets: string[]): Promise<number | undefined> {
  const content = await ctx.readHead(file);
  if (content === undefined) return undefined;
  const stems = targets.map(specifierStem);
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (stems.some((stem) => lines[i]!.includes(stem))) return i + 1;
  }
  return undefined;
}

async function edgeFact(ctx: ScoringContext, depth: number, isTest: (path: string) => boolean, head: RepoGraph, from: string, to: string): Promise<ArchitectureFact | undefined> {
  const found = firstEdgeFile(head, depth, isTest, from, to);
  if (!found) return undefined;
  const line = await findImportLine(ctx, found.file, found.targets);
  const where = line !== undefined ? `${found.file}:${line}` : found.file;
  return { id: "layers.edge", weight: "strong", file: found.file, line, text: `\`${untrusted(from)}\` now imports \`${untrusted(to)}\` for the first time (\`${untrusted(where)}\`).` };
}

/** Tarjan's algorithm: strongly connected components of `adjacency`, as arrays of member nodes. */
function stronglyConnectedComponents(adjacency: Adjacency): string[][] {
  const nodes = new Set<string>();
  for (const [from, tos] of adjacency) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  function connect(v: string): void {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of adjacency.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }
    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      result.push(component);
    }
  }

  for (const v of nodes) if (!index.has(v)) connect(v);
  return result;
}

/** Shortest cycle through `start` within `members`, as a path starting and ending at `start`. */
function shortestCycle(start: string, members: Set<string>, adjacency: Adjacency): string[] {
  const prev = new Map<string, string>();
  const dist = new Map<string, number>([[start, 0]]);
  const queue = [start];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const w of adjacency.get(v) ?? []) {
      if (!members.has(w) || dist.has(w)) continue;
      dist.set(w, dist.get(v)! + 1);
      prev.set(w, v);
      queue.push(w);
    }
  }
  let best: string | undefined;
  let bestLen = Infinity;
  for (const v of members) {
    if (v === start || !dist.has(v) || !(adjacency.get(v) ?? new Set()).has(start)) continue;
    const len = dist.get(v)! + 1;
    if (len < bestLen) {
      bestLen = len;
      best = v;
    }
  }
  if (best === undefined) return [start];
  const path = [best];
  for (let cur = best; cur !== start; ) {
    cur = prev.get(cur)!;
    path.push(cur);
  }
  path.reverse();
  path.push(start);
  return path;
}

async function cycleFact(ctx: ScoringContext, depth: number, isTest: (path: string) => boolean, head: RepoGraph, members: string[], adjacency: Adjacency): Promise<ArchitectureFact> {
  const start = [...members].sort()[0]!;
  const path = shortestCycle(start, new Set(members), adjacency);
  const found = firstEdgeFile(head, depth, isTest, path[0]!, path[1]!);
  const line = found ? await findImportLine(ctx, found.file, found.targets) : undefined;
  const file = found?.file ?? path[0]!;
  const text = `New import cycle: ${path.map((m) => `\`${untrusted(m)}\``).join(" → ")}.`;
  return { id: "layers.cycle", weight: "strong", file, line, text };
}

/** Spec §6.2: new module-level import edges and cycles between the dependency graphs at base and head. */
export const detectLayers: Detector = async (ctx) => {
  const { config, diff } = ctx;
  if (!config.graph.enabled) return { facts: [], notes: ["layers: graph.enabled is false"] };

  const changedFiles = diff.files.filter((f) => !f.ignored);
  if (!changedFiles.some((f) => languageOf(f.path) !== undefined)) {
    return { facts: [], notes: ["layers: no changed file is in a supported language"] };
  }

  const [base, head] = await Promise.all([buildDependencyGraph(ctx.repoDir, diff.base, config), buildDependencyGraph(ctx.repoDir, diff.head, config)]);
  if (base.coverage.files < base.coverage.total || head.coverage.files < head.coverage.total) {
    return { facts: [], notes: ["layers: repository is larger than graph.maxFiles"] };
  }

  const depth = config.captain.moduleDepth;
  const isTest = (path: string) => isTestPath(config, path);
  const baseAdjacency = moduleAdjacency(base, depth, isTest);
  const headAdjacency = moduleAdjacency(head, depth, isTest);

  const edgeFacts = await Promise.all(
    [...headAdjacency].flatMap(([from, tos]) => [...tos].filter((to) => !baseAdjacency.get(from)?.has(to)).map((to) => edgeFact(ctx, depth, isTest, head, from, to))),
  );

  const baseSccId = new Map<string, number>();
  stronglyConnectedComponents(baseAdjacency).forEach((component, i) => component.forEach((m) => baseSccId.set(m, i)));
  const newCycles = stronglyConnectedComponents(headAdjacency).filter((component) => component.length >= 2 && !component.every((m) => baseSccId.has(m) && baseSccId.get(m) === baseSccId.get(component[0]!)));
  const cycleFacts = await Promise.all(newCycles.map((component) => cycleFact(ctx, depth, isTest, head, component, headAdjacency)));

  const facts = [...edgeFacts, ...cycleFacts].filter((f): f is ArchitectureFact => f !== undefined);
  return { facts, notes: [] };
};
