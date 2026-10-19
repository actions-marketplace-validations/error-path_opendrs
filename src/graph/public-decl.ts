import { type Language, languageOf } from "./imports.js";

const KOTLIN_DECL = /^(?:(?:open|abstract|sealed|data|enum|inline|value|annotation|const|suspend|operator|infix|tailrec|external|final|inner|lateinit)\s+)*(?:fun|class|interface|object|val|var|typealias)\b/;

const RULES: Record<Language, (line: string) => boolean> = {
  js: (l) => /^\s*export\b/.test(l) || /^\s*(?:module\.)?exports\b/.test(l),
  // Top level only: indented defs are methods or nested helpers.
  python: (l) => /^(?:async\s+def|def|class)\s+[A-Za-z]/.test(l),
  go: (l) => /^func\s+(?:\([^)]*\)\s*)?[A-Z]/.test(l) || /^(?:type|var|const)\s+[A-Z]/.test(l),
  java: (l) => /\bpublic\b/.test(l),
  // Kotlin defaults to public, so unmodified top-level declarations count too.
  kotlin: (l) => /\bpublic\b/.test(l) || KOTLIN_DECL.test(l),
  rust: (l) => /^\s*pub\b/.test(l),
  // Ruby has no file-local way to track a `private` call made on an earlier line, so this is a
  // conservative approximation rather than true visibility tracking: top-level (unindented)
  // class/module and def, plus `def self.x` (a class method, which stays public even after a bare
  // `private` call, unlike instance methods). An ordinary indented instance method is not counted,
  // since whether it is still public depends on context this per-line rule cannot see.
  ruby: (l) => /^(?:class|module)\s+[A-Z]/.test(l) || /^\s*def\s+self\.[A-Za-z_]/.test(l) || /^def\s+[A-Za-z_]/.test(l),
};

// Swift has no import-graph extractor in src/graph/imports.ts, so it isn't part of the shared
// `Language` union; keep its rule local instead of growing that union for public-decl alone.
// Conservative: Swift's default access level is internal, so this requires an explicit
// `public`/`open` keyword before the declaration.
const SWIFT_DECL = /^\s*(?:public|open)\b\s*(?:(?:final|static|class|mutating|override|required|convenience|dynamic)\s+)*(?:func|class|struct|enum|protocol|var|let|typealias|init)\b/;

/** Heuristic: does this source line declare an exported/public symbol? */
export function isPublicDeclaration(path: string, line: string): boolean {
  if (path.endsWith(".swift")) return SWIFT_DECL.test(line);
  const lang = languageOf(path);
  return lang !== undefined && RULES[lang](line);
}
