# Captain Brief Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the captain brief: a priority line (careful / standard / quick) with one named reviewer, and up to five deterministic architecture and history facts, to the PR comment, the AI brief, labels and outputs.

**Architecture:** A new `src/architecture/` module runs four independent detectors (contracts, layers, coupling, drift) over the existing `ScoringContext`. It returns `ArchitectureFact[]` plus notes. `priority.ts` turns tier, facts and policy into a `CaptainPriority`. `buildBrief` stores the result in `ReviewBrief.captain`, and both renderers and the Action read it from there.

**Tech Stack:** TypeScript (ESM, Node ≥ 22), zod config, vitest, esbuild Action bundle.

**Spec:** `docs/specs/2026-10-19-captain-brief-design.md`. Read it in full before your task; section numbers below refer to it.

## Global Constraints

- Never `git push`; never edit `action/dist/` except in Task 7; never edit `CHANGELOG.md` or `docs/*.md` except in Task 7 (and `docs/experiments.md` in Task 4).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (orchestrator) or the worker's own model trailer.
- Brief stays version 1: only optional fields are added (`ReviewBrief.captain?`).
- Every rendered path, package or variable name goes through `untrusted()` from `src/report/escape.ts`.
- One detector throwing must not stop the others or the score: `detectArchitecture` catches per detector and records a note.
- Config is read from the base commit (existing behaviour); `captain.enabled: false` removes the line, block, labels, output and brief section.
- No LLM calls, no time estimates, no raw emails in the captain line.
- `npm run check` (typecheck + vitest) must pass before every commit. Match the surrounding code's comment density and naming; follow `andrej-karpathy-skills:karpathy-guidelines` (surgical changes only).

## Review Focus

