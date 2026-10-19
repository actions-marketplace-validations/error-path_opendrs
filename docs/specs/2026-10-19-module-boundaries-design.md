# Module boundaries: a better unit for the captain brief's layers detector

Status: draft spec, written 2026-10-19 for the user's review. Nothing is built yet. Refines
`docs/specs/2026-10-19-captain-brief-design.md` §6.2 and §9 (the layers detector's module unit)
ahead of that spec's rollout phase 2. Based on `docs/research/2026-10-19-field-test.md`'s
module-boundary findings (theme 3) and the six repos' raw notes in
`~/.cache/opendrs/field-test/notes/`. This document needs approval before an implementation plan
is written.

## 1. Goal and non-goals

**Goal.** Give `moduleOf(path)` a definition of "module" a captain would recognise: a unit with
one owner and one API boundary — a package, a crate, a Go package directory, a gem, a Swift
target. The layers detector (`layers.edge`, `layers.cycle`) and the drift detector's "outside the
original modules" check both key off this unit (`docs/specs/2026-10-19-captain-brief-design.md`
§6.2, §6.4). Today's unit — the first `captain.moduleDepth` path segments from the repo root,
default 2 — was tested against six repos' real layouts and was wrong for all of them (field test,
theme 3).

The new definition must:

- come from structure the repo itself declares (a manifest, a workspace file, a language's own
  packaging convention), not from guesses about import frequency or file count;
- stay stable across one PR's base→head diff: a file's module does not move because an unrelated
  file elsewhere was touched;
- reuse the tree-sha cache `buildDependencyGraph` already has (`src/graph/graph.ts`), not add a
  second cache with its own invalidation rules.

**Non-goals.**

- Not a layering-rules engine ("module A may not import module B"). That is explicitly out of
  scope for opendrs (`docs/specs/2026-10-19-captain-brief-design.md` §3); dependency-cruiser and
  ArchUnit already do it.
- Not ownership-based grouping (CODEOWNERS-driven modules). Directory- and manifest-based only,
  this phase.
- Not a fix for coupling through generated code. vite's one confirmed node↔client coupling
  (182f5b2a6) is a JS template-literal string, not a literal `import`; no module definition
  changes that (field test, vite note, "Module boundaries" section).
- Not per-PR tuning. The module map is computed once per commit, the same way the import graph is,
  and read from the base commit's config like everything else (§9 of the captain-brief spec).

## 2. Approach options

**(a) Auto-detect package roots from manifests, then module = package root + one segment under
its source dir.** Parse `package.json` `workspaces` / `pnpm-workspace.yaml`, Cargo workspace
`members`, `go.mod` (where a Go package is just a directory, so no parsing is even needed), `.gemspec`,
`pyproject.toml`/`setup.cfg` `packages`, and `Package.swift` targets. Most of this is not new work:
`src/graph/resolve-js.ts` already indexes every `package.json` with a `name` field and its
directory for import resolution; `src/graph/resolve.ts`'s `goModuleIndex` already indexes every
`go.mod`'s module path and directory; `rustCrateSrc` already walks up to the nearest `Cargo.toml`
per file. This option turns those existing indexes into module roots instead of building new
parsers.

- *Trade-off:* correct for every layout in the field test (§4). Needs a per-ecosystem rule, and a
  fallback for repos with no manifest opendrs understands.

**(b) Per-language path-shape heuristics only** (skip a bare `src`/`lib`/`pkg`/`internal` segment
when counting depth, no manifest reads).

- *Trade-off:* zero parsing, fixes black's and actix-web's *bare-`src`* case for free. Cannot find
  a monorepo's package root (vite's problem is not "skip `src`", it is "stop at
  `packages/vite`, not the repo root") — on its own it does not fix vite, cli-cli or fastlane.
  Useful as part of (a)'s rule (see §3), not as a standalone option.

**(c) User-declared `captain.modules` globs** (e.g. `packages/*/src/*`, `<crate>/src/*`), overriding
auto-detection.

- *Trade-off:* exact, by construction, for whatever the user writes. Costs the user per-repo setup
  before they see any benefit, so it will not be most repos' experience. Right as an escape hatch,
  wrong as the default.

**Recommendation.** (a) as the default, with (b)'s segment-skipping folded into (a)'s per-ecosystem
rules (not a separate mode), and (c) as a named override for the cases (a) cannot reach — vite's
node/client split is semantic, not manifest-declared, and is the one case in the field test that
auto-detection alone will not fix. `captain.moduleDepth` remains as the final fallback, unchanged
in meaning, for files in a language or layout none of the above recognises.

## 3. The recommended algorithm

**Inputs.** The file list `buildDependencyGraph` already produces (`graph.files`), and the text of
each ecosystem's manifest files. `package.json` and `go.mod` are already read into the graph's
resolver (`CONFIG_FILES` in `src/graph/graph.ts`); `Cargo.toml`, `*.gemspec`, `pyproject.toml`,
`setup.cfg` and `Package.swift` would join that set.

**Resolution order, first match wins, per changed or imported file:**

