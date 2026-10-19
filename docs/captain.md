---
title: "The captain brief: what the final human reviewer needs"
description: "How opendrs's captain brief works: the priority line (careful, standard, quick), the one named reviewer, the up-to-five architecture and history facts per fact id, the captain labels and Action output, the captain config block, and what each detector measures."
---

# The captain brief

A pull request now often goes through two AI review rounds before a human ever looks at it. By
then the local defects are gone. The **captain** — whoever does that final review, a role, not a
rank — is judging design and architecture decisions, usually with less context than before. The
captain brief is opendrs's answer to that one reviewer: a priority, one named reviewer, and up to
five deterministic facts the editor and the AI review rounds did not show.

## 1. Where the captain fits in a PR

A typical AI-assisted PR flow:

1. the author pushes AI-written code;
2. a reviewer triggers an AI review (Claude Code `/code-review`, CodeRabbit, Copilot) and it
   posts comments;
3. the author resolves them with AI;
4. steps 2 and 3 repeat once more;
5. one human does the final review.

opendrs's score, policy and AI-facing brief already serve steps 2 and 4. The captain brief serves
step 5: it tells the human who is left what to look at and how much attention the PR needs. It is
advisory. It never approves or blocks anything — the score, the gate and the AI brief stay exactly
as they are.

## 2. Priority: how much attention this PR needs

| Priority | When (first match wins) |
|---|---|
| **Careful review** | tier red; or tier yellow with at least one strong fact; or a hard policy rule fired (`paths.block`, `tests.deleted`, `content.block`); or a changed file matches `paths.critical` |
| **Standard review** | tier yellow; or tier green with at least one strong fact |
| **Quick confirm** | everything else: tier green, no strong fact, none of the rules above fired |

Only the rules in that table raise the priority. Other policy rules that already block
auto-approval — `unread-files`, `size-cap`, `source`, `draft`, `ai-review`, `unknowns` and the rest
— stay in "Needs a human" but do not raise priority on their own. `unread-files` in particular
fires on any PR that touches a built bundle (`action/dist` in this repository is one example), so
without this rule every such PR would read "careful review" for no reason beyond a file the editor
already flags as unread. A PR like that stays quick or standard unless something else about it —
a new import edge, a broken contract, a critical path — says otherwise.

## 3. The reviewer

In the Action, the captain line names the same GitHub login the Action already picked with
`assignReviewer` for the review request, so the line and the request always agree:
`**Captain: careful review** · @alice`. When no login is known, the line has no name. The captain
line never prints a raw email address — only a GitHub login, or nothing. Outside the Action (CLI,
MCP) there is no reviewer to name, so the field is absent.

## 4. The facts

