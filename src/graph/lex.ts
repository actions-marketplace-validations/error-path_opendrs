// Lexer-lite: blanks comments and replaces every string literal with a `"<index>"` placeholder,
// so import regexes only ever see real code. Newlines are preserved for line-anchored regexes.

export interface QuoteRule {
  multiline: boolean;
  escapes: boolean;
}

export interface LexOptions {
  lineComment: "//" | "#";
  blockComment?: "flat" | "nested";
  quotes: Record<string, QuoteRule>;
  /** Quote chars that also open a triple-quoted string (Python, Java/Kotlin text blocks). */
  triple?: string;
  jsRegex?: boolean;
  /** Rust raw strings (r#"..."#) and char literals vs lifetimes ('a). */
  rust?: boolean;
}

export interface Lexed {
  masked: string;
  /** Raw (undecoded) contents of each string literal, indexed by placeholder. */
  strings: string[];
}

const REGEX_PREV = new Set("(,=:[!&|?{};+-*%<>~^");
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "yield", "await"]);
const RUST_CHAR = /'(?:[^\\'\n]|\\(?:u\{[0-9a-fA-F]+\}|x[0-9a-fA-F]{2}|.))'/y;
const RUST_RAW = /b?r(#*)"/y;

const isIdent = (c: string | undefined) => c !== undefined && /[\w$]/.test(c);
const newlines = (s: string) => "\n".repeat(s.split("\n").length - 1);

export function lex(src: string, o: LexOptions): Lexed {
  const parts: string[] = [];
  const strings: string[] = [];
  const n = src.length;
  let segStart = 0;
  let i = 0;
  let prev = ""; // last significant code char, for the JS regex heuristic
  let prevAt = -1;

  const emit = (end: number, replacement: string, next: number) => {
    if (end > segStart) parts.push(src.slice(segStart, end));
    parts.push(replacement);
    i = next;
    segStart = next;
  };
  const emitString = (start: number, contentStart: number, contentEnd: number, next: number) => {
    const content = src.slice(contentStart, contentEnd);
    strings.push(content);
    emit(start, `"${strings.length - 1}"${newlines(content)}`, next);
    prev = '"';
  };

  while (i < n) {
    const c = src[i]!;
    const c2 = src[i + 1];

    if ((o.lineComment === "#" && c === "#") || (o.lineComment === "//" && c === "/" && c2 === "/")) {
      const end = src.indexOf("\n", i);
      emit(i, " ", end < 0 ? n : end);
      continue;
    }
    if (o.blockComment && c === "/" && c2 === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === "*" && src[j + 1] === "/") {
          depth--;
          j += 2;
        } else if (o.blockComment === "nested" && src[j] === "/" && src[j + 1] === "*") {
          depth++;
          j += 2;
        } else j++;
      }
      emit(i, ` ${newlines(src.slice(i, j))}`, j);
      continue;
    }
    if (o.jsRegex && c === "/" && regexAllowed(src, prev, prevAt)) {
      const end = scanRegex(src, i);
      if (end > 0) {
        emit(i, "0", end);
        prev = "0";
        continue;
      }
    }
    if (o.rust && (c === "r" || c === "b") && !isIdent(src[i - 1])) {
      RUST_RAW.lastIndex = i;
      const m = RUST_RAW.exec(src);
      if (m) {
        const close = `"${m[1]}`;
        const contentStart = i + m[0].length;
        const end = src.indexOf(close, contentStart);
        const contentEnd = end < 0 ? n : end;
        emitString(i, contentStart, contentEnd, end < 0 ? n : end + close.length);
        continue;
      }
    }
    if (o.rust && c === "'") {
      RUST_CHAR.lastIndex = i;
      const m = RUST_CHAR.exec(src);
      if (m) {
        emitString(i, i + 1, i + m[0].length - 1, i + m[0].length);
        continue;
      }
      i++; // lifetime or label: plain code
      continue;
    }
    if (o.triple?.includes(c) && c2 === c && src[i + 2] === c) {
      const close = c + c + c;
      let j = i + 3;
      while (j < n && !src.startsWith(close, j)) j += src[j] === "\\" ? 2 : 1;
      const contentEnd = Math.min(j, n);
      emitString(i, i + 3, contentEnd, Math.min(n, j + 3));
      continue;
    }
    const rule = o.quotes[c];
    if (rule) {
      let j = i + 1;
      while (j < n) {
        const ch = src[j];
        if (rule.escapes && ch === "\\") j += 2;
        else if (ch === c || (ch === "\n" && !rule.multiline)) break;
        else j++;
      }
      const contentEnd = Math.min(j, n);
      emitString(i, i + 1, contentEnd, src[j] === c ? j + 1 : contentEnd);
      continue;
    }
    if (c > " ") {
      prev = c;
      prevAt = i;
    }
    i++;
  }
  if (segStart < n) parts.push(src.slice(segStart));
  return { masked: parts.join(""), strings };
}

function regexAllowed(src: string, prev: string, prevAt: number): boolean {
  if (prev === "") return true;
  if (REGEX_PREV.has(prev)) return true;
  if (!isIdent(prev)) return false;
  let start = prevAt;
  while (start > 0 && isIdent(src[start - 1])) start--;
  return REGEX_KEYWORDS.has(src.slice(start, prevAt + 1));
}

/** End index (exclusive) of a regex literal starting at `start`, or -1 if it is not one. */
function scanRegex(src: string, start: number): number {
  let inClass = false;
  for (let j = start + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") j++;
    else if (ch === "\n") return -1;
    else if (ch === "[") inClass = true;
    else if (ch === "]") inClass = false;
    else if (ch === "/" && !inClass) {
      j++;
      while (j < src.length && /[a-z]/.test(src[j]!)) j++;
      return j;
    }
  }
  return -1;
}
