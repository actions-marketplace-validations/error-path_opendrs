/** Minimal glob matcher for repo-relative paths: `**`, `*`, `?` and `{a,b}`. */

const cache = new Map<string, RegExp>();

export interface GlobOptions {
  /** Ignore case, as `paths.block` and `paths.critical` do: `makefile` and `Migrations/` must not slip past. */
  ignoreCase?: boolean;
}

export function matchGlob(pattern: string, path: string, opts: GlobOptions = {}): boolean {
  // "s": `**` must span every character, so a path with a line break cannot dodge a block glob.
  const flags = opts.ignoreCase ? "isu" : "su";
  const key = `${flags}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    re = new RegExp(`^${translate(pattern)}$`, flags);
    cache.set(key, re);
  }
  return re.test(path);
}

export function matchAny(patterns: readonly string[], path: string, opts: GlobOptions = {}): boolean {
  return patterns.some((p) => matchGlob(p, path, opts));
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