1. **`captain.modules` configured** (§5): the file's module is the longest matching glob's literal
   prefix (the part before the first `*`). User override always wins.
2. **A package root is found** for the file's language (the per-ecosystem rules below): module =
   root + the first path segment beneath a conventional source prefix under that root (`src/`,
   `lib/`, `Sources/<Target>/` — and, for Ruby, a segment that repeats the gem's own name directly
   under `lib/`, since `<gem>/lib/<gem>/...` is the common layout). If the file sits directly in
   the source root with no further segment, the module is the root itself.
3. **No package root found** (unsupported language, or no manifest in the file's ancestry): fall
   back to today's rule, the first `captain.moduleDepth` segments from the repo root.

**Caching.** Package roots are derived only from files `buildDependencyGraph` already reads and
already caches by tree sha (`graph-${treeSha}.json`, `src/graph/graph.ts`). They become one more
field on that cached structure. No new cache file, no new invalidation rule: the existing tree-sha
key already guarantees the manifests have not changed since the cache entry was written. Base and
head are computed separately, exactly as the two import graphs already are, so a package added in
this PR is picked up at head the same way a brand-new module is today (captain-brief spec §6.2's
"a module with no covered file at base" rule is unaffected).

**Notes shown to the captain.** The layers detector's note list gains one line naming how the
module map was built, visible in the AI brief (captain-brief spec §6.5):

- `"modules: auto-detected 12 packages from pnpm-workspace.yaml"`
- `"modules: auto-detected 11 crates from Cargo.toml workspace members"`
- `"modules: 41 Go packages (one per directory)"`
- `"modules: no package manifest found for this language; falling back to moduleDepth: 2"`

This answers, in one line, the question every field-test note had to answer by hand: why is this
the module boundary.

**Per-ecosystem package-root rules:**

| Ecosystem | Package root | Notes |
|---|---|---|
| JS/TS (npm, pnpm, yarn) | Any directory with a `package.json` that has a `name` field | Reuses `resolve-js.ts`'s existing `packages` index; no new parsing |
| Go | Every directory is its own package | No manifest needed; `go.mod` still used for cross-module import resolution only |
| Rust (Cargo) | Any directory with a `Cargo.toml` | Generalizes `rustCrateSrc`'s per-file ancestor search (`src/graph/resolve.ts`) into a precomputed index, the same shape as `goModuleIndex` |
| Ruby | Any directory with a `*.gemspec` | Skip one more segment when it repeats the gem's own name under `lib/` |
| Python | Any directory with `pyproject.toml` or `setup.cfg` | `src/<pkg>` layout: skip the bare `src` segment. No subdirectories under the root: module is the root itself (see black, §4) |
| Swift | Each `Package.swift` `.target(name:, path:)` | Default path `Sources/<Name>` when `path` is omitted |

## 4. Worked examples: the six field-test repos

| Repo | Rule | Example path | Today (`moduleDepth: 2`) | New algorithm |
|---|---|---|---|---|
| vite | JS, `package.json` per package | `packages/vite/src/node/server/index.ts` | `packages/vite` | `packages/vite/src/node` |
| actix-web | Rust, `Cargo.toml` per crate | `actix-http/src/h1/dispatcher.rs` | `actix-http/src` | `actix-http/src/h1` |
| cli/cli | Go, directory = package | `pkg/cmd/issue/create/create.go` | `pkg/cmd` | `pkg/cmd/issue/create` |
| fastlane | Ruby, `.gemspec` per tool | `fastlane/lib/fastlane/actions/upload_to_play_store.rb` | `fastlane/lib` | `fastlane/lib/fastlane` (see §8: still one module for all 400+ actions) |
| black | Python, `pyproject.toml` at root, `src/` layout | `src/black/linegen.py` | `src/black` | `src/black` (unchanged: a flat package has no finer boundary to find, see §8) |
| vapor | Swift, single target | `Sources/Vapor/HTTP/Headers.swift` | `Sources/Vapor` | `Sources/Vapor` (unchanged: one target) |

vite, actix-web and cli/cli each gain the boundary the field test asked for. fastlane and black are
each a genuine structural limit, not a bug the algorithm missed — see §8.

## 5. Config changes

Backward compatible. `captain.moduleDepth` keeps its exact current meaning and default (2); setting
it explicitly in `.opendrs.yml` is read as "skip auto-detection for this repo, use flat depth
everywhere," so a repo that has already tuned it keeps its current behaviour unchanged. New,
optional keys:

```yaml
captain:
  moduleDepth: 2            # unchanged: explicit depth, disables auto-detection repo-wide
  modules: []                # new: literal globs, e.g. ["packages/*/src/*"]; highest precedence
```

Nothing changes for a repo with neither key set beyond today's default: it now gets auto-detection
instead of a flat depth-2 split, which is strictly more accurate per §4, never less.

## 6. Effect on other detectors

- **`layers.ts`** (`layers.edge`, `layers.cycle`): uses `moduleOf` directly (`moduleAdjacency`,
  §6.2 of the captain-brief spec). This is the detector the change targets.
- **`drift.ts`** (`drift.scope`): uses `moduleOf` to decide whether growth since the first scored
  head left the PR's original modules (§6.4). Finer modules mean a PR's original file set covers
  fewer, smaller modules, so "outside the original modules" fires somewhat more easily. This is the
  correct direction (a PR that grows into a different Go subcommand package should count as
  leaving its module), but it changes drift's behaviour on existing repos and must be covered by
  drift's own test list re-run (§7), not assumed safe by inspection.
- **`coupling.ts`** (`coupling.missing`): does not call `moduleOf` at all — it works at the file-pair
  level. No change, confirmed by reading the detector; the field test's own account agrees
  (`coupling.missing` was never a documented module-boundary miss).
- **`contracts.ts`**: does not use `moduleOf`. No change.

## 7. Evaluation plan

**Re-run the six field-test repos' PRs.** For each of the ~8 PRs per repo already sampled
(`docs/research/2026-10-19-field-test.md`'s table), re-run `opendrs brief --base <base> --head
<head> --no-llm --json` with the new module algorithm and hand-judge every `layers.edge`/
`layers.cycle` fact the same way the field test did: TRUE+USEFUL, NOISE, WRONG, or MISSED against
the real diff.

**Before** (from the field test, all six repos combined): `layers.edge`/`layers.cycle` fired once,
judged noise once, confirmed missed on at least 5 of 6 repos for structural reasons (fastlane's one
firing was itself judged noise).

**After:** report the same four-way breakdown per repo. Expect more firings on vite, actix-web and
cli/cli (the three repos where §4 changes the module boundary); fastlane and black should be
materially unchanged (§8). A result that shows more noise, not more true positives, on vite or
actix-web is a reason to reconsider the per-ecosystem rule for that language, not to ship it as is.

**Unit tests, one list per ecosystem** (in addition to the existing `layers.ts`/`drift.ts` suites
in captain-brief spec §11, which keep their `moduleDepth` case unchanged as the fallback path):

- **JS:** a pnpm workspace with multiple `package.json` roots; a file directly under a package root
  with no `src/`; a nested `src/` package.
- **Go:** two sibling directories under the same parent are two modules; a file at the repo root
  with no enclosing `go.mod`.
- **Rust:** a workspace with multiple `Cargo.toml`; a crate with `lib.rs` directly under its crate
  root (no `src/` subdirectory to skip, since Cargo always uses `src/` — covers the "root with no
  further segment" branch).
- **Ruby:** a gemspec root; the `lib/<gemname>/` skip rule; a tool directory with no nested
  `lib/<name>/` (most of fastlane's smaller tool dirs).
- **Python:** `pyproject.toml` with a `src/` layout; a flat package with no `src/` and no further
  subdirectories (black's core: module = the root, no crash, no infinite split attempt).
- **Swift:** a single-target `Package.swift`; a multi-target one.
- **Fallback and precedence:** no manifest found falls back to `moduleDepth`; `captain.modules`
  overrides auto-detection when both are present; an explicit `moduleDepth` in config disables
  auto-detection.
- **Cache:** module roots come from the already-cached graph data; a second `brief` run on the same
  tree sha does not re-read any manifest.

## 8. Risks and open questions

- **fastlane's double nesting is only partly fixed.** `<gem>/lib/<gem>/actions/*.rb` still
  collapses all 150+ actions into one module after the gem-name skip rule, because the rule only
  skips one repeated segment. Is a second, equally generic rule worth adding (e.g. "skip one more
  segment when it is itself a directory with 50+ files"), or is this left as a documented
  limitation, the same way black's flat core is?
- **black's flat core cannot be split further by any path-based rule**, auto-detected or not: there
  are no subdirectories under `src/black/` to use as a boundary. Worth stating plainly in
  `docs/captain.md` so a captain does not read a quiet `layers.edge` as a bug.
- **Go's "one module per directory" is a bigger behaviour change than the other four ecosystems.**
  It is structurally correct (a directory is a Go package), but it has not been tested against a
  large Go monorepo for `layers.edge` noise volume, only against cli/cli's specific `pkg/cmd`
  complaint. The evaluation in §7 should watch this repo's noise rate specifically.
- **Should `captain.modules` ship in v1 at all?** It is the only piece of this design that needs a
  user to write anything, and vite's actual missed case (node vs. client) needs exactly that, since
  it is not manifest-declared. Shipping it unused is low-cost; the open question is whether to
  document it prominently (e.g. suggest `packages/*/src/*` for a detected pnpm layout) or leave it
  as a quiet escape hatch until there is real usage data.
- **Manifest-reading cost on large monorepos.** Rust, Ruby and Python package-root detection reads
  every matching manifest in the tree, not just changed ones (the same shape `goModuleIndex`
  already accepts for `go.mod`). Should this share `graph.maxFiles`'s existing cap, or get its own,
  for a repo with thousands of fixture `Cargo.toml`/`gemspec` files?
- **Documentation debt.** `docs/captain.md`'s one-line module definition ("by default the first two
  path segments...") needs a full rewrite to match §3. Confirm this lands in the captain-core
  documentation pass (captain-brief spec §12 phase 1) or as part of this phase's own implementation.
