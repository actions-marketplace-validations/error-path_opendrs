// Minimal private glob matcher (`**`, `*`, `?`, `{a,b}`) over repo-relative paths.
// Temporary: src/git/glob.ts (another workstream) is the shared one; dedupe at integration.

const cache = new Map<string, RegExp>();

function toRegexSource(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = closingBrace(glob, i);
      if (end < 0) {
        out += "\\{";
        continue;
      }
      out += `(?:${splitTopLevel(glob.slice(i + 1, end)).map(toRegexSource).join("|")})`;
      i = end;
    } else {
      out += c.replace(/[.+^$()|[\]\\{}]/g, "\\$&");
    }
  }
  return out;
}

function closingBrace(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "{") depth++;
    else if (s[i] === "}") depth--;
    else if (s[i] === "," && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

export function globMatch(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(`^${toRegexSource(pattern)}$`);
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function globMatchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => globMatch(p, path));
}
