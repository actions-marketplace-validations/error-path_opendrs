/**
 * Captain-fact lift experiment (spec §10.2 of docs/specs/2026-10-19-captain-brief-design.md): does
 * `contract.dependency`, `contract.api`, `contract.schema` or `layers.edge` predict ApacheJIT bugs
 * enough to claim it in the docs (they ship regardless, as decisions to sign off on), and do the
 * [rejected review-heuristic signals](../../docs/experiments.md#review-heuristic-signals)
 * (`change.concurrency`, `change.safety_removed`, `tests.weakened`) qualify as captain facts on the
 * full test split?
 *
 * Pre-registered in docs/experiments.md ("Planned: captain-fact lift on ApacheJIT") before this ran.
 *
 * `contract.dependency`, `contract.api`, `contract.schema` and the three review signals are computed
 * on the full pooled test split (24,686 commits, `apache/hadoop` excluded), from one
 * `git log --no-walk --stdin -p --no-renames -U0` stream per repository (never one spawn per
 * commit): `parseUnifiedDiff` and `changedLines` (the shipped parser) turn that stream's patches
 * into the same `ChangedFile[]` the real detectors see. `layers.edge` needs a real dependency graph
 * at base and head, too slow for 24,686 commits, so it runs on a fixed random sample of 2,000 test
 * commits (seed recorded below) as the spec allows.
 *
 * `contract.api`'s dependents (spec §6.3: a removed/changed declaration only counts with a
 * dependent) are approximated rather than read from the real per-commit import graph: one `git
 * grep` pass per repository, at the project's pinned 2019 head, indexes every `import` line once;
 * see `buildImportIndex`/`dependentsOf` below. This is the same kind of single-snapshot
 * approximation the benchmark's own CAVEATS already use for the real import graph.
 *
 * Run `npm run build` first, then `node bench/apachejit/captain-lift-experiment.ts`. Deletes its
 * clones when it finishes (`--keep-clones` to skip that, for a re-run while iterating).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { addedPackages, isManifestPath } from "../../dist/architecture/manifests.js";
import { moduleOf } from "../../dist/architecture/module.js";
import { defaultConfig } from "../../dist/domain/config.js";
import type { ChangedFile } from "../../dist/domain/types.js";
import { buildDependencyGraph } from "../../dist/graph/graph.js";
import { isPublicDeclaration } from "../../dist/graph/public-decl.js";
import { changedLines, parseUnifiedDiff } from "../../dist/git/diff.js";
import { matchAny } from "../../dist/git/glob.js";
import { mulberry32 } from "../../dist/model/fit.js";
import { isCodeFamily, languageFamily } from "../../dist/signals/language.js";
import { isTestPath } from "../../dist/signals/tests.js";
import { parseApacheJit, PROJECTS } from "./lib.ts";
import type { Project } from "./lib.ts";
import { ALSO_IN, ensureDataset } from "./run.ts";

const WORK_DIR = join(homedir(), ".cache", "opendrs", "apachejit");
const EXCLUDED_PROJECT = "apache/hadoop"; // no positive labels; every other ApacheJIT table excludes it too.
const LIFT_THRESHOLD = 1.2;
const MIN_FIRES = 50;
const LAYERS_SAMPLE_SIZE = 2000;
const LAYERS_SEED = 20261019; // recorded so the sample is reproducible
const OUT = new URL("./captain-lift-experiment.md", import.meta.url);
const CONFIG = defaultConfig(); // captain.moduleDepth: 2, captain.contracts.paths: [], default schema globs, etc.

/** Spec §6.3 defaults, copied from src/architecture/contracts.ts (not exported). */
const DEFAULT_SCHEMA_GLOBS = ["**/migrations/**", "**/*.sql", "**/schema.prisma", "**/*.proto", "**/*.graphql", "**/openapi*.{yaml,yml,json}", "**/swagger*.{yaml,yml,json}"];
const SCHEMA_GLOBS = [...DEFAULT_SCHEMA_GLOBS, ...CONFIG.captain.contracts.paths];

