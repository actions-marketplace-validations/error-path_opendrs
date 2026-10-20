import type { ArchitectureFact, ScoringContext } from "../domain/types.js";
import { changedLines } from "../git/diff.js";
import { gitMaybe } from "../git/exec.js";
import { matchAny } from "../git/glob.js";
import { languageOf } from "../graph/imports.js";
import { isPublicDeclaration } from "../graph/public-decl.js";
import { code, untrusted } from "../report/escape.js";
import { languageFamily } from "../signals/language.js";
import { isTestPath } from "../signals/tests.js";
import { plural } from "../signals/util.js";
import type { Detector } from "./index.js";
import { addedPackages, isManifestPath } from "./manifests.js";

/** Spec §6.3 defaults, before `captain.contracts.paths` is added. */
const DEFAULT_SCHEMA_GLOBS = [
  "**/migrations/**",
  "**/*.sql",
  "**/schema.prisma",
  "**/*.proto",
  "**/*.graphql",
  "**/openapi*.{yaml,yml,json}",
  "**/swagger*.{yaml,yml,json}",
];
const MAX_SCHEMA_FACTS = 3;
const MAX_INSTRUCTION_FACTS = 3;
const MAX_ENV_CHECKS = 10;

/** Spec §6.3's exact patterns; each captures the variable name. */
const ENV_PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/,
  /\bprocess\.env\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/,
  /\bos\.getenv\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bos\.environ\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/,
  /\bos\.environ\.get\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bSystem\.getenv\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bos\.Getenv\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bENV\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/,
  /\bENV\.fetch\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bos\.LookupEnv\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bos\.environ\.setdefault\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bEnvironment\.get\(["']([A-Za-z_][A-Za-z0-9_]*)["']/,
  /\bProcessInfo\.processInfo\.environment\[["']([A-Za-z_][A-Za-z0-9_]*)["']\]/,
];

/** The first line in `text` containing `token` verbatim (1-based), or undefined. */
function findLine(text: string, token: string): number | undefined {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (lines[i]!.includes(token)) return i + 1;
  return undefined;
}

function locate(file: string, line: number | undefined): string {
  return line === undefined ? file : `${file}:${line}`;
}

/** Declared-symbol name on a line `isPublicDeclaration` already accepted, for the fact text. */
function declName(path: string, line: string): string | undefined {
  const lang = languageOf(path);
  const trimmed = line.trim();
  switch (lang) {
    case "js":
      return (
        /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1] ??
        /^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1] ??
        /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)/.exec(trimmed)?.[1]
      );
    case "python":
      return /^(?:async\s+def|def|class)\s+([A-Za-z_]\w*)/.exec(trimmed)?.[1];
    case "go":
      return /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/.exec(trimmed)?.[1] ?? /^(?:type|var|const)\s+([A-Za-z_]\w*)/.exec(trimmed)?.[1];
    case "java":
    case "kotlin":
      return /\b(?:class|interface|object|fun)\s+([A-Za-z_]\w*)/.exec(trimmed)?.[1] ?? /([A-Za-z_]\w*)\s*\(/.exec(trimmed)?.[1];
    case "rust":
      return /^pub(?:\([^)]*\))?\s+(?:async\s+)?(?:fn|struct|enum|trait|const|static|type|mod)\s+([A-Za-z_]\w*)/.exec(trimmed)?.[1];
    default:
      return undefined;
  }
}

function envNamesIn(text: string): string[] {
  const names: string[] = [];
  for (const re of ENV_PATTERNS) {
    const m = re.exec(text);
    if (m) names.push(m[1]!);
  }
  return names;
}

/** `git grep -F` for `name` anywhere in the tree at `ctx.diff.base`. */
async function existsAtBase(ctx: ScoringContext, name: string): Promise<boolean> {
  const out = await gitMaybe(ctx.repoDir, ["grep", "-F", "-q", "-e", name, ctx.diff.base, "--"]);
  return out !== undefined;
}

