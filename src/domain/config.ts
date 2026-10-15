import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { OpendrsError } from "./types.js";

export const CONFIG_FILE = ".opendrs.yml";

const thresholdsSchema = z
  .object({
    mode: z.enum(["absolute", "percentile"]).default("absolute"),
    green: z.number().min(0).max(100).default(0.3),
    yellow: z.number().min(0).max(100).default(0.6),
    red: z.number().min(0).max(100).default(0.8),
  })
  .superRefine(({ mode, green, yellow, red }, ctx) => {
    const ok = mode === "absolute" ? 0 <= green && green < yellow && yellow <= red && red <= 1 : 0 < green && green < yellow && yellow <= red && red < 100;
    if (ok) return;
    const rule = mode === "absolute" ? "0 ≤ green < yellow ≤ red ≤ 1 (scores)" : "0 < green < yellow ≤ red < 100 (percentiles)";
    ctx.addIssue({ code: "custom", message: `${mode} thresholds must satisfy ${rule}; got green ${green}, yellow ${yellow}, red ${red}` });
  });

/** Why a glob would silently match nothing (or the wrong thing) in our matcher, if it would. */
function globProblem(glob: string): string | undefined {
  if (/[[\]]/.test(glob)) return "uses [ or ], which are not supported (they match literally)";
  if (glob.includes("\\")) return "contains \\; use forward slashes";
  if (glob.startsWith("/") || glob.startsWith("./")) return "has a leading / or ./; globs match repo-relative paths like src/**";
  return undefined;
}

const globs = (defaults: string[]) =>
  z
    .array(
      z.string().superRefine((glob, ctx) => {
        const problem = globProblem(glob);
        if (problem) ctx.addIssue({ code: "custom", message: `glob "${glob}" ${problem}` });
      }),
    )
    .default(defaults);

/** Default `paths.block`. A config's own `block` adds to it; only `paths.unblock` removes an entry. */
export const DEFAULT_BLOCK: readonly string[] = [
  ".github/**",
  ".opendrs.yml",
  ".opendrs/**",
  "**/CODEOWNERS",
  "**/migrations/**",
  "**/migration/**",
  "**/migrate/**",
  "**/*.tf",
  ".gitmodules",
  "**/.gitattributes",
  // Files that execute code on install, build or CI.
  "**/package.json",
  "**/.npmrc",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.pnpmfile.cjs",
  "**/setup.py",
  "**/setup.cfg",
  "**/pyproject.toml",
  "**/pip.conf",
  "**/build.gradle",
  "**/build.gradle.kts",
  "**/settings.gradle*",
  "**/gradle/wrapper/**",
  "**/pom.xml",
  "**/.mvn/**",
  "**/Cargo.toml",
  "**/build.rs",
  "**/go.mod",
  "**/Gemfile",
  "**/Rakefile",
  "**/*.gemspec",
  "**/requirements*.txt",
  "**/conftest.py",
  "**/.pre-commit-config.y*ml",
  "**/tox.ini",
  "**/noxfile.py",
  "**/*.csproj",
  "**/*.sln",
  "**/Directory.Build.*",
  "**/nuget.config",
  "**/CMakeLists.txt",
  "**/*.cmake",
  "**/.cargo/**",
  "**/.husky/**",
  "**/Makefile",
  "**/GNUmakefile",
  "**/*.mk",
  "**/Dockerfile*",
  "**/docker-compose*.y*ml",
  "**/compose.y*ml",
  "**/Brewfile",
  "**/Vagrantfile",
  "**/Procfile",
  "**/*.nix",
  "**/flake.lock",
  "**/.devcontainer/**",
  "**/.envrc",
  "**/Taskfile.y*ml",
  "**/justfile",
  ".gitlab-ci.yml",
  "Jenkinsfile",
  ".circleci/**",
  "azure-pipelines.yml",
  ".buildkite/**",
  "**/bitbucket-pipelines.yml",
  "**/.drone.yml",
  "**/.travis.yml",
  "**/cloudbuild.y*ml",
  "**/Earthfile",
  "**/BUILD",
  "**/BUILD.bazel",
  "**/WORKSPACE*",
  "**/MODULE.bazel",
  "**/*.bzl",
];

/** Default `paths.critical`. A config's own `critical` adds to it. */
export const DEFAULT_CRITICAL: readonly string[] = ["**/auth/**", "**/payment*/**", "**/billing/**", "**/security/**"];

