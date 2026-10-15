/** Minimal glob matcher for repo-relative paths: `**`, `*`, `?` and `{a,b}`. */

const cache = new Map<string, RegExp>();

export function matchGlob(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) {
    re = new RegExp(`^${translate(pattern)}$`, "u");
    cache.set(pattern, re);
  }
  return re.test(path);
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}

function translate(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      const close = matchingBrace(glob, i);
      if (close < 0) out += "\\{";
      else {
        out += `(?:${splitTopLevel(glob.slice(i + 1, close)).map(translate).join("|")})`;
        i = close;
      }
    } else out += c.replace(/[.+^${}()|[\]\\/]/g, "\\$&");
  }
  return out;
}

function matchingBrace(s: string, open: number): number {
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
