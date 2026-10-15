import { lex, type LexOptions, type QuoteRule } from "./lex.js";

export type Language = "js" | "python" | "go" | "java" | "kotlin" | "rust" | "ruby";

const EXTENSIONS: Record<string, Language> = {
  ts: "js",
  tsx: "js",
  mts: "js",
  cts: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  py: "python",
  go: "go",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  rs: "rust",
  rb: "ruby",
};

export function languageOf(path: string): Language | undefined {
  const dot = path.lastIndexOf(".");
  if (dot < 0 || dot < path.lastIndexOf("/")) return undefined;
  return EXTENSIONS[path.slice(dot + 1)];
}

const line: QuoteRule = { multiline: false, escapes: true };
const multi: QuoteRule = { multiline: true, escapes: true };
const raw: QuoteRule = { multiline: true, escapes: false };

export const LEX_OPTIONS: Record<Language, LexOptions> = {
  js: { lineComment: "//", blockComment: "flat", quotes: { "'": line, '"': line, "`": multi }, jsRegex: true },
  python: { lineComment: "#", quotes: { "'": line, '"': line }, triple: `'"` },
  go: { lineComment: "//", blockComment: "flat", quotes: { "'": line, '"': line, "`": raw } },
  java: { lineComment: "//", blockComment: "flat", quotes: { "'": line, '"': line }, triple: '"' },
  kotlin: { lineComment: "//", blockComment: "flat", quotes: { "'": line, '"': line }, triple: '"' },
  rust: { lineComment: "//", blockComment: "nested", quotes: { '"': multi }, rust: true },
  ruby: { lineComment: "#", quotes: { "'": multi, '"': multi } },
};

type Extractor = (masked: string, str: (idx: string | undefined) => string) => string[];

const JS_FROM = /(?<![\w$.])(?:import|export)\b[^;"]*?\bfrom\s*"(\d+)"/g;
const JS_BARE = /(?<![\w$.])import\s*"(\d+)"/g;
const JS_CALL = /(?<![\w$.])(?:import|require)\s*\(\s*"(\d+)"\s*\)/g;

const PY_IMPORT = /^[ \t]*import[ \t]+([^\n]+)/gm;
const PY_FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n]*)/gm;

const GO_GROUP = /(?<![\w.])import\s*\(([^)]*)\)/g;
const GO_SINGLE = /(?<![\w.])import\s+(?:[\w.]+\s+)?"(\d+)"/g;
const PLACEHOLDER = /"(\d+)"/g;

const JVM_IMPORT = /^[ \t]*import[ \t]+(?:static[ \t]+)?(\w+(?:\.\w+)*(?:\.\*)?)/gm;

const RUST_MOD = /^[ \t]*(?:#\[[^\]]*\][ \t]*)*(?:pub(?:\([^)]*\))?[ \t]+)?mod[ \t]+(\w+)[ \t]*;/gm;
const RUST_USE = /(?<![\w:])use\s+([^;]+);/g;

const RUBY_REQUIRE = /(?<![\w.])(require_relative|require)\s*\(?\s*"(\d+)"/g;

const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? "";

const EXTRACTORS: Record<Language, Extractor> = {
  js(masked, str) {
    const out: string[] = [];
    for (const re of [JS_FROM, JS_BARE, JS_CALL]) for (const m of masked.matchAll(re)) out.push(str(m[1]));
    return out.filter((s) => !s.includes("${"));
  },
  python(masked) {
    const text = masked.replace(/\\\n/g, " ");
    const out: string[] = [];
    for (const m of text.matchAll(PY_IMPORT)) {
      for (const part of m[1]!.split(";")[0]!.split(",")) {
        const mod = firstWord(part);
        if (/^[\w.]+$/.test(mod)) out.push(mod);
      }
    }
    for (const m of text.matchAll(PY_FROM)) {
      const mod = m[1]!;
      if (mod === "") continue;
      out.push(mod);
      for (const part of m[2]!.split(";")[0]!.replace(/[()]/g, "").split(",")) {
        const name = firstWord(part);
        if (/^\w+$/.test(name)) out.push(mod.endsWith(".") ? mod + name : `${mod}.${name}`);
      }
    }
    return out;
  },
  go(masked, str) {
    const out: string[] = [];
    for (const g of masked.matchAll(GO_GROUP)) for (const m of g[1]!.matchAll(PLACEHOLDER)) out.push(str(m[1]));
    for (const m of masked.matchAll(GO_SINGLE)) out.push(str(m[1]));
    return out;
  },
  java: (masked) => [...masked.matchAll(JVM_IMPORT)].map((m) => m[1]!),
  kotlin: (masked) => [...masked.matchAll(JVM_IMPORT)].map((m) => m[1]!),
  rust(masked) {
    const out = [...masked.matchAll(RUST_MOD)].map((m) => `mod:${m[1]}`);
    for (const m of masked.matchAll(RUST_USE)) {
      out.push(...expandUse("", m[1]!.replace(/\s*(::|[{},])\s*/g, "$1").trim()));
    }
    return out;
  },
  ruby(masked, str) {
    const out: string[] = [];
    for (const m of masked.matchAll(RUBY_REQUIRE)) {
      const spec = str(m[2]);
      out.push(m[1] === "require_relative" && !/^[./]/.test(spec) ? `./${spec}` : spec);
    }
    return out;
  },
};

/** Expand a Rust use-tree (`a::{b, c::{d}}`) into flat paths, dropping `as` aliases and `::self`. */
function expandUse(prefix: string, tree: string): string[] {
  const open = tree.indexOf("{");
  if (open < 0) {
    const path = (prefix + tree.split(/\s+as\s+/)[0]!.trim()).replace(/::self$/, "");
    return path && !path.endsWith("::") ? [path] : [];
  }
  let depth = 0;
  let close = tree.length;
  for (let i = open; i < tree.length; i++) {
    if (tree[i] === "{") depth++;
    else if (tree[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  const head = prefix + tree.slice(0, open);
  const out: string[] = [];
  let start = open + 1;
  depth = 0;
  for (let i = open + 1; i <= close; i++) {
    const ch = tree[i];
    if (ch === "{") depth++;
    else if (ch === "}" && depth > 0) depth--;
    else if ((ch === "," && depth === 0) || i === close) {
      const part = tree.slice(start, i).trim();
      if (part) out.push(...expandUse(head, part));
      start = i + 1;
    }
  }
  return out;
}

/**
 * Raw import specifiers of a source file, with comments and string contents ignored.
 * Conventions: Rust `mod x;` is reported as `mod:x`; Ruby `require_relative "x"` as `./x`.
 */
export function extractImports(path: string, source: string): string[] {
  const lang = languageOf(path);
  if (!lang) return [];
  const { masked, strings } = lex(source, LEX_OPTIONS[lang]);
  const str = (idx: string | undefined) => strings[Number(idx)] ?? "";
  return [...new Set(EXTRACTORS[lang](masked, str))].filter((s) => s !== "");
}
