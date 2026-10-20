# Captain brief: what the last human reviewer needs after the AI rounds

Status: draft spec, written 2026-10-19 for the user's review. Nothing is built yet. The direction
(reader D, approach 1, "prioritise only") was approved in conversation on 2026-10-19. This
document needs approval before an implementation plan is written.

## 1. Goal

**The flow opendrs must fit.** In many organisations a PR now goes:

1. the author pushes AI-written code;
2. a reviewer triggers an AI review (Claude Code `/code-review`, Superpowers
   `requesting-code-review`, CodeRabbit, Copilot) and it posts comments;
3. the author resolves them with AI;
4. steps 2 and 3 repeat once more;
5. one human does the final review.

By step 5 the local defects are gone. The final reviewer, called the **captain** here (a role,
not a rank), judges design and architecture decisions.

**The problem.** opendrs's PR comment today mostly serves steps 2 and 4 (the review brief for AI
reviewers). Its human-facing "Review focus" leads with facts like "6 files depend on it", which
any editor shows in one click. A risk label alone is no longer distinctive either: CodeRabbit
prints "Merge Risk: Minimal" and "Estimated code review effort" on every PR (seen on
[error-path/opendrs#25](https://github.com/error-path/opendrs/pull/25)).

**The goal.** Own step 5. For every PR, opendrs tells the captain:

- **(B) how much attention this PR needs and from whom**: careful review, standard, or quick
  confirm, plus the one person with the most relevant history;
- **(A) what to look at**: up to five architecture and history facts that neither the editor nor
  the AI review rounds show.

The score, the gate and the AI brief stay as they are: they are the engine. The captain line is
advisory and never approves or blocks anything.

**Success criterion.** On a PR that needs a careful review, the captain can name at least one
fact from the "For the captain" block that the editor and the AI comments did not give them.

## 2. Evidence for this direction

From web research on 2026-10-19 (sources in the conversation's research report):

- **Senior attention is the bottleneck.** DORA 2025: with AI adoption, PRs per developer +98 %,
  incidents per PR +243 %, median review time +441 %, and 31 % more PRs merged with no review.
- **Rubber-stamping grows with volume.** More than 40 % of agent-written PRs are reviewed only by
  the person who invoked the agent (arXiv 2605.02273); defect detection drops beyond 200–400 lines
  per session.
- **Comprehension debt.** AI-assisted engineers scored 17 % lower on later comprehension of the
  code they shipped (arXiv 2604.13277), so the captain's architecture pass rests on less
  understanding than before.
- **No reviewer does these today.** None of CodeRabbit, Copilot review, Cursor Bugbot, Greptile,
  Graphite or Qodo calibrates against the repository's own past defects, flags change coupling,
  or produces a per-PR architecture diff. Change coupling exists only in CodeScene (paid);
  layering rules exist only as hand-written rule sets (dependency-cruiser, ArchUnit).

**Honest positioning.** DRS-OSS (arXiv 2511.21964), an open-source hosted Llama classifier,
reports AUC 0.895 on ApacheJIT against opendrs's calibrated 0.823 (different split). opendrs does
not compete on raw accuracy. It competes on: no service to host, every output explained with
evidence, and the captain brief.

## 3. Non-goals

- No change to the gate, the decisions (`auto-approve`, `deferred-review`, `waiting-ai-review`,
  `human-review`), auto-approval or the landing delay. Skipping the captain stays the existing
  opt-in auto-approve path.
- No LLM in the captain brief. Every fact is deterministic and reproducible.
- No time estimates ("~20 min"). There is no data to calibrate minutes.
- No removed-edge or file-level cycle reporting in v1.
- No drift detection outside the Action in v1 (CLI and MCP say "drift: not tracked here").
- No separate GitHub Check or file annotations in v1.

## 4. Data flow

```
scoreDiff(opts) ──► ScoringContext (history index, import graph at base, diff)
                          │
                          ▼
             detectArchitecture(ctx, { firstHead? })     src/architecture/index.ts
               ├─ coupling.ts   → coupling.missing
               ├─ layers.ts     → layers.edge, layers.cycle   (graph at base and head)
               ├─ contracts.ts  → contract.dependency, contract.api, contract.schema, contract.env
               └─ drift.ts      → drift.scope                  (Action only)
                          │  ArchitectureFact[]
                          ▼
             captainPriority(result, facts, policy)          src/architecture/priority.ts
                          │
                          ▼
             ReviewBrief.captain   ──► renderMarkdown (PR comment)
                                   ──► renderBriefMarkdown (CLI brief, MCP review_brief,
                                       /opendrs-review, Action outputs brief / brief-file)
```

Each detector is a pure function of the scoring context (plus `firstHead` for drift). It returns
facts or a note explaining why it could not run. One detector failing never stops the others or
the score.

## 5. Types

Added to `src/domain/types.ts`. All fields are added inside brief version 1, which the review
brief spec allows (new optional fields only).

```ts
export type CaptainPriority = "careful" | "standard" | "quick";

export interface ArchitectureFact {
  id: "coupling.missing" | "layers.edge" | "layers.cycle" | "contract.dependency" | "contract.api"
    | "contract.schema" | "contract.env" | "drift.scope";
  weight: "strong" | "info";
  file: string;
  line?: number;
  /** Rendered sentence; untrusted parts (paths, names) already escaped. */
  text: string;
}

export interface ReviewBrief {
  // ...existing fields...
  /** Absent when captain.enabled is false. */
  captain?: {
    priority: CaptainPriority;
    /** A GitHub login when one is known (see §7.2); absent otherwise. */
    reviewer?: string;
    /** Up to two fact texts, for the one-line "why". */
    why: string[];
    /** Every fact, strong first, in the fixed detector order (§6.5). */
    facts: ArchitectureFact[];
    /** Detectors that could not run, one sentence each. */
    notes: string[];
  };
}
```

## 6. Detectors

All detectors ignore paths in `paths.ignore`. Every fact names a file, and a line where one
exists. Paths and package names go through `untrusted()` before rendering.

### 6.1 Change coupling (`coupling.missing`)

Files that historically change together, where this PR changed only one of them.

- **History:** commits in the history index within `history.lookbackDays` (default 365), as
  seen at the PR's base (`asOf` rules unchanged, so backtests do not leak).
- **Excluded commits:** those touching more than 30 files (mass refactors, reformats).
- **Excluded files:** docs, lockfiles and ignored paths, as both A and B.
- **Fires when**, for a changed file A and a file B that the PR did not change and that exists at
  head:
  - `support(A, B)`, the number of commits touching both, is at least `captain.coupling.minSupport`
    (default 5);
  - `support(A, B) / commits(A)` is at least `captain.coupling.minConfidence` (default 0.6).
- **Weight:** strong.
- **Per file A:** report only the partner with the highest confidence (ties: higher support, then
  path order).
- **Text:** "`session.ts` changed with `auth.ts` in 14 of 17 commits (last 365 days); this PR
  changes only `auth.ts`."
- **Defaults are provisional:** the experiment in §10.1 sets them before release.

### 6.2 Dependency and layer diff (`layers.edge`, `layers.cycle`)

New import edges between modules.

- **Graphs:** `buildDependencyGraph` at base and at head. Both are cached by tree sha, so the
  head graph is cheap on reruns.
- **Module:** the first `captain.moduleDepth` path segments of a file's directory (default 2:
  `src/auth/token.ts` → `src/auth`). A file at the root, or one level deep, uses its directory as
  is.
- **Excluded:** edges whose importing file is a test file (the test-path rules in `src/signals/tests.ts`).
- **New edge** (`layers.edge`, strong): module M has at least one file-level edge to module N at
  head and none at base, and M ≠ N. The fact names the first importing file and line at head.
  Text: "`src/api` now imports `src/db` for the first time (`src/api/users.ts:3`)."
- **New cycle** (`layers.cycle`, strong): a strongly connected component of the module graph at
  head that contains modules not mutually reachable at base. The text names the cycle, for example
  "`src/api` → `src/db` → `src/api`".
- **Not run:** when `graph.enabled` is false, when either graph is over `graph.maxFiles`, or when
  no changed file is in a supported language. A note says which.

### 6.3 Contracts and new dependencies (`contract.*`)

Decisions a captain signs off on.

- **`contract.dependency`**: a package name added to a manifest. Only new names count, not
  version bumps. Strong for runtime dependencies, info for development dependencies.

  | Manifest | Runtime | Development |
  |---|---|---|
  | `package.json` | `dependencies`, `peerDependencies`, `optionalDependencies` | `devDependencies` |
  | `go.mod` | `require` | — |
  | `requirements*.txt` | every line | — |
  | `pyproject.toml` | `[project] dependencies`, `[tool.poetry.dependencies]` | `[project.optional-dependencies]`, poetry groups |
  | `Cargo.toml` | `[dependencies]` | `[dev-dependencies]`, `[build-dependencies]` |
  | `pom.xml` | `<dependency>` without `<scope>test</scope>` | with `<scope>test</scope>` |
  | `build.gradle`, `build.gradle.kts` | `implementation`, `api`, `runtimeOnly` | `test*`, `compileOnly` |
  | `Gemfile` | `gem` outside groups | `gem` in `:development` / `:test` groups |

  Each manifest is parsed at base and at head. A file that does not parse yields a note, never a
  fact. Text: "New runtime dependency `jsonwebtoken` (`package.json:31`)."
- **`contract.api`**: a deleted line that `isPublicDeclaration` accepts, in a file with at least
  one dependent at base. Strong. Here the dependents count is evidence of a broken contract, not
  editor trivia. Text: "Removes or changes exported `parseToken` (`src/auth/token.ts:42`),
  imported by 6 files." An added public declaration with no matching deletion is info.
- **`contract.schema`**: a changed path matching the defaults `**/migrations/**`, `**/*.sql`,
  `**/schema.prisma`, `**/*.proto`, `**/*.graphql`, `**/openapi*.{yaml,yml,json}`,
  `**/swagger*.{yaml,yml,json}`, plus `captain.contracts.paths`. Strong. One fact per file, at most
  three; the rest are counted.
- **`contract.env`**: an added line that reads an environment variable whose name `git grep -F`
  does not find anywhere in the tree at base. Strong. Patterns: `process.env.NAME`,
  `process.env["NAME"]`, `os.getenv("NAME")`, `os.environ["NAME"]`, `os.environ.get("NAME")`,
  `System.getenv("NAME")`, `os.Getenv("NAME")`, `ENV["NAME"]`, `ENV.fetch("NAME")`. Text: "Reads
  a new environment variable `JWT_SECRET` (`src/auth/token.ts:12`)."

### 6.4 Drift during AI rounds (`drift.scope`)

What the PR picked up after opendrs first scored it. This runs in the Action only.

- **State:** the state marker gains `first=<sha>`, the head of opendrs's first run on this PR (§7.3).
- **Comparison:** `F1` = files in `git diff --name-only base...first`, `Fn` = files in
  `base...head`, both three-dot against the current base. Merging the base branch into the PR
  therefore does not count as drift. `M1` = the modules (§6.2) of `F1`.
- **Fires:**
  - info: at least one file in `Fn − F1` whose module is not in `M1`;
  - strong: at least 3 such files, or changed lines (added + deleted, ignored paths excluded)
    at least doubled and grew by more than 100.
- **Text:** "Since opendrs first scored this PR at `abc1234` (run 1), it grew from 3 to 9 files
  (+40 → +310 lines); 4 new files are outside the original modules: `src/billing/…`."
- **First commit missing** (force-push and garbage collection): try
  `git fetch --no-tags origin <first>` once. If it still fails, add the note "drift: the first
  scored head is no longer reachable". There is no fact.
- **Old marker without `first`:** use its `head` and say "since run k at `<sha>`" instead of
  "since opendrs first scored this PR".
- **First run:** `first` = this head, so no drift is possible.

### 6.5 Ordering, cap and "why"

- Facts are sorted strong first. Within a weight the order is: layers, contracts, coupling,
  drift. Within a detector, the order is file path, then line.
- The PR comment shows up to five facts, then "+N more in the brief below". The AI brief lists
  all of them.
- `why` is the first two facts' texts, shortened to their first clause for the one-line summary.

## 7. Priority and reviewer

### 7.1 Priority rules

| Priority | When (first match wins) |
|---|---|
| `careful` | tier red; or tier yellow with at least one strong fact; or the policy rule `paths.block`, `tests.deleted` or `content.block` fired; or a changed file matches `paths.critical` |
| `standard` | tier yellow; or tier green with at least one strong fact |
| `quick` | everything else (tier green, no strong fact, no such rule) |

The other policy rules (`unread-files`, `size-cap`, `source`, `draft`, `ai-review`, `unknowns` and
the rest) do not raise the priority on their own: they already block auto-approval and are listed
under "Needs a human". `unread-files` in particular fires on every PR that touches a built bundle
(`action/dist` in this repository), so it must not make every such PR careful.

### 7.2 Reviewer

The Action already picks one expert with `assignReviewer` over the GitHub logins it can derive
from `suggestReviewers` (noreply emails only). The captain line shows that same login as
`@login`, so the line and the review request always agree. When no login is known, the line has
no name. Raw emails are never printed in the captain line. Outside the Action (CLI, MCP) the
reviewer is absent.

### 7.3 State marker

The strict marker regex gains an optional field:

```
<!-- opendrs-state: v1 head=<40 hex> first=<40 hex> score=… tier=… decision=… run=… -->
```

`first=` is optional when reading, so markers written by 0.3.x parse unchanged. It is always
written from now on. Tests cover both shapes, and a marker with `first=` but a malformed value is
rejected as a whole, as today.

## 8. Output

### 8.1 PR comment

```
### 🟡 Diff risk 0.41 · yellow · human review
<sub>9 files · +310 −22 · base…head</sub>
<sub>Source: agent (Claude Code) · …</sub>

**Captain: careful review** · @alice · why: new `src/api` → `src/db` import; `session.ts` usually changes with `auth.ts`
**For the captain**
- `src/api` now imports `src/db` for the first time (`src/api/users.ts:3`)
- `session.ts` changed with `auth.ts` in 14 of 17 commits; this PR changes only `auth.ts`
- New runtime dependency `jsonwebtoken` (`package.json:31`)
- Since opendrs first scored this PR at `abc1234` (run 1), 3 → 9 files; 4 outside the original modules
- +1 more in the brief below

**Review focus**
- **Review first:** …
- **Needs a human:** …

<details> Review brief for AI reviewers (gains "## For the captain")
<details> Score details (unchanged)
```

- **Quick confirm:** one line, "**Captain: quick confirm** · @bob", and no block.
- **Standard with no facts:** one line, no block.
- **Review focus:** bullets no longer use the `dependents` reason. It stays in the AI brief's
  hunk reasons and in Score details.

### 8.2 AI brief

`renderBriefMarkdown` adds a `## For the captain` section after the verdict line: the priority,
then every fact, then the notes. It is a mandatory section for `fitBudget`. It is never dropped,
and it is bounded by the fact limits in §6.

### 8.3 Labels and outputs

- **Labels:** `captain:careful`, `captain:standard` and `captain:quick`, managed by the existing
  `labels` input, label creation and stale-label removal. A captain filters the PR list by label.
- **Action output:** `captain`, set to `careful`, `standard` or `quick`.
- **Job summary:** the captain line and block, as in the comment.

## 9. Configuration

```yaml
captain:
  enabled: true          # false: no captain line, block, labels, output or brief section
  moduleDepth: 2         # path segments that make a module (§6.2)
  coupling:
    enabled: true        # default set by §10.1's decision rule
    minSupport: 5        # provisional until §10.1
    minConfidence: 0.6
  contracts:
    paths: []            # extra schema/contract globs, added to the defaults
```

The config is read from the base commit, as all config already is, so a PR cannot switch its own
captain brief off.

## 10. Evidence: experiments

Each experiment is pre-registered in `docs/experiments.md` before it runs, with its question,
setup and decision rule, and its result is logged whatever it is. None needs an LLM.

### 10.1 Change coupling on ApacheJIT

- **Setup:** the official split. Compute `coupling.missing` per commit from the history before it.
  Tune `minSupport` ∈ {3, 5, 8} and `minConfidence` ∈ {0.5, 0.6, 0.75} on train (2003–2016) only,
  then report the test split (2017–2019) once.
- **Lift:** the buggy rate of test commits where the fact fires, against the base rate (25.5 %).
- **Score:** the calibrated model with and without a `coupling.missing` signal (count of firing
  files, log1p), compared by AUC with a paired bootstrap.
- **Decision:**
  - lift ≥ 1.2× → the fact ships with the tuned defaults;
  - lift < 1.2× → the detector ships with `captain.coupling.enabled: false` by default, and the
    dead end is logged;
  - AUC gain with a 95 % confidence interval excluding 0 → the signal also enters the score
    (default weights and `calibrate`). Otherwise it stays brief-only.

### 10.2 Layers and contracts on a sample

- **Setup:** a fixed random sample of 2,000 ApacheJIT test commits (seed recorded), because
  building the head graph per commit is slow.
- **Lift:** the buggy rate where `layers.edge`, `layers.cycle` and each `contract.*` fires, against
  the sample's base rate.
- **Decision:** a fact type with lift < 1.0, or that fires on fewer than 20 commits, is logged as
  such. It still ships, because these facts are decisions to sign off rather than bug predictors,
  but the docs must not claim it predicts bugs.

### 10.3 Drift

ApacheJIT has no PR rounds, so drift is not measured. It is validated by tests and by dogfooding
on opendrs's own PRs. The docs say so.

Benchmark clones (`~/.cache/opendrs/apachejit/repos`) are deleted after each run. `data/`,
`rows/` and `llm/` are kept.

## 11. Tests

- **coupling:** a git repo built in the test with known co-change counts. Covers the threshold
  edges (support 4 vs 5, confidence 0.59 vs 0.6), the 30-file commit filter, the partner deleted
  at head, and ignored files.
- **layers:**
  - a new edge;
  - an existing edge (no fact);
  - a test-file import (no fact);
  - a new two-module cycle;
  - an unsupported language (note);
  - the `moduleDepth` setting.
- **contracts:**
  - each manifest: one name added, one version bump (no fact) and a dev dependency (info);
  - a manifest that does not parse (note);
  - removing an exported declaration with dependents;
  - schema globs and the extra `contracts.paths`;
  - a new environment variable against an existing one.
- **drift:**
  - growth inside the original modules (no fact);
  - 1 file outside (info);
  - 3 files outside (strong);
  - doubled churn (strong);
  - a merge from base (no fact);
  - first commit unreachable (note);
  - an old marker without `first`.
- **priority:** every row of §7.1 and each boundary between them.
- **state marker:** markers with and without `first=`, and a malformed `first=` (rejected).
- **rendering:**
  - quick confirm gets one line;
  - careful gets the line and block;
  - five facts plus "+N more";
  - escaped paths;
  - Review focus without `dependents`;
  - the AI brief section under a tight token budget.
- **Action:** captain labels swapped across reruns, the `captain` output set, `captain.enabled:
  false` producing none of it, and the reviewer login matching the review request.

## 12. Rollout

v0.3.1 (the threshold display fix already queued) ships first. Then one worker session per phase,
each on its own `feat/…` branch with its own PR, pushed by the user:

1. **Captain core:** types, priority rules, reviewer, rendering, labels, output, config, the
   contracts detector, and `docs/captain.md`.
2. **Layers detector.**
3. **Coupling detector**, with experiment §10.1 pre-registered and run.
4. **Drift detector** and the state marker's `first=` field.
5. **Lift experiments** §10.2; a README section "Where opendrs sits in your PR flow"; an
   `alternatives.md` update covering CodeRabbit's Merge Risk and DRS-OSS; then release v0.4.0
   per `docs/maintaining.md`.

Workers use Sonnet. Phase 3's experiment design may use Opus. Weekly all-models usage stays at
or below 25 %.

## 13. Documentation

- **`docs/captain.md`** (new): the flow from §1, the priority rules, each fact with an example,
  the configuration, what is measured and what is not (§10), and the labels.
- **`docs/blast-radius.md`:** a paragraph saying that dependents counts drive the score and appear
  to the captain only as evidence for a contract change.
- **`docs/llm-reviewers.md`:** the new brief section.
- **`docs/github-action.md`:** the labels, the `captain` output, and the state marker's `first=`.
- **`docs/configuration.md`:** the `captain` block.
- **README:** "Where opendrs sits in your PR flow" (phase 5).
- **`docs/alternatives.md`:** CodeRabbit's Merge Risk and DRS-OSS at AUC 0.895, stated plainly
  (phase 5).
- **CHANGELOG:** one entry per phase under Unreleased.
