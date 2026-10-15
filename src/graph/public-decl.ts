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
  ruby: () => false,
};

/** Heuristic: does this source line declare an exported/public symbol? */
export function isPublicDeclaration(path: string, line: string): boolean {
  const lang = languageOf(path);
  return lang !== undefined && RULES[lang](line);
}
