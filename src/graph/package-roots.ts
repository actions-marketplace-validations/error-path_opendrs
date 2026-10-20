import { baseName, dirOf } from "./path-util.js";
import { parseJsonc } from "./resolve-js.js";

/**
 * Per-ecosystem package/crate/gem/target roots (module-boundaries spec §3), derived only from
 * files `buildDependencyGraph` already reads and already caches by tree sha (`graph.ts`). Each
 * array is sorted longest-path-first, so the deepest enclosing root wins a prefix match.
 */
export interface PackageRootIndex {
  js: readonly string[];
  rust: readonly string[];
  ruby: readonly string[];
  python: readonly string[];
  /** Swift target source directories (a target's `path`, or `Sources/<name>` when omitted). */
  swift: readonly string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function longestFirst(dirs: readonly string[]): string[] {
  return [...new Set(dirs)].sort((a, b) => b.length - a.length);
}

/** `.target("Name", path: "Rel")` / `.executableTarget(...)` calls, matched by paren balance (a call may span several lines). */
function swiftTargetDirs(manifestDir: string, text: string): string[] {
  const dirs: string[] = [];
  for (const marker of [".target(", ".executableTarget("]) {
    let from = 0;
    for (let idx = text.indexOf(marker, from); idx !== -1; idx = text.indexOf(marker, from)) {
      const open = idx + marker.length - 1;
      let depth = 0;
      let end = open;
      for (; end < text.length; end++) {
        if (text[end] === "(") depth++;
        else if (text[end] === ")" && --depth === 0) break;
      }
      if (depth !== 0) break; // unterminated call: stop scanning this marker rather than mis-parse
      const args = text.slice(open + 1, end);
      from = end + 1;
      const name = /\bname\s*:\s*"([^"]+)"/.exec(args)?.[1];
      if (!name) continue;
      const rel = /\bpath\s*:\s*"([^"]+)"/.exec(args)?.[1] ?? `Sources/${name}`;
      dirs.push(manifestDir ? `${manifestDir}/${rel}` : rel);
    }
  }
  return dirs;
}

/**
 * Build the package-root index over a tree's covered files (module-boundaries spec §3's
 * per-ecosystem table). Only `package.json` and `Package.swift` need their contents (to read a
 * `name` field and target list); Cargo.toml/gemspec/pyproject.toml/setup.cfg are detected by
 * filename alone, so no new manifest reads beyond what `package.json`/`Package.swift` already cost.
 */
export function computePackageRoots(files: readonly string[], contents: ReadonlyMap<string, string>): PackageRootIndex {
  const js: string[] = [];
  const rust: string[] = [];
  const ruby: string[] = [];
  const python: string[] = [];
  const swift: string[] = [];

  for (const f of files) {
    const name = baseName(f);
    if (name === "package.json") {
      const pkg = parseJsonc(contents.get(f) ?? "");
      if (isObj(pkg) && typeof pkg.name === "string") js.push(dirOf(f));
    } else if (name === "Cargo.toml") {
      rust.push(dirOf(f));
    } else if (name.endsWith(".gemspec")) {
      ruby.push(dirOf(f));
    } else if (name === "pyproject.toml" || name === "setup.cfg") {
      python.push(dirOf(f));
    } else if (name === "Package.swift") {
      swift.push(...swiftTargetDirs(dirOf(f), contents.get(f) ?? ""));
    }
  }

  return { js: longestFirst(js), rust: longestFirst(rust), ruby: longestFirst(ruby), python: longestFirst(python), swift: longestFirst(swift) };
}