/** Spec §6.3: new dependencies, broken public contracts, schema/contract file changes, and new environment variables. */
export const detectContracts: Detector = async (ctx) => {
  const facts: ArchitectureFact[] = [];
  const notes: string[] = [];
  const files = ctx.diff.files.filter((f) => !f.ignored);

  // contract.dependency
  for (const f of files) {
    if (!isManifestPath(f.path)) continue;
    const headText = await ctx.readHead(f.path);
    if (headText === undefined) continue; // deleted manifest: nothing new to add
    const baseText = await ctx.readBase(f.oldPath ?? f.path);
    const result = addedPackages(f.path, baseText, headText);
    if ("error" in result) {
      notes.push(`contract.dependency: ${code(f.path)} did not parse: ${untrusted(result.error)}`);
      continue;
    }
    for (const name of result.runtime) {
      const line = findLine(headText, name);
      facts.push({ id: "contract.dependency", weight: "strong", file: f.path, line, text: `New runtime dependency ${code(name)} (${code(locate(f.path, line))}).` });
    }
    for (const name of result.dev) {
      const line = findLine(headText, name);
      facts.push({ id: "contract.dependency", weight: "info", file: f.path, line, text: `New development dependency ${code(name)} (${code(locate(f.path, line))}).` });
    }
  }

  // contract.api
  for (const f of files) {
    if (f.binary) continue;
    const basePath = f.oldPath ?? f.path;
    const addedDecls: Array<{ name: string; line: number }> = [];
    const deletedDecls: Array<{ name: string; line: number }> = [];
    for (const h of f.hunks) {
      for (const { kind, line, text } of changedLines(h)) {
        const path = kind === "+" ? f.path : basePath;
        if (!isPublicDeclaration(path, text)) continue;
        const name = declName(path, text);
        if (!name) continue;
        (kind === "+" ? addedDecls : deletedDecls).push({ name, line });
      }
    }
    if (deletedDecls.length > 0) {
      const dependents = ctx.graph?.dependentsOf(basePath).length ?? 0;
      if (dependents > 0) {
        for (const d of deletedDecls) {
          facts.push({
            id: "contract.api",
            weight: "strong",
            file: basePath,
            line: d.line,
            text: `Removes or changes exported ${code(d.name)} (${code(locate(basePath, d.line))}), imported by ${plural(dependents, "file")}.`,
          });
        }
      }
    } else if (addedDecls.length > 0 && f.status !== "added") {
      // Same evidence requirement as a deletion (spec §6.3): a dependent at base makes the
      // addition a decision to sign off; a file with no dependent, or no file at base at all, is
      // editor trivia.
      const dependents = ctx.graph?.dependentsOf(basePath).length ?? 0;
      if (dependents > 0) {
        const shown = addedDecls.slice(0, 3).map((a) => code(a.name));
        const names = shown.join(", ") + (addedDecls.length > 3 ? ", …" : "");
        facts.push({
          id: "contract.api",
          weight: "info",
          file: f.path,
          line: addedDecls[0]!.line,
          text: `Adds ${plural(addedDecls.length, "exported declaration")} to ${code(f.path)} (${names}).`,
        });
      }
    }
  }

  // contract.schema
  const schemaGlobs = [...DEFAULT_SCHEMA_GLOBS, ...ctx.config.captain.contracts.paths];
  const schemaFiles = files.filter((f) => matchAny(schemaGlobs, f.path)).map((f) => f.path).sort();
  for (const path of schemaFiles.slice(0, MAX_SCHEMA_FACTS)) {
    facts.push({ id: "contract.schema", weight: "strong", file: path, text: `Changes schema or contract file ${code(path)}.` });
  }
  if (schemaFiles.length > MAX_SCHEMA_FACTS) notes.push(plural(schemaFiles.length - MAX_SCHEMA_FACTS, "more schema file"));

  // contract.instructions
  const instructionFiles = files.filter((f) => matchAny(ctx.config.paths.instructions, f.path, { ignoreCase: true })).map((f) => f.path).sort();
  for (const path of instructionFiles.slice(0, MAX_INSTRUCTION_FACTS)) {
    facts.push({ id: "contract.instructions", weight: "strong", file: path, text: `Changes agent instructions: ${code(path)}.` });
  }
  if (instructionFiles.length > MAX_INSTRUCTION_FACTS) notes.push(plural(instructionFiles.length - MAX_INSTRUCTION_FACTS, "more instruction file"));

  // contract.env
  const envCandidates: Array<{ name: string; file: string; line: number }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    if (f.binary) continue;
    // Spec §6.3 targets source, not documentation or the tests exercising it (both false-fired
    // in dogfooding: a plan doc's example and a test's literal env var name).
    if (isTestPath(ctx.config, f.path) || languageFamily(f.path) === "docs") continue;
    for (const h of f.hunks) {
      for (const { kind, line, text } of changedLines(h)) {
        if (kind !== "+") continue;
        for (const name of envNamesIn(text)) {
          if (seen.has(name)) continue;
          seen.add(name);
          envCandidates.push({ name, file: f.path, line });
        }
      }
    }
  }
  const toCheck = envCandidates.slice(0, MAX_ENV_CHECKS);
  for (const c of toCheck) {
    if (await existsAtBase(ctx, c.name)) continue;
    facts.push({ id: "contract.env", weight: "strong", file: c.file, line: c.line, text: `Reads a new environment variable ${code(c.name)} (${code(locate(c.file, c.line))}).` });
  }
  const skipped = envCandidates.length - toCheck.length;
  if (skipped > 0) notes.push(`contract.env: ${plural(skipped, "more new environment variable")} not checked`);

  return { facts, notes };
};