/** An unblock entry must name a default block glob exactly, so a typo cannot pass silently. */
function unblockable(glob: string, ctx: z.RefinementCtx): void {
  if (DEFAULT_BLOCK.includes(glob)) return;
  ctx.addIssue({
    code: "custom",
    message: `paths.unblock entry "${glob}" is not a default paths.block glob; valid entries: ${DEFAULT_BLOCK.map((g) => `"${g}"`).join(", ")}`,
  });
}

const union = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])];

export const configSchema = z.object({
  thresholds: thresholdsSchema.prefault({}),
  autoApprove: z
    .object({
      enabled: z.boolean().default(false),
      requireAiReview: z
        .object({
          checks: z.array(z.string()).default([]),
          // Removed in 0.1.1; kept only so that a config still listing it fails with a clear error.
          labels: z
            .undefined({
              error:
                "requireAiReview.labels was removed in 0.1.1: labels are not tied to a commit and can be added by anyone with triage access; " +
                "require a check run instead (requireAiReview.checks)",
            })
            .optional(),
        })
        .prefault({}),
      mergeMethod: z.enum(["queue", "auto-merge", "none"]).default("queue"),
      sampleRate: z.number().min(0).max(1).default(0.1),
      maxChangedLines: z.number().int().positive().default(400),
    })
    .prefault({}),
  paths: z
    .object({
      block: globs([]),
      critical: globs([]),
      unblock: z.array(z.string().superRefine(unblockable)).default([]),
      ignore: globs([
        "**/*.lock",
        "**/package-lock.json",
        "**/pnpm-lock.yaml",
        "**/go.sum",
        "**/dist/**",
        "**/vendor/**",
        "**/node_modules/**",
        "**/*.min.js",
        "**/*.snap",
      ]),
      tests: globs([
        "**/test/**",
        "**/tests/**",
        "**/__tests__/**",
        "**/*.test.*",
        "**/*.spec.*",
        "**/*_test.*",
        "**/test_*.py",
      ]),
    })
    // block and critical extend the defaults (ignore and tests replace theirs); unblock wins over both.
    .transform((p) => ({
      ...p,
      block: union(DEFAULT_BLOCK, p.block).filter((g) => !p.unblock.includes(g)),
      critical: union(DEFAULT_CRITICAL, p.critical),
    }))
    .prefault({}),
  llm: z
    .object({
      enabled: z.boolean().default(false),
      provider: z.enum(["anthropic", "openai"]).default("anthropic"),
      model: z.string().default("claude-sonnet-5"),
      baseUrl: z.string().optional(),
      apiKeyEnv: z.string().optional(),
      includeDescription: z.boolean().default(false),
      maxDiffChars: z.number().int().positive().default(60_000),
    })
    .prefault({}),
  history: z
    .object({
      lookbackDays: z.number().int().positive().default(365),
      fixPattern: z.string().default("\\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\\d?|revert)\\b"),
      maxCommits: z.number().int().positive().default(20_000),
    })
    .prefault({}),
  graph: z
    .object({
      enabled: z.boolean().default(true),
      maxDepth: z.number().int().min(1).max(10).default(3),
      maxFiles: z.number().int().positive().default(50_000),
    })
    .prefault({}),
  /** Path to calibrated model JSON, relative to repo root. Used when it exists. */
  model: z.string().default(".opendrs/model.json"),
});

export type OpendrsConfig = z.infer<typeof configSchema>;

export function parseConfig(raw: unknown): OpendrsConfig {
  const result = configSchema.safeParse(raw ?? {});
  if (!result.success) {
    throw new OpendrsError(`Invalid ${CONFIG_FILE}: ${z.prettifyError(result.error)}`, "config");
  }
  return result.data;
}

export const defaultConfig = (): OpendrsConfig => parseConfig({});

/** Load .opendrs.yml from a directory; missing file means defaults. */
export async function loadConfig(repoDir: string): Promise<OpendrsConfig> {
  let text: string;
  try {
    text = await readFile(join(repoDir, CONFIG_FILE), "utf8");
  } catch {
    return defaultConfig();
  }
  return parseConfigText(text);
}

/** Parse YAML text (e.g. config read from the base branch via `git show`). */
export function parseConfigText(text: string): OpendrsConfig {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    throw new OpendrsError(`Invalid ${CONFIG_FILE}: ${(e as Error).message}`, "config");
  }
  return parseConfig(raw);
}