Every fact names a file, and a line where one exists, and is `strong` or `info`. The PR comment
shows up to five, strong first; the AI brief lists every one. Paths, package and variable names are
escaped before rendering, so a file name with `` ` `` or `<` in it cannot break the comment.

### `layers.edge` — a new import between modules

A module (by default the first two path segments of a file's directory) imports another module it
never imported before, as of this PR's head:

> `src/api` now imports `src/db` for the first time (`src/api/users.ts:3`).

### `layers.cycle` — a new import cycle

Two or more modules that were not mutually reachable at the PR's base are, at head:

> New import cycle: `src/api` → `src/db` → `src/api`.

### `contract.dependency` — a new package

A name added to a manifest's runtime dependencies (strong) or development dependencies (info); a
version bump on an existing name is not a fact:

> New runtime dependency `jsonwebtoken` (`package.json:31`).

### `contract.api` — a changed public contract

A deleted line that reads as a public declaration, in a file that other files depend on:

> Removes or changes exported `parseToken` (`src/auth/token.ts:42`), imported by 6 files.

### `contract.schema` — a schema or contract file changed

A changed path matching the schema/contract globs (migrations, `.sql`, `.proto`, `.graphql`,
OpenAPI/Swagger specs, and anything added under `captain.contracts.paths`):

> Changes schema or contract file `db/migrations/0042_add_users_email_index.sql`.

### `contract.env` — a new environment variable

An added line that reads an environment variable whose name does not appear anywhere in the tree
at the PR's base:

> Reads a new environment variable `JWT_SECRET` (`src/auth/token.ts:12`).

### `coupling.missing` — a file that usually changes together, didn't

Two files that changed together often enough in the project's history, where this PR changed only
one of them:

> `session.ts` changed with `auth.ts` in 14 of 17 commits (last 365 days); this PR changes only
> `auth.ts`.

### `drift.scope` — what the PR grew into after opendrs first scored it

Runs in the Action only. Compares the files and churn opendrs saw on its first run against the
current head, and flags growth that landed outside the modules the PR originally touched:

> Since opendrs first scored this PR at `abc1234` (run 1), it grew from 3 to 9 files
> (+40 → +310 lines); 4 new files are outside the original modules: `src/billing/invoice.ts`.

## 5. In the PR comment

```
**Captain: careful review** · @alice · why: new `src/api` → `src/db` import; `session.ts` usually changes with `auth.ts`
**For the captain**
- `src/api` now imports `src/db` for the first time (`src/api/users.ts:3`)
- `session.ts` changed with `auth.ts` in 14 of 17 commits; this PR changes only `auth.ts`
- New runtime dependency `jsonwebtoken` (`package.json:31`)
- Since opendrs first scored this PR at `abc1234` (run 1), 3 → 9 files; 4 outside the original modules
- +1 more in the brief below
```

A quick confirm with no facts is one line and no block: `**Captain: quick confirm** · @bob`. The
"why" after the priority is the first two facts, shortened to their first clause. The full list of
facts (not capped at five) is also in the "For the captain" section of the brief for AI reviewers,
and in the `captain` Action output described below.

## 6. Labels and the Action output

The Action sets one of `captain:careful`, `captain:standard` or `captain:quick` on the PR, the same
way it sets the `risk:*` labels, and removes the stale one on a rerun. A captain can filter the PR
list by that label instead of opening every PR to find the ones that need care. The Action also
sets a `captain` output (`careful`, `standard`, `quick`, or empty when `captain.enabled` is false or
the `brief` input is false), and the job summary carries the same line and block as the comment.

## 7. Configuration

```yaml
captain:
  enabled: true          # false: no captain line, block, labels, output or brief section
  moduleDepth: 2          # path segments that make a module for the layers detector
  coupling:
    enabled: true         # defaults set by the ApacheJIT experiment — see below
    minSupport: 8
    minConfidence: 0.6
  contracts:
    paths: []              # extra schema/contract globs, added to the defaults
```

As with the rest of `.opendrs.yml`, this is read from the base commit, so a PR cannot switch its
own captain brief off. See the [configuration reference](configuration.html) for the full file.

## 8. What is measured, and what is not

- **Coupling** (`coupling.missing`) has a pre-registered experiment on ApacheJIT behind it: whether
  the fact lifts the buggy rate over the base rate, and whether it adds to the calibrated score.
  On the held-out test split (24,686 commits, 2017–2019) the fact fired on 1,800 commits, and
  45.5 % of them were bug-inducing against a 23.6 % base rate: a lift of 1.9×. Adding it to the
  score did not raise AUC (0.823 with and without), so it stays a captain fact and is not a
  score signal. The defaults (`minSupport: 8`, `minConfidence: 0.6`) were tuned on the training
  split only. Details: [Experiments](experiments.html).
- **Layers and contracts** (`layers.edge`, `layers.cycle`, `contract.*`) are decisions a captain
  signs off on, not bug predictors. opendrs does not claim that a new import edge or a new
  dependency makes a PR more likely to cause an incident — only that it is a decision the captain,
  not the editor or the AI review rounds, would otherwise have to notice on their own.
- **Drift** (`drift.scope`) is not measured against ApacheJIT: that benchmark has no PR rounds to
  measure drift across. It is validated by tests and by dogfooding opendrs's own PRs.

## What the captain line never does

- It never approves or blocks a PR. That stays the score and the policy decision.
- It never estimates review time ("~20 min"). There is no data to calibrate minutes against.
- It never prints a raw email address — only a GitHub login, when one is known.
