import { languageOf } from "./imports.js";
import { baseName, dirOf, joinPath } from "./path-util.js";
import { createJsResolver } from "./resolve-js.js";
import { createJvmResolver } from "./resolve-jvm.js";

/** Maps a raw specifier imported by `from` to repo files; [] when external or unresolvable. */
export type Resolve = (from: string, spec: string) => string[];

/**
 * Build a resolver over the repo's file list. `contents` must hold the text of the files the
 * indexes need: Java/Kotlin sources, tsconfig/jsconfig.json, package.json and go.mod.
 */
export function createResolver(files: readonly string[], contents: ReadonlyMap<string, string>): Resolve {
  const fileSet = new Set(files);
  const dirFiles = new Map<string, string[]>();
  for (const f of files) {
    const d = dirOf(f);
    const list = dirFiles.get(d);
    if (list) list.push(f);
    else dirFiles.set(d, [f]);
  }
  const has = (p: string | undefined): p is string => p !== undefined && fileSet.has(p);
  const first = (...candidates: Array<string | undefined>) => {
    const hit = candidates.find(has);
    return hit ? [hit] : [];
  };

  const js = createJsResolver(fileSet, contents);
  const jvm = createJvmResolver(files, contents);
  const goModules = goModuleIndex(files, contents);

  function python(from: string, spec: string): string[] {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots).replace(/\./g, "/");
    let roots = ["", "src"];
    if (dots > 0) {
      let dir = dirOf(from);
      for (let k = 1; k < dots; k++) {
        if (dir === "") return [];
        dir = dirOf(dir);
      }
      roots = [dir];
    }
    for (const root of roots) {
      const base = joinPath(root, rest || ".");
      if (base === undefined) continue;
      const hit = rest ? first(`${base}.py`, joinPath(base, "__init__.py")) : first(joinPath(base, "__init__.py"));
      if (hit.length) return hit;
    }
    return [];
  }

  function go(spec: string): string[] {
    const mod = goModules.find((m) => spec === m.path || spec.startsWith(`${m.path}/`));
    if (!mod) return [];
    const dir = joinPath(mod.dir, spec.slice(mod.path.length + 1) || ".");
    if (dir === undefined) return [];
    return (dirFiles.get(dir) ?? []).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
  }

  function rust(from: string, spec: string): string[] {
    if (spec.startsWith("mod:")) {
      const name = spec.slice(4);
      const stem = baseName(from).replace(/\.rs$/, "");
      const dir = ["mod", "lib", "main"].includes(stem) ? dirOf(from) : joinPath(dirOf(from), stem);
      return dir === undefined ? [] : first(joinPath(dir, `${name}.rs`), joinPath(dir, `${name}/mod.rs`));
    }
    const segs = spec.split("::");
    const src = rustCrateSrc(from);
    if (src === undefined) return [];
    let mod: string[];
    if (segs[0] === "crate") mod = segs.slice(1);
    else if (segs[0] === "self" || segs[0] === "super") {
      if (!from.startsWith(src ? `${src}/` : "")) return [];
      const own = from.slice(src ? src.length + 1 : 0).replace(/\.rs$/, "").split("/");
      if (["mod", "lib", "main"].includes(own[own.length - 1]!)) own.pop();
      let i = 0;
      if (segs[0] === "self") i = 1;
      else
        for (; segs[i] === "super"; i++) {
          if (own.length === 0) return [];
          own.pop();
        }
      mod = [...own, ...segs.slice(i)];
    } else return [];
    for (let k = mod.length; k >= 1; k--) {
      const base = joinPath(src, mod.slice(0, k).join("/"));
      const hit = first(base && `${base}.rs`, base && `${base}/mod.rs`);
      if (hit.length) return hit;
    }
    return first(joinPath(src, "lib.rs"), joinPath(src, "main.rs"));
  }

  /** `<crate>/src` for the nearest Cargo.toml, else the nearest ancestor directory named src. */
  function rustCrateSrc(from: string): string | undefined {
    for (let d = dirOf(from); ; d = dirOf(d)) {
      if (fileSet.has(d ? `${d}/Cargo.toml` : "Cargo.toml")) return d ? `${d}/src` : "src";
      if (d === "") break;
    }
    for (let d = dirOf(from); d !== ""; d = dirOf(d)) if (baseName(d) === "src") return d;
    return undefined;
  }

  function ruby(from: string, spec: string): string[] {
    const withExt = spec.endsWith(".rb") ? spec : `${spec}.rb`;
    return spec.startsWith(".") ? first(joinPath(dirOf(from), withExt)) : first(joinPath("lib", withExt));
  }

  return (from, spec) => {
    let out: string[];
    switch (languageOf(from)) {
      case "js":
        out = js(from, spec);
        break;
      case "python":
        out = python(from, spec);
        break;
      case "go":
        out = go(spec);
        break;
      case "java":
      case "kotlin":
        out = jvm(spec);
        break;
      case "rust":
        out = rust(from, spec);
        break;
      case "ruby":
        out = ruby(from, spec);
        break;
      default:
        out = [];
    }
    return out.filter((f) => f !== from);
  };
}

function goModuleIndex(files: readonly string[], contents: ReadonlyMap<string, string>): Array<{ path: string; dir: string }> {
  const mods: Array<{ path: string; dir: string }> = [];
  for (const f of files) {
    if (baseName(f) !== "go.mod") continue;
    const m = /^module\s+"?([^\s"]+)"?/m.exec(contents.get(f) ?? "");
    if (m) mods.push({ path: m[1]!, dir: dirOf(f) });
  }
  // Longest module path first, so nested modules win over their parents.
  return mods.sort((a, b) => b.path.length - a.path.length);
}
