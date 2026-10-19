# Module Boundaries Implementation Plan

**Goal:** Give `moduleOf` a per-ecosystem definition of "module" (package/crate/gem/target root, auto-detected
from the repo's own manifests), used by `layers.edge`/`layers.cycle` and `drift.scope`, with a
`captain.modules` glob override and a flat-depth fallback. Gated on re-running the field-test PRs
(spec §7) without increasing noisy/wrong `layers.*` facts on cli/cli.

**Spec:** `docs/specs/2026-10-19-module-boundaries-design.md` (approved 2026-10-19). Section numbers
below refer to it.

**Tech stack:** TypeScript (ESM, Node ≥ 22), zod config, vitest.

## Global constraints

- Surgical changes only (`andrej-karpathy-skills:karpathy-guidelines`): the existing flat `moduleOf(path,
  depth)` in `src/architecture/module.ts` and its test are left untouched; the new resolver is added
  alongside it, not a rewrite.
- No new cache file and no new file-count cap: package roots are derived only from
  `buildDependencyGraph`'s already-capped, already tree-sha-cached file list (§3, §8 resolution 4).
- `coupling.ts` and `contracts.ts` do not call `moduleOf`; out of scope (§6).
- `npx tsc --noEmit` and the scoped vitest run (`tests/architecture`, `tests/graph`,
  `tests/domain/config.test.ts`) must pass before each commit. Do not run the full `npm run check` or
  `npm run build:action` (the orchestrator runs one combined check later).
- Never edit `CHANGELOG.md`.

## Task 1: Config — `captain.modules`, `captain.moduleDepth` becomes optional

**Files:** `src/domain/config.ts`, `tests/domain/config.test.ts`

- `captain.moduleDepth`: drop `.default(2)`, keep `.int().min(1).max(6).optional()`. Unset means
  "auto-detect"; a resolver downstream treats `undefined` as "use depth 2 only as the no-manifest
  fallback", and any explicit value as "skip auto-detection repo-wide" (§5).
- New `captain.modules: globs([])` — literal globs, highest precedence (§3 step 1, §5).
- Update the existing "defaults to enabled with moduleDepth 2" test for the new shape; add a test for
  `captain.modules` defaulting to `[]` and round-tripping.

## Task 2: Package-root index — `src/graph/package-roots.ts` (new)

**Files:** `src/graph/package-roots.ts`, `tests/graph/package-roots.test.ts`

`computePackageRoots(files, contents): PackageRootIndex` with one array per ecosystem (`js`, `rust`,
`ruby`, `python`, `swift`), each sorted longest-path-first. Rust/Ruby/Python are filename-existence
checks over the already-capped `files` list (`Cargo.toml`, `*.gemspec`, `pyproject.toml`/`setup.cfg`)
— no content read needed. JS reuses `resolve-js.ts`'s exported `parseJsonc` to check a `package.json`
has a `name` field. Swift parses `.target(name:, path:)`/`.executableTarget(...)` calls out of
`Package.swift` by paren-balance (same technique as `manifests.ts`'s `.package(...)` scanner, not
shared code — different file, small enough to not be worth a cross-file dependency).

**Tests:** JS (name-field present/absent/invalid JSON), Rust/Ruby/Python existence indexing,
Swift (single target default path, multi-target explicit paths, unterminated call).

## Task 3: Module resolver — `src/architecture/module.ts` (extend)

**Files:** `src/architecture/module.ts`, `tests/architecture/module-resolver.test.ts`

Add `buildModuleResolver(files, roots, config): { moduleOf, notes }` implementing §3's resolution
order: `captain.modules` glob (longest literal prefix before the glob's first `*`) → per-ecosystem
package root + one conventional-prefix segment (`src`/`lib` for JS, `lib` for Ruby, `src` for
Python/Rust; Go is `dirOf(path)` unconditionally, no manifest needed; Swift's target root *is* the
module, no further split) → flat `moduleOf(path, fallbackDepth)`. `fallbackDepth = moduleDepth ?? 2`;
auto-detection runs only when `moduleDepth` is unset.

Also builds the "Notes shown to the captain" lines (§3): one per ecosystem actually present in
`files`, naming the detected count or the fallback; or a single override/disabled line when
`captain.modules` or an explicit `moduleDepth` is set.

**Tests (one list per ecosystem, per spec §7):** JS (pnpm workspace multi-root, root with no `src/`,
nested `src/`), Go (two sibling dirs are two modules, root file with no `go.mod`), Rust (multi-`Cargo.toml`
workspace, `lib.rs` directly under crate root), Ruby (gemspec root, the `lib/<gemname>/` repeat
collapsing to one module as documented in §8, a tool dir with no nested `lib/<name>/`), Python
(`src/` layout, flat package with no subdirectories), Swift (single-target, multi-target),
fallback/precedence (no manifest → moduleDepth; `captain.modules` overrides auto-detection; explicit
`moduleDepth` disables it), and the note line (per-ecosystem, fallback, override, disabled).

## Task 4: Wire into the graph cache — `src/graph/graph.ts`

**Files:** `src/graph/graph.ts`, `tests/graph/graph.test.ts`

- `CONFIG_FILES` gains `Package.swift` (only file beyond today's set whose *contents* the new index
  needs; `package.json`'s contents were already read).
- `computeGraph` calls `computePackageRoots(files, contents)` and stores the result as a new
  `moduleRoots` field on the cached `GraphData`; bump `CACHE_VERSION` so old cache files (missing the
  field) are treated as a miss, not a corrupt read.
- `toGraph(data, config)` (now takes `config`) builds `moduleOf`/`moduleNotes` via
  `buildModuleResolver(files, data.moduleRoots, config)` and exposes them on `RepoGraph`. Config
  (`captain.modules`/`moduleDepth`) is applied fresh on every call — only the ecosystem roots
  themselves are cached — so changing config does not require a cache bust.

**Tests:** a cache-reuse test following the file's existing pattern (mutate the written cache JSON's
`moduleRoots.js` entry, rebuild on the same tree sha, and observe `moduleOf` reflect the mutated
value for a path that was never a real manifest on disk — proof the second build never re-read any
manifest).

## Task 5: `layers.ts` and `drift.ts` — use the new resolver

**Files:** `src/architecture/layers.ts`, `src/architecture/drift.ts`, `tests/architecture/layers.test.ts`,
`tests/architecture/drift.test.ts`

- `layers.ts`: `moduleAdjacency`/`firstEdgeFile` take a `RepoGraph` and call `graph.moduleOf(path)`
  instead of the flat `moduleOf(path, depth)`; base and head each use their own graph's `moduleOf`
  (different manifests at base vs. head are expected and already handled, §3 "Caching"). The
  detector's returned `notes` is now `head.moduleNotes` instead of always `[]`.
- `drift.ts`: builds `buildDependencyGraph(ctx.repoDir, ctx.diff.head, ctx.config)` (only when
  `graph.enabled`; a disabled graph or a failed build falls back to the flat `moduleOf`, same as
  before) and uses its `moduleOf` for both `F1` and `Fn`'s module sets.

**Tests:** one layers.test.ts case proving auto-detection splits a monorepo package's `src/node` vs.
`src/client` into separate modules end-to-end (the vite shape from the field test) and fires
`layers.edge`; two drift.test.ts cases — one showing the new resolver splits a package finer than the
old flat depth-2 fallback did (so a file moving between the package's subdirectories now counts as
"outside"), one showing a file in the same auto-detected module still does not count. Existing
layers/drift tests that used plain `src/<x>/file.ts` fixtures with no manifest are unaffected (they
exercise the fallback path, same result as before) except the one test that asserted empty `notes`,
updated to expect the new fallback note line.

## Task 6: Docs (same PR, per spec §8 resolution 5)

**Files:** `docs/captain.md`, `docs/configuration.md`

Rewrite `captain.md`'s one-line module definition into a short paragraph naming the per-ecosystem
rules, the two documented structural limits (fastlane, a flat Python package), the notes line, and
the two overrides (`captain.modules`, explicit `moduleDepth`). Update both docs' `captain:` YAML
examples (`moduleDepth` commented out with an explanation, `modules: []` added) and
`configuration.md`'s one-line `captain` summary.

## Task 7: Evaluation gate (spec §7, §8 resolution 1)

Build the CLI; re-run the field-test's cli/cli, vite and actix-web PRs (shas from
`~/.cache/opendrs/field-test/notes/{cli-cli,vite,actix-web}.md`) on `origin/main` and on this branch;
hand-judge every `layers.edge`/`layers.cycle`/`drift.scope` fact TRUE+USEFUL/NOISE/WRONG; record the
before/after table as a new "Evaluation results" section of the spec. Gate: noisy+wrong `layers.*`
facts on cli/cli must not increase. Report honestly either way (spec instructions).
