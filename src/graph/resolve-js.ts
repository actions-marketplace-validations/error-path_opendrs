import { LEX_OPTIONS } from "./imports.js";
import { lex } from "./lex.js";
import { baseName, dirOf, joinPath } from "./path-util.js";

const EXTS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"];
const TS_FOR_JS = [".ts", ".tsx", ".mts", ".cts"];
const ENTRY_FIELDS = ["source", "types", "typings", "module", "main"];

interface PathsConfig {
  dir: string;
  baseDir?: string;
  paths: Array<[pattern: string, targets: string[]]>;
}

/** Tolerant JSON-with-comments parse (tsconfig style: comments and trailing commas). */
export function parseJsonc(text: string): unknown {
  const { masked, strings } = lex(text, { ...LEX_OPTIONS.js, jsRegex: false });
  const json = masked.replace(/"(\d+)"/g, (_, i: string) => `"${strings[Number(i)]}"`).replace(/,(\s*[}\]])/g, "$1");
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

export function createJsResolver(fileSet: ReadonlySet<string>, contents: ReadonlyMap<string, string>) {
  const configs = new Map<string, PathsConfig>();
  const packages: Array<{ name: string; dir: string; entries: string[] }> = [];

  for (const [file, text] of contents) {
    const name = baseName(file);
    if (name === "tsconfig.json" || name === "jsconfig.json") {
      const opts = (parseJsonc(text) as Json | undefined)?.compilerOptions;
      if (!isObj(opts)) continue;
      const dir = dirOf(file);
      const baseDir = typeof opts.baseUrl === "string" ? joinPath(dir, opts.baseUrl) : undefined;
      const paths = isObj(opts.paths)
        ? Object.entries(opts.paths).map(([k, v]): [string, string[]] => [k, Array.isArray(v) ? v.filter((t) => typeof t === "string") : []])
        : [];
      if (baseDir === undefined && paths.length === 0) continue;
      // tsconfig.json wins over jsconfig.json in the same directory.
      if (name === "tsconfig.json" || !configs.has(dir)) configs.set(dir, { dir, baseDir, paths });
    } else if (name === "package.json") {
      const pkg = parseJsonc(text);
      if (!isObj(pkg) || typeof pkg.name !== "string") continue;
      const entries = ENTRY_FIELDS.map((f) => pkg[f]).filter((v): v is string => typeof v === "string");
      packages.push({ name: pkg.name, dir: dirOf(file), entries: [...entries, "src/index", "index"] });
    }
  }

  function probe(base: string | undefined): string | undefined {
    if (base === undefined) return undefined;
    if (fileSet.has(base)) return base;
    const prefix = base ? `${base}/` : "";
    for (const e of EXTS) if (fileSet.has(base + e)) return base + e;
    for (const e of EXTS) if (fileSet.has(`${prefix}index${e}`)) return `${prefix}index${e}`;
    // ESM TypeScript imports "./x.js" for the source file "./x.ts".
    const js = /\.[cm]?jsx?$/.exec(base);
    if (js) {
      const stem = base.slice(0, js.index);
      for (const e of TS_FOR_JS) if (fileSet.has(stem + e)) return stem + e;
    }
    return undefined;
  }

  function nearestConfig(from: string): PathsConfig | undefined {
    for (let d = dirOf(from); ; d = dirOf(d)) {
      const c = configs.get(d);
      if (c) return c;
      if (d === "") return undefined;
    }
  }

  function viaConfig(from: string, spec: string): string | undefined {
    const cfg = nearestConfig(from);
    if (!cfg) return undefined;
    const root = cfg.baseDir ?? cfg.dir;
    for (const [pattern, targets] of cfg.paths) {
      const star = pattern.indexOf("*");
      let match: string | undefined;
      if (star < 0) match = pattern === spec ? "" : undefined;
      else {
        const pre = pattern.slice(0, star);
        const post = pattern.slice(star + 1);
        if (spec.length >= pre.length + post.length && spec.startsWith(pre) && spec.endsWith(post)) {
          match = spec.slice(pre.length, spec.length - post.length);
        }
      }
      if (match === undefined) continue;
      for (const t of targets) {
        const hit = probe(joinPath(root, t.replace("*", match)));
        if (hit) return hit;
      }
    }
    return cfg.baseDir !== undefined ? probe(joinPath(cfg.baseDir, spec)) : undefined;
  }

  function viaWorkspace(spec: string): string | undefined {
    const pkg = packages.find((p) => spec === p.name || spec.startsWith(`${p.name}/`));
    if (!pkg) return undefined;
    const sub = spec.slice(pkg.name.length + 1);
    const candidates = sub ? [sub, `src/${sub}`] : pkg.entries;
    for (const c of candidates) {
      const hit = probe(joinPath(pkg.dir, c));
      if (hit) return hit;
    }
    return undefined;
  }

  return (from: string, spec: string): string[] => {
    const hit = spec.startsWith(".") ? probe(joinPath(dirOf(from), spec)) : (viaConfig(from, spec) ?? viaWorkspace(spec));
    return hit ? [hit] : [];
  };
}
