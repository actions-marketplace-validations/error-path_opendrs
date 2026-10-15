// Minimal glob matcher for repo-relative paths: `**` (any depth), `*` and `?` (within one
// segment). Dotfiles match like any other name. Temporary: the integrator replaces this
// with matchAny from src/git/glob.ts.

const cache = new Map<string, RegExp>();

function toRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const slashAfter = pattern[i + 2] === "/";
      re += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function matchGlob(pattern: string, path: string): boolean {
  let re = cache.get(pattern);
  if (!re) cache.set(pattern, (re = toRegExp(pattern)));
  return re.test(path);
}

export function matchAny(patterns: readonly string[], path: string): boolean {
  return patterns.some((p) => matchGlob(p, path));
}
