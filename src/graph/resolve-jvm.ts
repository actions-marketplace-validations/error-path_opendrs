import { LEX_OPTIONS, languageOf } from "./imports.js";
import { lex } from "./lex.js";
import { baseName } from "./path-util.js";

const PACKAGE = /^[ \t]*package[ \t]+(\w+(?:\.\w+)*)/m;
// Unindented declarations only: nested types are reached through their outer class.
const TOP_LEVEL_TYPE = /^(?:[\w@]+[ \t]+)*(?:class|interface|enum|object|record)[ \t]+(\w+)/gm;

function push(map: Map<string, string[]>, key: string, value: string) {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Java/Kotlin: index `package + class` -> file(s) and `package` -> files. */
export function createJvmResolver(files: readonly string[], contents: ReadonlyMap<string, string>) {
  const classes = new Map<string, string[]>();
  const packages = new Map<string, string[]>();

  for (const file of files) {
    const lang = languageOf(file);
    if (lang !== "java" && lang !== "kotlin") continue;
    const text = contents.get(file);
    if (text === undefined) continue;
    const { masked } = lex(text, LEX_OPTIONS[lang]);
    const pkg = PACKAGE.exec(masked)?.[1] ?? "";
    const prefix = pkg ? `${pkg}.` : "";
    push(packages, pkg, file);
    push(classes, prefix + baseName(file).replace(/\.(java|kts?)$/, ""), file);
    for (const m of masked.matchAll(TOP_LEVEL_TYPE)) push(classes, prefix + m[1], file);
  }

  return (spec: string): string[] => {
    if (spec.endsWith(".*")) {
      const name = spec.slice(0, -2);
      return packages.get(name) ?? classes.get(name) ?? [];
    }
    // Longest prefix naming a class: a.b.Outer.Inner and static a.b.C.member map to their file.
    const segs = spec.split(".");
    for (let k = segs.length; k >= 2; k--) {
      const hit = classes.get(segs.slice(0, k).join("."));
      if (hit) return hit;
    }
    return [];
  };
}