1. A PR touching only `action/dist` or other ignored/binary files: `unread-files` fires, and the priority must not become `careful` from it alone (§7.1). Test in Task 1.
2. Paths with Markdown or HTML metacharacters (`` ` ``, `<`, `|`, `*`) in facts must render escaped in both the comment and the brief. Test in Task 1 (rendering) and in each detector's text test.
3. A repo in a language without an import extractor (e.g. C): layers must yield a note, not a crash and not a false "no edges". Test in Task 3.
4. A state marker written by 0.3.x (no `first=`) must still parse and drift must phrase "since run k". Test in Task 5.
5. A manifest with invalid JSON/TOML/XML must yield a note, never a fact or a throw. Test in Task 2.

---

## Execution order

| Wave | Tasks | Branch | Runs |
|---|---|---|---|
| 0 | Task 1 (core) | `feat/captain-brief` | alone, first |
| 1 | Tasks 2, 3, 4, 5 | `feat/captain-contracts`, `feat/captain-layers`, `feat/captain-coupling`, `feat/captain-drift`, each from `feat/captain-brief` after Task 1 | in parallel, each in its own worktree |
| 1 | Task 6 (v0.3.1 fix) | `fix/threshold-decimals` from `main` | in parallel |
| 2 | merge wave 1 into `feat/captain-brief`, then Task 7 | `feat/captain-brief` | after wave 1 |

Wave 1 tasks touch only their own detector file, its tests, and the files listed under each task, so they merge without conflicts.

---

### Task 1: Captain core (types, config, registry, priority, brief, rendering, Action labels and output)

**Files:**
- Modify: `src/domain/types.ts` (add types below), `src/domain/config.ts` (add `captain` block, §9)
- Create: `src/architecture/index.ts`, `src/architecture/priority.ts`, `src/architecture/module.ts`, and four stub detectors `src/architecture/{contracts,layers,coupling,drift}.ts`, each `export const detect…: Detector = async () => ({ facts: [], notes: [] });`
- Modify: `src/brief/build.ts` (call `detectArchitecture` + `captainPriority`, set `brief.captain`), `src/brief/render.ts` (`## For the captain` section; drop `dependents` reasons from `renderFocusBullets`), `src/brief/budget.ts` (captain section is mandatory, never trimmed), `src/report/markdown.ts` (captain line + "For the captain" block above Review focus, §8.1), `src/engine.ts` (pass `opts.brief.firstHead` through), `src/action/run.ts` + `src/action/github.ts` (captain labels, `captain` output, reviewer login), `action.yml` (output `captain`)
- Test: `tests/architecture/priority.test.ts`, `tests/architecture/index.test.ts`, `tests/architecture/module.test.ts`, plus additions to `tests/brief/render.test.ts`, `tests/brief/budget.test.ts`, `tests/report/*.test.ts`, `tests/action/run.test.ts`, `tests/domain/config.test.ts`

**Interfaces (produced, used by every later task):**

```ts
// src/domain/types.ts
export type CaptainPriority = "careful" | "standard" | "quick";
export type ArchitectureFactId = "coupling.missing" | "layers.edge" | "layers.cycle" | "contract.dependency"
  | "contract.api" | "contract.schema" | "contract.env" | "drift.scope";
export interface ArchitectureFact {
  id: ArchitectureFactId;
  weight: "strong" | "info";
  file: string;
  line?: number;
  /** Rendered sentence; untrusted parts already escaped. */
  text: string;
}
export interface CaptainBrief {
  priority: CaptainPriority;
  reviewer?: string;      // GitHub login, Action only
  why: string[];          // ≤ 2, first clause of the first two facts
  facts: ArchitectureFact[];
  notes: string[];
}
// ReviewBrief gains:  captain?: CaptainBrief;

// src/architecture/index.ts
export interface DetectorOptions { firstHead?: string; firstRun?: number }
export interface DetectorResult { facts: ArchitectureFact[]; notes: string[] }
export type Detector = (ctx: ScoringContext, opts: DetectorOptions) => Promise<DetectorResult>;
/** Runs layers, contracts, coupling, drift (that order), catching each; sorts per spec §6.5. */
export async function detectArchitecture(ctx: ScoringContext, opts: DetectorOptions): Promise<DetectorResult>;
/** Spec §6.5: strong first; within weight: layers, contracts, coupling, drift; then file, then line. */
export function sortFacts(facts: ArchitectureFact[]): ArchitectureFact[];

// src/architecture/module.ts
/** Spec §6.2: first `depth` segments of the file's directory; root or shallower files use their directory as is ("" for root). */
export function moduleOf(path: string, depth: number): string;

// src/architecture/priority.ts
/** Spec §7.1, first match wins. `criticalTouched`: a changed file matches paths.critical. */
export function captainPriority(input: { tier: Tier; facts: ArchitectureFact[]; firedRules: PolicyRule[]; criticalTouched: boolean }): CaptainPriority;

// config (src/domain/config.ts), zod with .prefault({}) like the other blocks:
captain: { enabled: boolean /*true*/; moduleDepth: number /*int 1..6, 2*/;
  coupling: { enabled: boolean /*true*/; minSupport: number /*int ≥2, 5*/; minConfidence: number /*0..1, 0.6*/ };
  contracts: { paths: string[] /*[]*/ } }

// BuildBriefOptions (src/brief/build.ts) gains: firstHead?: string; firstRun?: number
// engine opts.brief gains the same two fields and forwards them.
```

- [ ] **Step 1: Write failing tests**
  - `priority.test.ts`: one case per §7.1 row and boundary: red → careful; yellow + strong → careful; yellow + info only → standard; green + strong → standard; green + info only → quick; green + `paths.block` → careful; green + `tests.deleted` → careful; green + `content.block` → careful; green + `criticalTouched` → careful; green + only `unread-files` and `size-cap` → quick (Review Focus 1).
  - `index.test.ts`: a detector that throws yields a note `"<name>: could not run: <message>"` and the other detectors' facts still return; `sortFacts` orders strong before info, then layers < contracts < coupling < drift, then file, then line.
  - `module.test.ts`: `moduleOf("src/auth/token.ts", 2) === "src/auth"`, `moduleOf("src/a/b/c.ts", 2) === "src/a"`, `moduleOf("src/x.ts", 2) === "src"`, `moduleOf("README.md", 2) === ""`, depth 1.
  - render tests: quick with no facts → exactly one line `**Captain: quick confirm**` (plus ` · @login` when set) and no block; careful with 6 facts → line, `**For the captain**`, 5 bullets, `- +1 more in the brief below`; a fact whose file contains `` ` `` and `<` renders escaped (Review Focus 2); Review focus bullets contain no "files depend on it"; AI brief has `## For the captain` with all facts and notes; under `maxTokens: 300` the captain section survives `fitBudget`.
  - config test: defaults and rejection of `moduleDepth: 0`, `minConfidence: 1.5`.
  - run.test.ts (use `tests/action/fake-github.ts`): labels `captain:careful|standard|quick` are created with colours, the stale one is removed on a rerun with a different priority; output `captain` set; the job summary contains the captain line and block; `captain.enabled: false` → no captain label, no output, comment without the line; `brief.captain.reviewer` equals the login passed to the review request.
- [ ] **Step 2:** `npx vitest run tests/architecture tests/brief tests/report tests/action/run.test.ts tests/domain` → the new tests FAIL.
- [ ] **Step 3: Implement.** Labels: add to the label table in `src/action/github.ts` (`captain:careful` `d93f0b` "opendrs: captain should review carefully", `captain:standard` `fbca04` "opendrs: captain standard review", `captain:quick` `0e8a16` "opendrs: captain quick confirm") and manage them in `run.ts` next to the `risk:*` labels with the same stale-removal code. Reviewer: in `run.ts`, compute the login with the same `assignReviewer(logins, seed)` call `requestOneReviewer` uses (factor the login choice out so both use one value); set `brief.captain.reviewer` unless it is the PR author. Comment line format (§8.1): `**Captain: careful review**`, `**Captain: standard review**`, `**Captain: quick confirm**`, then ` · @login` when known, then ` · why: <why[0]>; <why[1]>` when `why` is non-empty and priority is not quick.
- [ ] **Step 4:** `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat(captain): add the captain priority line, labels and output`.

### Task 2: Contracts detector (`contract.*`, spec §6.3)

**Files:** Modify `src/architecture/contracts.ts`; create `src/architecture/manifests.ts` (per-manifest parsers); test `tests/architecture/contracts.test.ts`, `tests/architecture/manifests.test.ts`.

**Interfaces:**
- Consumes: `Detector`, `ArchitectureFact`, `ctx.readBase/readHead`, `ctx.diff.files[].hunks[].lines`, `isPublicDeclaration` (`src/graph/public-decl.ts`), `ctx.graph?.dependentsOf`, `ctx.config.captain.contracts.paths`, glob matcher in `src/git/glob.ts`, `git grep` via `src/git/exec.ts`.
- Produces: `export const detectContracts: Detector`; `export function addedPackages(path: string, base: string | undefined, head: string): { runtime: string[]; dev: string[] } | { error: string }` in `manifests.ts`.

- [ ] **Step 1: Write failing tests**
  - `manifests.test.ts`, one test each: `package.json` (new `dependencies` name → runtime; new `devDependencies` → dev; version bump → nothing), `go.mod`, `requirements.txt` (with `==`, comments, blank lines), `pyproject.toml` (`[project] dependencies` and `[project.optional-dependencies]`), `Cargo.toml` (`[dependencies]` vs `[dev-dependencies]`), `pom.xml` (scope test → dev), `build.gradle.kts` (`implementation` vs `testImplementation`), `Gemfile` (top-level vs `group :test`); base `undefined` (new manifest) → every name added; invalid JSON / unclosed TOML table / malformed XML → `{ error }` (Review Focus 5).
  - `contracts.test.ts` with a temp repo from `tests/helpers/repo.ts`: runtime dep added → strong fact with `package.json` and the line of the new key; deleted `export function parseToken` in a file with a dependent → strong `contract.api` naming the line and "imported by 1 file"; added export only → info; changed `db/migrations/001.sql` → strong `contract.schema`; four schema files → three facts plus a note "1 more schema file"; extra glob from `captain.contracts.paths` matches; `process.env.NEW_VAR` added when absent at base → strong `contract.env`; `process.env.PATH_X` already present at base → no fact; ignored path → nothing; invalid manifest → note, no throw.
- [ ] **Step 2:** `npx vitest run tests/architecture/contracts.test.ts tests/architecture/manifests.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Parse TOML/XML with small line-oriented scanners (no new dependencies); JSON with `JSON.parse`. Line numbers: the head line where the new name appears. Env patterns exactly as listed in §6.3. Each `git grep -F -q <name> <base> --` is one spawn; cap at 10 names per PR, note the rest.
- [ ] **Step 4:** `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat(captain): detect new dependencies and contract changes`.

### Task 3: Layers detector (`layers.edge`, `layers.cycle`, spec §6.2)

**Files:** Modify `src/architecture/layers.ts`; modify `src/graph/graph.ts` only to expose forward edges: add `importsOf(path: string): string[]` to `RepoGraph` (not to the `DependencyGraph` interface used by signals); test `tests/architecture/layers.test.ts`.

**Interfaces:**
- Consumes: `buildDependencyGraph(repoDir, ref, config)` (cached by tree sha), `moduleOf`, `ctx.config.captain.moduleDepth`, the test-path predicate from `src/signals/tests.ts` (export it if it is not exported; no behaviour change).
- Produces: `export const detectLayers: Detector`; `RepoGraph.importsOf`.

- [ ] **Step 1: Write failing tests** (temp TS repos via `tests/helpers/repo.ts`):
  - head adds `import { q } from "../db/q"` in `src/api/users.ts` where no `src/api`→`src/db` edge existed → one strong `layers.edge`, file `src/api/users.ts`, line of the import, text containing "`src/api` now imports `src/db` for the first time";
  - same edge already present at base via another file → no fact;
  - `src/api/users.test.ts` importing `src/db` → no fact;
  - head makes `src/db` import `src/api` while `src/api`→`src/db` exists → one strong `layers.cycle` naming both modules;
  - only `.c` files changed → note "layers: no changed file is in a supported language", no facts (Review Focus 3);
  - `graph.enabled: false` → note, no facts;
  - `captain.moduleDepth: 1` → `src/api`→`src/db` is intra-module, no fact.
- [ ] **Step 2:** run the test file → FAIL.
- [ ] **Step 3: Implement.** Build module edge sets at base and head restricted to edges whose importer is not a test file; new edges = head − base, M ≠ N; SCCs (Tarjan) on the module graph at both refs; a head SCC with size ≥ 2 whose members were not all in one base SCC → a cycle fact. The line: first line of the importer's head content containing the imported module's relative specifier stem; omit `line` if not found.
- [ ] **Step 4:** `npm run check` → PASS.
- [ ] **Step 5: Commit** `feat(captain): detect new module import edges and cycles`.

### Task 4: Coupling detector and its ApacheJIT experiment (`coupling.missing`, spec §6.1, §10.1)

**Files:** Modify `src/architecture/coupling.ts`; test `tests/architecture/coupling.test.ts`; create `bench/apachejit/coupling-experiment.ts` and `bench/apachejit/coupling-experiment.md`; modify `docs/experiments.md` (pre-register first, then the result).

**Interfaces:**
- Consumes: `ctx.history.commits` (`CommitInfo.files`, `time`), `ctx.asOf`, `ctx.config.history.lookbackDays`, `ctx.config.captain.coupling`, `ctx.config.paths.ignore`, the skim/docs predicate from `src/brief/skim.ts`.
- Produces: `export const detectCoupling: Detector`; `export function couplingPairs(commits: CommitInfo[], changed: string[], opts: { minSupport: number; minConfidence: number; maxFilesPerCommit: number; exclude: (p: string) => boolean }): Array<{ file: string; partner: string; support: number; total: number }>` (pure, used by the bench).

- [ ] **Step 1: Write failing tests** for `couplingPairs` and `detectCoupling`: support 4 vs 5 at confidence 1.0; confidence 0.59 vs 0.6; a 31-file commit ignored, a 30-file commit counted; partner changed in the PR → no fact; partner deleted at head (`ctx.readHead` undefined) → no fact; docs/lockfile partners excluded; two partners → only the highest-confidence one; `coupling.enabled: false` → no facts and no note; text exactly "`b.ts` changed with `a.ts` in 5 of 6 commits (last 365 days); this PR changes only `a.ts`".
- [ ] **Step 2–4:** red, implement, `npm run check` green. **Commit** `feat(captain): detect missing co-changes`.
- [ ] **Step 5: Pre-register** in `docs/experiments.md` (Planned row + section): question, setup and decision rule copied from spec §10.1. Commit `docs(experiments): pre-register the change-coupling experiment`.
- [ ] **Step 6: Run the experiment.** Read `bench/apachejit/README.md` and `fit-experiment.ts` first and reuse their split, row cache and bootstrap. File lists per commit come from blobless clones (`git clone --filter=blob:none`) and one `git log --name-only --format=…` per repository; never one spawn per commit (the endpoint agent makes spawns slow). Grid-search on train only, report test once. Delete the clones afterwards (`~/.cache/opendrs/apachejit/repos`); keep `data/`, `rows/`, `llm/`. No LLM calls.
- [ ] **Step 7: Apply the decision rule.** Write numbers to `coupling-experiment.md` and the `docs/experiments.md` row and section. If lift < 1.2×, set the default `captain.coupling.enabled` to `false` (and update the config test). If the AUC CI excludes 0, add a `coupling.missing` signal with a prior weight and note it in the section; otherwise state "brief-only". Update `minSupport` / `minConfidence` defaults to the tuned values. `npm run check`. Commit `bench: measure change coupling on ApacheJIT`.

### Task 5: Drift detector and the state marker's `first=` (`drift.scope`, spec §6.4, §7.3)

**Files:** Modify `src/architecture/drift.ts`, `src/action/state.ts`, `src/action/run.ts` (read `first`, pass `firstHead`/`firstRun` into scoring, write `first=`); tests `tests/architecture/drift.test.ts`, `tests/action/state.test.ts`, `tests/action/run.test.ts`.

**Interfaces:**
- Consumes: `DetectorOptions.firstHead`, `DetectorOptions.firstRun`, `moduleOf`, `git` from `src/git/exec.ts`.
- Produces: `export const detectDrift: Detector`; `OpendrsState.first?: string`; `stateMarker` always writes `first=`.

- [ ] **Step 1: Write failing tests**
  - `state.test.ts`: marker with `first=` parses; 0.3.x marker without `first=` parses with `first` undefined (Review Focus 4); `first=xyz` → whole marker rejected; `stateMarker` output contains `first=` and round-trips.
  - `drift.test.ts` (temp repo, base → first → head commits): growth inside original modules → no fact; 1 new file in a new module → info; 3 new files outside → strong; churn 40 → 141 lines → strong; 40 → 120 → not strong by churn; a merge of base into the branch adding base-only files → no fact; `firstHead` unknown sha and fetch fails → note "drift: the first scored head is no longer reachable"; no `firstHead` → note "drift: not tracked here"; `firstHead === head` → no fact, no note; text for an old marker (`firstRun` > 1) says "since run 3 at `abc1234`".
  - `run.test.ts`: first run writes `first=<head>`; second run keeps the first run's `first`; a previous 0.3.x marker → `first` = previous head and `firstRun` = previous run.
- [ ] **Step 2–4:** red, implement (three-dot `git diff --name-only --numstat base...first` and `base...head`; one `git fetch --no-tags origin <sha>` retry), `npm run check` green.
- [ ] **Step 5: Commit** `feat(captain): report drift during AI review rounds`.

### Task 6: v0.3.1 threshold display fix (separate, from `main`)

**Files:** Modify `src/policy/gate.ts` (lines ~151–297, every `toFixed(2)` that prints a score against a threshold); test `tests/policy/gate.test.ts`; `CHANGELOG.md` (Unreleased → "### Fixed").

- [ ] **Step 1: Failing test:** score 0.3004 with green threshold 0.30 → the reason must not read "score 0.30 ≥ green threshold 0.30"; expected "score 0.3004 ≥ green threshold 0.30". Same for freeze, source, auto-approve "<" and the deferred band.
- [ ] **Step 2: Implement** a helper `formatScore(score, threshold)`: two decimals unless they render equal to the threshold's two decimals, then up to four (trim trailing zeros). Use it at every comparison site. Do not change the rule.
- [ ] **Step 3:** `npm run check`; `npm run build:action` and commit `action/dist`. Commit `fix(gate): show enough decimals that score comparisons read true`.

### Task 7: Integration, docs, positioning, bundle (wave 2, on `feat/captain-brief`)

**Files:** `docs/captain.md` (new, front matter like other docs; add to `docs/_config.yml` nav and `docs/llms.txt`), `docs/blast-radius.md`, `docs/llm-reviewers.md`, `docs/github-action.md` (labels, `captain` output, `first=`), `docs/configuration.md` (`captain` block), `README.md` (section "Where opendrs sits in your PR flow"), `docs/alternatives.md` (CodeRabbit Merge Risk; DRS-OSS AUC 0.895, other split), `docs/experiments.md` (§10.2: run it only if the orchestrator says the usage budget allows; otherwise add it as a Planned row with the spec's setup and decision rule), `CHANGELOG.md` (Unreleased: one entry per detector and the core), `action/dist` (rebuild).

- [ ] **Step 1:** Merge `feat/captain-contracts`, `feat/captain-layers`, `feat/captain-coupling`, `feat/captain-drift` into `feat/captain-brief` (`--no-ff`, one merge commit each). `npm run check` after each merge.
- [ ] **Step 2:** Dogfood: `node dist/cli/index.js brief` (after `npm run build`) on two local commit ranges of this repository, one touching `src/action/run.ts`, one docs-only. Check the captain section reads right; fix wording bugs found.
- [ ] **Step 3:** Write the docs listed above. `docs/captain.md` covers §1's flow, the §7.1 table, one example per fact id, the config, the labels, and what is and is not measured (§10, including the coupling result and that drift is unmeasured). Docs must not claim layers/contracts facts predict bugs unless §10.2 measured it.
- [ ] **Step 4:** `npm run build:action`; `npm run check`. Commit `docs: document the captain brief` and `build(action): rebuild the bundle for the captain brief`.