/**
 * The three rejected review signals' exact regexes, copied verbatim from
 * bench/apachejit/archive/2026-10-18-review-signals.patch (src/signals/change.ts and
 * src/signals/tests.ts there), since that code never merged to main.
 */
const SAFETY =
  /\b(catch|except|rescue|finally)\b|\bthrow\b(?!s)|\braise\b|\bassert\b|[!=]==?\s*(null|nil|None|undefined)\b|\b(null|nil|None|undefined)\s*[!=]==?|\bis (not )?None\b|\bcheck(Argument|State|NotNull|Index|ElementIndex|PositionIndex)\s*\(|\brequireNonNull\s*\(|\bValidate\.\w+\s*\(/;
const CONCURRENCY =
  /\b(synchronized|volatile|ReentrantLock|ReadWriteLock|ReentrantReadWriteLock|StampedLock|Semaphore|CountDownLatch|CyclicBarrier|Phaser|ExecutorService|Executors|ThreadPoolExecutor|ForkJoinPool|CompletableFuture|ConcurrentHashMap|ConcurrentLinkedQueue|BlockingQueue|ThreadLocal|Atomic(Integer|Long|Boolean|Reference)\w*|Mutex|RwLock|RWMutex|WaitGroup|threading|multiprocessing)\b|\bnew Thread\b|\bThread\.(sleep|start|interrupt|yield)\b|\.(wait|notify|notifyAll|lock|unlock|tryLock)\s*\(|\bgo func\b/;
const isCommentLine = (text: string): boolean => /^\s*(\/\/|#|\/\*|\*)/.test(text);
const ASSERTION = /\bassert\w*\s*\(|\bassert\s|\bexpect\s*\(|\bverify\s*\(|\.should\b/;
const SKIP = /@Ignore\b|@Disabled\b|\benabled\s*=\s*false\b|\bpytest\.mark\.skip|@unittest\.skip|\b(xit|xdescribe|xtest)\s*\(|\b(it|test|describe)\.skip\s*\(|\bt\.Skip(Now)?\s*\(/;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function parseOptions(argv: string[]): { keepClones: boolean; projects?: string[] } {
  const { values } = parseArgs({ args: argv, options: { "keep-clones": { type: "boolean", default: false }, projects: { type: "string" } } });
  return { keepClones: values["keep-clones"], projects: values.projects?.split(",").map((s) => s.trim()) };
}

/** Run git, feeding `stdin` if given, with no shell and no line-count limit on the buffered output. */
function git(repoDir: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.quotepath=off", "-c", "color.ui=false", ...args], { cwd: repoDir });
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d: string) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git ${args[0]} failed (${code}): ${err.slice(0, 2000)}`))));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });
}

async function gitMaybe(repoDir: string, args: string[]): Promise<string | undefined> {
  try {
    return await git(repoDir, args);
  } catch {
    return undefined;
  }
}

/** Full `--no-checkout` clone (diffs need blobs): same layout as run.ts's full clones. */
async function ensureFullClone(workDir: string, project: Project): Promise<{ repoDir: string } | { skipped: string }> {
  const repoDir = join(workDir, "repos", project.name);
  if (!existsSync(repoDir)) {
    const partial = `${repoDir}.partial`;
    await rm(partial, { recursive: true, force: true });
    await mkdir(dirname(repoDir), { recursive: true });
    console.error(`${project.name}: cloning ${project.url}`);
    try {
      await git(workDir, ["clone", "-q", "--no-checkout", project.url, partial]);
      // A detached `git gc --auto` on a freshly packed clone can hold a lock while the big `git
      // log --stdin -p` below is running (tests/helpers/repo.ts hits the same race).
      await git(partial, ["config", "gc.auto", "0"]);
      await git(partial, ["config", "maintenance.auto", "false"]);
    } catch (e) {
      return { skipped: `clone failed: ${errorMessage(e)}` };
    }
    await rename(partial, repoDir);
  }
  try {
    await git(repoDir, ["rev-parse", "--verify", `${project.head}^{commit}`]);
  } catch {
    return { skipped: `pinned head ${project.head} not in the clone` };
  }
  return { repoDir };
}

interface TestCommit {
  sha: string;
  project: string; // ApacheJIT's "apache/<name>" value
  label: 0 | 1;
}

/** One commit's parsed diff, plus what `contract.dependency` needs from it. */
interface CommitDiff {
  sha: string;
  files: ChangedFile[];
}

const RECORD = "\0";
const FIELD = "\x1f";
const END = "\x1d";

/** `git log --no-walk --stdin -p`, one spawn, for the given shas (shas not present are silently skipped). */
async function streamDiffs(repoDir: string, shas: string[]): Promise<CommitDiff[]> {
  if (shas.length === 0) return [];
  const out = await git(
    repoDir,
    [
      "log",
      "--no-walk",
      "--ignore-missing",
      "--stdin",
      "-p",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "-U0",
      "--no-show-signature",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "--format=%x00%H%x1f%ct%x1d", // git expands these to the literal RECORD/FIELD/END bytes; argv itself must stay NUL-free
    ],
    shas.join("\n"),
  );
  const commits: CommitDiff[] = [];
  for (const record of out.split(RECORD)) {
    if (!record) continue;
    const end = record.indexOf(END);
    if (end < 0) continue;
    const sha = record.slice(0, end).split(FIELD)[0]!;
    const files = parseUnifiedDiff(record.slice(end + 1)).map((f) => ({ ...f, ignored: matchAny(CONFIG.paths.ignore, f.path) }));
    commits.push({ sha, files });
  }
  return commits;
}

/** Fully-qualified name from a Maven/Gradle-layout path, or undefined when the layout isn't matched. */
function deriveFqn(path: string): string | undefined {
  const m = /^(?:.*\/)?src\/(?:main|test)\/(?:java|kotlin)\/(.+)\.(?:java|kt)$/.exec(path);
  return m ? m[1]!.replace(/\//g, ".") : undefined;
}

function simpleNameOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(/\.(java|kt)$/, "");
}

const JVM_IMPORT = /^import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?;?\s*$/;

/** Approximate "imported by another file" index: one `git grep` pass per repo, at its pinned head. */
interface ImportIndex {
  byFqn: Map<string, Set<string>>;
  byPackage: Map<string, Set<string>>; // wildcard imports: package -> importing files
  bySimpleName: Map<string, Set<string>>; // fallback for paths that don't match the Maven/Gradle layout
}

async function buildImportIndex(repoDir: string, head: string): Promise<ImportIndex> {
  const byFqn = new Map<string, Set<string>>();
  const byPackage = new Map<string, Set<string>>();
  const bySimpleName = new Map<string, Set<string>>();
  const out = await gitMaybe(repoDir, ["grep", "-n", "-E", "^[ \t]*import[ \t]", head, "--", "*.java", "*.kt"]);
  if (out === undefined) return { byFqn, byPackage, bySimpleName };
  const prefix = `${head}:`;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const row = line.startsWith(prefix) ? line.slice(prefix.length) : line;
    const firstColon = row.indexOf(":");
    const secondColon = row.indexOf(":", firstColon + 1);
    if (firstColon < 0 || secondColon < 0) continue;
    const file = row.slice(0, firstColon);
    const text = row.slice(secondColon + 1).trim();
    const m = JVM_IMPORT.exec(text);
    if (!m) continue;
    const isWildcard = /\.\*;?\s*$/.test(text);
    const name = m[1]!;
    if (isWildcard) {
      if (!byPackage.has(name)) byPackage.set(name, new Set());
      byPackage.get(name)!.add(file);
    } else {
      if (!byFqn.has(name)) byFqn.set(name, new Set());
      byFqn.get(name)!.add(file);
      const simple = name.split(".").at(-1)!;
      if (!bySimpleName.has(simple)) bySimpleName.set(simple, new Set());
      bySimpleName.get(simple)!.add(file);
    }
  }
  return index(byFqn, byPackage, bySimpleName);
}
function index(byFqn: Map<string, Set<string>>, byPackage: Map<string, Set<string>>, bySimpleName: Map<string, Set<string>>): ImportIndex {
  return { byFqn, byPackage, bySimpleName };
}

/** Distinct files (other than `path` itself) that approximately import it, per `buildImportIndex`. */
function dependentsOf(idx: ImportIndex, path: string): number {
  const fqn = deriveFqn(path);
  const importers = new Set<string>();
  if (fqn) {
    for (const f of idx.byFqn.get(fqn) ?? []) importers.add(f);
    const pkg = fqn.split(".").slice(0, -1).join(".");
    for (const f of idx.byPackage.get(pkg) ?? []) importers.add(f);
  } else {
    for (const f of idx.bySimpleName.get(simpleNameOf(path)) ?? []) importers.add(f);
  }
  importers.delete(path);
  return importers.size;
}

/** Spec §6.3's "fires": at least one contract.api fact (a removed decl with a dependent, or an added one in a pre-existing file with a dependent). */
function contractApiFires(files: ChangedFile[], idx: ImportIndex): boolean {
  for (const f of files) {
    if (f.binary || f.ignored) continue;
    const basePath = f.path; // --no-renames: oldPath is always undefined here
    const addedDecls: number[] = [];
    const deletedDecls: number[] = [];
    for (const h of f.hunks) {
      for (const { kind, text } of changedLines(h)) {
        if (!isPublicDeclaration(basePath, text)) continue;
        (kind === "+" ? addedDecls : deletedDecls).push(1);
      }
    }
    if (deletedDecls.length > 0) {
      if (dependentsOf(idx, basePath) > 0) return true;
    } else if (addedDecls.length > 0 && f.status !== "added") {
      if (dependentsOf(idx, basePath) > 0) return true;
    }
  }
  return false;
}

/** Spec §6.3's contract.schema: any non-ignored changed file matching the schema/contract globs. */
function contractSchemaFires(files: ChangedFile[]): boolean {
  return files.some((f) => !f.ignored && matchAny(SCHEMA_GLOBS, f.path));
}

/** The three review signals, each a plain 0/1 "fires", from the commit's non-ignored files. */
function reviewSignalFires(files: ChangedFile[]): { concurrency: boolean; safetyRemoved: boolean; testsWeakened: boolean } {
  const counted = files.filter((f) => !f.ignored);
  const tests = counted.filter((f) => isTestPath(CONFIG, f.path));
  const codeFiles = counted.filter((f) => !f.binary && isCodeFamily(languageFamily(f.path)) && !isTestPath(CONFIG, f.path));

  let concurrency = false;
  let safetyRemovedCount = 0;
  for (const f of codeFiles) {
    for (const h of f.hunks) {
      const deletedSafety: number[] = [];
      let addedSafety = 0;
      for (const { kind, text } of changedLines(h)) {
        if (isCommentLine(text)) continue;
        if (CONCURRENCY.test(text)) concurrency = true;
        if (!SAFETY.test(text)) continue;
        if (kind === "-") deletedSafety.push(1);
        else addedSafety++;
      }
      safetyRemovedCount += Math.max(0, deletedSafety.length - addedSafety);
    }
  }

  let netAsserts = 0;
  let hasSkip = false;
  for (const f of tests) {
    for (const h of f.hunks) {
      for (const { kind, text } of changedLines(h)) {
        if (ASSERTION.test(text)) netAsserts += kind === "-" ? 1 : -1;
        if (kind === "+" && SKIP.test(text)) hasSkip = true;
      }
    }
  }

  return { concurrency, safetyRemoved: safetyRemovedCount > 0, testsWeakened: netAsserts > 0 || hasSkip };
}

/** contract.dependency: a new runtime or dev package in a changed pom.xml/build.gradle(.kts), read as full before/after text. */
async function contractDependencyFires(repoDir: string, sha: string, files: ChangedFile[]): Promise<boolean | "parse-error"> {
  const manifestPaths = files.filter((f) => !f.ignored && isManifestPath(f.path)).map((f) => f.path);
  if (manifestPaths.length === 0) return false;
  for (const path of manifestPaths) {
    const headText = await gitMaybe(repoDir, ["show", `${sha}:${path}`]);
    if (headText === undefined) continue; // deleted manifest: nothing new to add
    const baseText = await gitMaybe(repoDir, ["show", `${sha}^:${path}`]);
    const result = addedPackages(path, baseText, headText);
    if ("error" in result) continue; // logged as a note in the report, not a fire
    if (result.runtime.length > 0 || result.dev.length > 0) return true;
  }
  return false;
}

interface LiftStats {
  fires: number;
  total: number;
  buggyWhenFires: number;
  positives: number;
}
const emptyStats = (): LiftStats => ({ fires: 0, total: 0, buggyWhenFires: 0, positives: 0 });
function record(s: LiftStats, fired: boolean, label: 0 | 1): void {
  s.total++;
  if (label === 1) s.positives++;
  if (fired) {
    s.fires++;
    if (label === 1) s.buggyWhenFires++;
  }
}
const lift = (s: LiftStats): number => (s.fires === 0 || s.positives === 0 ? NaN : s.buggyWhenFires / s.fires / (s.positives / s.total));
const qualifies = (s: LiftStats): boolean => s.fires >= MIN_FIRES && Number.isFinite(lift(s)) && lift(s) >= LIFT_THRESHOLD;

const csv = async (file: string): Promise<ReturnType<typeof parseApacheJit>> => parseApacheJit(await readFile(join(WORK_DIR, "data", file), "utf8"));

async function main(): Promise<void> {
  const opts = parseOptions(process.argv.slice(2));
  console.error("loading dataset");
  await ensureDataset(WORK_DIR);
  const testCsv = (await csv("apachejit_test_large.csv")).filter((r) => r.project !== EXCLUDED_PROJECT);

  const pooledProjects = PROJECTS.filter((p) => p.project !== EXCLUDED_PROJECT && (!opts.projects || opts.projects.includes(p.name)));
  const names = new Set(pooledProjects.map((p) => p.name));
  if (pooledProjects.some((p) => p.name in ALSO_IN)) names.add("hadoop"); // needed for the hdfs/mapreduce fallback

  console.error(`cloning ${names.size} repositories`);
  const repoDirs = new Map<string, string>();
  const cloneWarnings: string[] = [];
  for (const name of names) {
    const project = PROJECTS.find((p) => p.name === name)!;
    const clone = await ensureFullClone(WORK_DIR, project);
    if ("skipped" in clone) {
      cloneWarnings.push(`${name}: ${clone.skipped}`);
      console.error(`${name}: skipped, ${clone.skipped}`);
      continue;
    }
    repoDirs.set(name, clone.repoDir);
  }

  const importIndexes = new Map<string, ImportIndex>();
  async function importIndexFor(name: string): Promise<ImportIndex> {
    let idx = importIndexes.get(name);
    if (!idx) {
      const project = PROJECTS.find((p) => p.name === name)!;
      console.error(`${name}: indexing imports (git grep pass)`);
      idx = await buildImportIndex(repoDirs.get(name)!, project.head);
      importIndexes.set(name, idx);
    }
    return idx;
  }

  const mainStats = {
    contractDependency: emptyStats(),
    contractApi: emptyStats(),
    contractSchema: emptyStats(),
    changeConcurrency: emptyStats(),
    changeSafetyRemoved: emptyStats(),
    testsWeakened: emptyStats(),
  };
  const dependencyParseErrors: string[] = [];
  const resolvedShas = new Set<string>(); // for the layers.edge sample
  const repoForSha = new Map<string, string>(); // which repo (own or fallback) actually resolved each sha
  const unresolvedByProject: Record<string, number> = {};
  const commitsByProject = new Map<string, TestCommit[]>();
  const pooledTestCsv = testCsv.filter((row) => pooledProjects.some((p) => p.name === row.project.replace("apache/", "")));
  for (const row of pooledTestCsv) {
    const name = row.project.replace("apache/", "");
    const list = commitsByProject.get(name) ?? [];
    list.push({ sha: row.sha, project: row.project, label: row.buggy });
    commitsByProject.set(name, list);
  }

  async function processCommits(repoName: string, commits: TestCommit[]): Promise<TestCommit[]> {
    const repoDir = repoDirs.get(repoName);
    if (!repoDir || commits.length === 0) return [];
    const idx = await importIndexFor(repoName);
    const diffs = await streamDiffs(repoDir, commits.map((c) => c.sha));
    const diffBySha = new Map(diffs.map((d) => [d.sha, d.files]));
    const resolved: TestCommit[] = [];
    for (const c of commits) {
      const files = diffBySha.get(c.sha);
      if (!files) continue;
      resolved.push(c);
      resolvedShas.add(c.sha);
      repoForSha.set(c.sha, repoName);
      const schema = contractSchemaFires(files);
      const api = contractApiFires(files, idx);
      const review = reviewSignalFires(files);
      record(mainStats.contractSchema, schema, c.label);
      record(mainStats.contractApi, api, c.label);
      record(mainStats.changeConcurrency, review.concurrency, c.label);
      record(mainStats.changeSafetyRemoved, review.safetyRemoved, c.label);
      record(mainStats.testsWeakened, review.testsWeakened, c.label);
      const dep = await contractDependencyFires(repoDir, c.sha, files);
      if (dep === "parse-error") dependencyParseErrors.push(c.sha);
      else record(mainStats.contractDependency, dep, c.label);
    }
    return resolved;
  }

  // Own repo first; shas not found there (hadoop-hdfs/hadoop-mapreduce, pre-2011 mirrors) fall back to apache/hadoop.
  const processWarnings: string[] = [];
  const fallbackQueues = new Map<string, TestCommit[]>(); // fallback repo name -> leftover commits
  for (const [name, commits] of commitsByProject) {
    if (!repoDirs.has(name)) {
      unresolvedByProject[name] = (unresolvedByProject[name] ?? 0) + commits.length;
      continue;
    }
    console.error(`${name}: streaming diffs for ${commits.length} test commits`);
    let resolved: TestCommit[] = [];
    try {
      resolved = await processCommits(name, commits);
    } catch (e) {
      // One project's git failure should not lose the other 13's results on a multi-hour run.
      processWarnings.push(`${name}: diff streaming failed, its commits are unresolved: ${errorMessage(e)}`);
      console.error(`${name}: FAILED, skipping: ${errorMessage(e)}`);
    }
    const resolvedSet = new Set(resolved.map((c) => c.sha));
    const missing = commits.filter((c) => !resolvedSet.has(c.sha));
    const fallback = ALSO_IN[name];
    if (fallback && missing.length > 0) {
      const q = fallbackQueues.get(fallback) ?? [];
      q.push(...missing);
      fallbackQueues.set(fallback, q);
    } else {
      unresolvedByProject[name] = (unresolvedByProject[name] ?? 0) + missing.length;
    }
  }
  for (const [fallbackName, commits] of fallbackQueues) {
    console.error(`${fallbackName} (fallback): streaming diffs for ${commits.length} commits`);
    let resolved: TestCommit[] = [];
    try {
      resolved = await processCommits(fallbackName, commits);
    } catch (e) {
      processWarnings.push(`${fallbackName} (fallback): diff streaming failed, its leftover commits are unresolved: ${errorMessage(e)}`);
      console.error(`${fallbackName} (fallback): FAILED, skipping: ${errorMessage(e)}`);
    }
    const resolvedSet = new Set(resolved.map((c) => c.sha));
    for (const c of commits) {
      if (!resolvedSet.has(c.sha)) {
        const name = c.project.replace("apache/", "");
        unresolvedByProject[name] = (unresolvedByProject[name] ?? 0) + 1;
      }
    }
  }

  // layers.edge on a fixed seeded sample of the resolved test commits.
  console.error(`sampling ${LAYERS_SAMPLE_SIZE} of ${resolvedShas.size} resolved test commits for layers.edge (seed ${LAYERS_SEED})`);
  const allResolved = testCsv.filter((r) => resolvedShas.has(r.sha));
  const rand = mulberry32(LAYERS_SEED);
  const shuffled = allResolved
    .map((r) => ({ r, k: rand() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r)
    .slice(0, LAYERS_SAMPLE_SIZE);

  const layersStats = emptyStats();
  const layersSkipped: string[] = [];
  const depth = CONFIG.captain.moduleDepth;
  /** Module-to-module edges, excluding intra-module edges and test-file importers (src/architecture/layers.ts's own rule). */
  function moduleAdjacency(graph: Awaited<ReturnType<typeof buildDependencyGraph>>): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();
    for (const file of graph.files) {
      if (isTestPath(CONFIG, file)) continue;
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
  for (const row of shuffled) {
    const repoName = repoForSha.get(row.sha); // the repo (own or fallback) that actually resolved this sha above
    const repoDir = repoName ? repoDirs.get(repoName) : undefined;
    if (!repoDir) continue;
    try {
      const head = await git(repoDir, ["rev-parse", "--verify", `${row.sha}^{commit}`]);
      const parent = await gitMaybe(repoDir, ["rev-parse", "--verify", `${row.sha}^{commit}^`]);
      const base = parent?.trim() ?? "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // git's empty tree: root commit
      const [baseGraph, headGraph] = await Promise.all([buildDependencyGraph(repoDir, base, CONFIG), buildDependencyGraph(repoDir, head.trim(), CONFIG)]);
      const baseModules = new Set(baseGraph.files.map((f) => moduleOf(f, depth)));
      const baseAdjacency = moduleAdjacency(baseGraph);
      const headAdjacency = moduleAdjacency(headGraph);
      let fired = false;
      for (const [from, tos] of headAdjacency) {
        if (!baseModules.has(from)) continue;
        for (const to of tos) {
          if (!baseModules.has(to)) continue;
          if (!baseAdjacency.get(from)?.has(to)) {
            fired = true;
            break;
          }
        }
        if (fired) break;
      }
      record(layersStats, fired, row.buggy);
    } catch (e) {
      layersSkipped.push(`${row.sha}: ${errorMessage(e)}`);
    }
  }

  if (!opts.keepClones) {
    console.error("deleting clones");
    await rm(join(WORK_DIR, "repos"), { recursive: true, force: true });
  }

  const totalUnresolved = Object.values(unresolvedByProject).reduce((a, b) => a + b, 0);
  const lines: string[] = [];
  lines.push("# Captain-fact lift on ApacheJIT", "");
  lines.push("Generated by `bench/apachejit/captain-lift-experiment.ts`. Pooled over every project except `apache/hadoop` (no positive labels), on the dataset's official test split.", "");
  lines.push("## Coverage", "");
  lines.push(`- Test commits in the pool: ${pooledTestCsv.length}.`);
  lines.push(`- Resolved to a diff (contract.*, change.*, tests.weakened): ${resolvedShas.size}/${pooledTestCsv.length}.`);
  if (totalUnresolved > 0) {
    lines.push(`- Unresolved, by project: ${Object.entries(unresolvedByProject).map(([k, v]) => `${k} ${v}`).join(", ")}.`);
  }
  if (cloneWarnings.length > 0) lines.push(`- Clone warnings: ${cloneWarnings.join("; ")}.`);
  if (processWarnings.length > 0) lines.push(`- Processing warnings: ${processWarnings.join("; ")}.`);
  if (dependencyParseErrors.length > 0) lines.push(`- \`contract.dependency\`: ${dependencyParseErrors.length} manifest(s) did not parse (logged, not counted as a fire).`);
  lines.push(`- \`layers.edge\` sample: ${shuffled.length} commits (requested ${LAYERS_SAMPLE_SIZE}, seed ${LAYERS_SEED}); ${layersSkipped.length} skipped (graph build failed).`, "");

  lines.push("## Results", "");
  lines.push("| Fact | Fires on (test commits) | Buggy when fires | Base rate | Lift | Qualifies (>= 1.2x, >= 50 fires)? |", "|---|---:|---:|---:|---:|---|");
  const row = (label: string, s: LiftStats) => {
    const l = lift(s);
    const buggyPct = s.fires === 0 ? "—" : `${((s.buggyWhenFires / s.fires) * 100).toFixed(1)} %`;
    const basePct = s.total === 0 ? "—" : `${((s.positives / s.total) * 100).toFixed(1)} %`;
    lines.push(`| ${label} | ${s.fires}/${s.total} | ${buggyPct} | ${basePct} | ${Number.isFinite(l) ? `${l.toFixed(3)}×` : "—"} | ${qualifies(s) ? "Yes" : "No"} |`);
  };
  row("`contract.dependency`", mainStats.contractDependency);
  row("`contract.api` (approximate dependents)", mainStats.contractApi);
  row("`contract.schema`", mainStats.contractSchema);
  row("`layers.edge` (2,000-commit sample)", layersStats);
  row("`change.concurrency` (rejected score signal)", mainStats.changeConcurrency);
  row("`change.safety_removed` (rejected score signal)", mainStats.changeSafetyRemoved);
  row("`tests.weakened` (rejected score signal)", mainStats.testsWeakened);
  lines.push("");

  lines.push("## Decision (spec §10.2's bar, applied exactly: lift >= 1.2x and >= 50 firing test commits)", "");
  for (const [label, s] of [
    ["`contract.dependency`", mainStats.contractDependency],
    ["`contract.api`", mainStats.contractApi],
    ["`contract.schema`", mainStats.contractSchema],
    ["`layers.edge`", layersStats],
    ["`change.concurrency`", mainStats.changeConcurrency],
    ["`change.safety_removed`", mainStats.changeSafetyRemoved],
    ["`tests.weakened`", mainStats.testsWeakened],
  ] as const) {
    const l = lift(s);
    lines.push(`- ${label}: ${s.fires} fires, lift ${Number.isFinite(l) ? `${l.toFixed(3)}×` : "n/a"} → **${qualifies(s) ? "qualifies as a bug-predicting captain fact" : "logged, does not qualify"}**.`);
  }
  lines.push("");

  lines.push(
    "## Caveats",
    "",
    "- **No rename detection.** `--no-renames` (the coupling experiment's own reason: `-M` is the slow part on a large history); a rename shows as a delete and an add.",
    "- **`contract.api`'s dependents are approximated.** A single `git grep` pass over each project's pinned 2019 head stands in for the real per-commit import graph: a 2005 commit's dependents are approximated from 2019 imports, and files outside the Maven/Gradle `src/(main|test)/(java|kotlin)/...` layout fall back to a bare-class-name match, which can over- or under-count on a name collision.",
    "- **`layers.edge` is a 2,000-commit sample**, not the full test split, because building two full dependency graphs per commit does not scale to 24,686 commits; its base rate and lift come from that sample only.",
    "- **`contract.schema` and `contract.dependency` need no approximation**: they read path globs and, for `contract.dependency`, the manifest's real before/after text.",
    "- **Merge commits** show no diff under `git log -p`'s default (no `-m`/`-c`), so they are counted as resolved-but-non-firing rather than skipped; this undercounts any fact that would have fired on a merge's own changes.",
    "",
  );
  await writeFile(OUT, lines.join("\n"));
  console.error(`wrote ${OUT.pathname}`);
}

await main();
