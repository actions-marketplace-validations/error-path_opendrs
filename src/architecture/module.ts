import type { OpendrsConfig } from "../domain/config.js";
import { languageOf } from "../graph/imports.js";
import { dirOf } from "../graph/path-util.js";
import { matchGlob } from "../git/glob.js";
import type { PackageRootIndex } from "../graph/package-roots.js";

/** Spec §6.2: the first `depth` path segments of `path`'s directory ("" for a file at the root). */
export function moduleOf(path: string, depth: number): string {
  const parts = path.split("/");
  parts.pop(); // drop the file name
  return parts.slice(0, depth).join("/");
}

/** A built module map: one function from path to module, plus the captain-facing "how" notes (module-boundaries spec §3). */
export interface ModuleResolver {
  moduleOf(path: string): string;
  notes: readonly string[];
}

// Conventional source-dir prefix to skip one segment of, per ecosystem (module-boundaries spec §3's table).
const PREFIXES: Record<"js" | "rust" | "ruby" | "python", readonly string[]> = {
  js: ["src", "lib"],
  rust: ["src"],
  ruby: ["lib"],
  python: ["src"],
};

/** The longest (most specific) of `roots` that contains `dir`, if any; `roots` must be sorted longest-first. */
function enclosingRoot(dir: string, roots: readonly string[]): string | undefined {
  return roots.find((r) => dir === r || dir.startsWith(`${r}/`));
}

/** `root` + the first path segment beneath one of `prefixes` under it; `root` itself with no further segment, or when no prefix matches. */
function moduleUnderRoot(path: string, root: string, prefixes: readonly string[]): string {
  const dir = dirOf(path);
  if (dir === root) return root;
  const rel = dir.slice(root ? root.length + 1 : 0).split("/");
  if (!prefixes.includes(rel[0]!)) return root;
  const under = rel[1] !== undefined ? `${rel[0]}/${rel[1]}` : rel[0]!;
  return root ? `${root}/${under}` : under;
}

/** Step 1 (spec §3): the longest matching glob's literal prefix, the part before its first `*`; undefined when none match. */
function moduleViaGlobs(path: string, globs: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const g of globs) {
    if (!matchGlob(g, path)) continue;
    const star = g.indexOf("*");
    const prefix = (star < 0 ? g : g.slice(0, star)).replace(/\/+$/, "");
    if (best === undefined || prefix.length > best.length) best = prefix;
  }
  return best;
}

const AUTO_LANGS = ["js", "rust", "ruby", "python"] as const;
type AutoLang = (typeof AUTO_LANGS)[number];

function ecosystemOf(path: string): AutoLang | "go" | "swift" | undefined {
  if (/\.swift$/.test(path)) return "swift";
  const lang = languageOf(path);
  if (lang === "go") return "go";
  return (AUTO_LANGS as readonly string[]).includes(lang ?? "") ? (lang as AutoLang) : undefined;
}

function plural(n: number, s: string): string {
  return `${n} ${s}${n === 1 ? "" : "s"}`;
}

/** Either the detected count, or the "falling back" line when none were found. */
function rootsLine(count: number, what: string, from: string, fallbackDepth: number): string {
  return count > 0 ? `modules: auto-detected ${plural(count, what)} from ${from}` : `modules: no ${from} found; falling back to moduleDepth: ${fallbackDepth}`;
}

/** One line per ecosystem actually present in `files`, naming how its module map was built (spec §3, "Notes shown to the captain"). */
function buildNotes(files: readonly string[], roots: PackageRootIndex, fallbackDepth: number): string[] {
  const present = new Set(files.map(ecosystemOf).filter((e): e is Exclude<typeof e, undefined> => e !== undefined));
  const other = files.some((f) => {
    const l = languageOf(f);
    return l === "java" || l === "kotlin";
  });
  const notes: string[] = [];
  if (present.has("js")) notes.push(rootsLine(roots.js.length, "JS/TS package", "package.json", fallbackDepth));
  if (present.has("go")) notes.push("modules: Go packages (one per directory)");
  if (present.has("rust")) notes.push(rootsLine(roots.rust.length, "Rust crate", "Cargo.toml", fallbackDepth));
  if (present.has("ruby")) notes.push(rootsLine(roots.ruby.length, "Ruby gem", "*.gemspec", fallbackDepth));
  if (present.has("python")) notes.push(rootsLine(roots.python.length, "Python package", "pyproject.toml/setup.cfg", fallbackDepth));
  if (present.has("swift")) notes.push(rootsLine(roots.swift.length, "Swift target", "Package.swift", fallbackDepth));
  if (other) notes.push(`modules: no package manifest convention for this language; falling back to moduleDepth: ${fallbackDepth}`);
  return notes;
}

/**
 * Spec §3's full resolution order: `captain.modules` glob, then the file's ecosystem package root
 * (auto-detected, unless `captain.moduleDepth` was set explicitly), then the flat fallback depth.
 */
export function buildModuleResolver(files: readonly string[], roots: PackageRootIndex, config: OpendrsConfig): ModuleResolver {
  const globs = config.captain.modules;
  const explicitDepth = config.captain.moduleDepth;
  const fallbackDepth = explicitDepth ?? 2;
  const autoDetect = explicitDepth === undefined;

  function resolve(path: string): string {
    const viaGlob = globs.length > 0 ? moduleViaGlobs(path, globs) : undefined;
    if (viaGlob !== undefined) return viaGlob;
    if (autoDetect) {
      const eco = ecosystemOf(path);
      if (eco === "go") return dirOf(path);
      if (eco === "swift") {
        const root = enclosingRoot(dirOf(path), roots.swift);
        if (root !== undefined) return root;
      } else if (eco !== undefined) {
        const root = enclosingRoot(dirOf(path), roots[eco]);
        if (root !== undefined) return moduleUnderRoot(path, root, PREFIXES[eco]);
      }
    }
    return moduleOf(path, fallbackDepth);
  }

  const notes = globs.length > 0
    ? [`modules: captain.modules override (${plural(globs.length, "glob")})`]
    : !autoDetect
      ? [`modules: captain.moduleDepth is set explicitly (${fallbackDepth}); auto-detection is disabled`]
      : buildNotes(files, roots, fallbackDepth);

  return { moduleOf: resolve, notes };
}
