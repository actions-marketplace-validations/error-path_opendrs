# Outcome labels: measuring captain facts against what really happened

Status: **decided 2026-10-23** by the initiative lead (brainstormed alone, per the orchestrator's
brief; the decisions and the alternatives they beat are recorded in §9 so they can be re-opened).
Pre-registered the same day in `docs/experiments.md` ("Outcome labels on active public repos").
Research origin: `docs/research/2026-10-20-code-review-at-anthropic.md` §3 O3/O5/O6 and §4
Approach C, which was held back because opendrs's own history has no incident volume — and, as
a single-maintainer repository, never will: its review and outcome data says nothing about the
facts (worker rule 16), so no measurement in this spec touches it.

## 1. Problem

The captain facts' precision has been measured twice, both times on proxies:

- the hand-graded 49-PR field test (`docs/research/2026-10-19-field-test.md`), one grader, one
  pass, six repos — the verifier's whole precision study rests on it;
- ApacheJIT bug lift (`docs/experiments.md`, "Captain-fact lift on ApacheJIT"), Java only,
  commits not PRs, SZZ labels that say "this commit was later fixed", nothing about whether a
  reviewer would have cared.

The article opendrs's direction is built on measures noise by **what people did with each
comment** and keeps a **standing eval** that re-runs on every reviewer change. opendrs has neither:
`opendrs feedback --fact` (O3) exists but nobody outside this repo runs it, and `.opendrs/facts.jsonl`
has a handful of rows.

Active public repositories already hold both outcomes, for free and at volume: review comments
anchored to a file and line, and a commit history in which later fixes can be blamed back to the
PR. This spec builds the harness that computes the captain brief a PR *would* have had, labels
every fact by those outcomes, and keeps the labelled set as a fixed regression eval.

## 2. Goal and non-goals

**Goal.** For N merged PRs in six active public repos, one per supported language, compute per
fact type:

1. **reviewer engagement** — did a human reviewer comment on the file (and, for facts with a
   line, near the line) the fact points at, relative to how often they commented on this PR's
   other changed files;
2. **later fix** — was the file (and line) the fact points at touched by a fix commit within 90
   days that SZZ-blames back to the PR, or was the PR reverted, relative to the PR's other files;
3. a **keep / retune / demote** conclusion per fact type from a decision rule fixed before the
   run (§7);
4. the **captain priority's hit rate**: whether "careful review" PRs were later fixed or reverted
   more often than the corpus average;

and keep the whole thing re-runnable as a standing eval (§8) that reports the same numbers plus
drift against a committed baseline whenever a detector, weight or prompt changes.

**Non-goals.**

- No PR analytics surface (O6's non-goal): the harness is `bench/`-only, report-only, never a CLI
  command, Action output or MCP tool.
- No detector changes in this branch. Each fact type's conclusion lists proposed follow-ups.
- No LLM or paid API call. The deterministic brief is what is measured. §10 designs the
  verifier's outcome measurement and stops at a cost estimate.
- No claim that "engagement" equals "the captain would have acted on the fact". opendrs did not
  run on these PRs, so the label is counterfactual: it says whether the fact points where human
  reviewers independently looked, not what they did with opendrs's sentence. §6 names this.

## 3. Corpus selection rule (mechanical)

**Repositories.** Six, fixed in `bench/outcomes/corpus.json`:

| Slug | Repo | Language | Why this one |
|---|---|---|---|
| `black` | psf/black | Python | field-test repo; known-good clone/config |
| `cli-cli` | cli/cli | Go | field-test repo; the Go resolver bug it exposed is fixed in 0.5.0 |
| `actix-web` | actix/actix-web | Rust | field-test repo |
| `vite` | vitejs/vite | TypeScript | field-test repo; the fact-heaviest one |
| `fastlane` | fastlane/fastlane | Ruby | field-test repo; needs its recorded quirks (full clone, `history.maxCommits: 1500`, `history.lookbackDays: 90`) |
| `mockito` | mockito/mockito | Java | the one supported language the field test lacked; squash-merged, human-reviewed, small enough to clone blobless |

vapor/vapor (Swift) is dropped on purpose: `src/graph/imports.ts` has no Swift extractor and the
field test's nine vapor PRs produced zero facts; a repo that can fire nothing measures nothing.
The six are chosen for language coverage and reuse of known-working setups, not for how the
facts behave on them; what is mechanical is the **PR** selection below. **`error-path/opendrs`
itself is excluded from this corpus and from the standing eval, now and in any extension:** it
has one maintainer, so its review comments and fix history measure nothing (worker rule 16). Any
repo added later must have more than one active reviewer in the lookback window.

**Pinned head.** Each repo's default-branch tip at corpus-build time, recorded in
`corpus.json` with its committer time `T_head`. Everything downstream is relative to it, so the
eval is reproducible from the committed file.

**Follow-up window.** `W = 90 days`. A PR qualifies only if its whole window is observable:
`merged_at ≤ T_head − W`.

**Candidate PRs**, from `GET /repos/{o}/{r}/pulls?state=closed&base=<default>&sort=created&direction=desc`
(pages of 100, cached), stopping when a page's newest `created_at` is older than
`T_head − W − 365 days`:

1. `merged_at` is set and `≤ T_head − W`;
2. `created_at ≥ T_head − W − 365 days` (so the pagination stop is well-defined);
3. `user.type` is not `Bot` (Dependabot/Renovate PRs are merged without review; their
   engagement is structurally zero and would say nothing about a fact);
4. the PR is **reconstructible** from the clone (§4.1); a PR that is not is listed under
   "excluded" with its reason and never silently dropped.

**Take the 60 most recently merged** qualifying PRs per repo (fewer if the repo has fewer).
No other filter. Not by size, not by language of the diff, not by whether facts fire.

> **Amendment 2026-10-23 (after run 1, before run 2; recorded in `docs/experiments.md`).** The
> lookback becomes **1,095 days** and the count **200 per repo**. Run 1's 327 PRs carried 137
> facts, leaving 7 of 8 fact types under the 30-fire bar with no verdict possible; the rule is
> unchanged in every other respect and scales without choosing PRs. Run 1 stays recorded as run.

**Stop rule on reconstruction.** If more than 20 % of a repo's candidates are excluded as
non-reconstructible, the run stops and the cause is investigated before any result is read —
that would be a harness bug, not a corpus property.

## 4. The brief as it would have looked

### 4.1 Base and head from the merge commit

`M = merge_commit_sha` from the PR, which must be on the pinned head's first-parent history
(`git merge-base --is-ancestor` and first-parent membership checked with one
`git rev-list --first-parent <head>` per repo).

| Merge shape | Detect | base | head | PR commits |
|---|---|---|---|---|
| merge commit | `M` has two parents | `M^1` | `M^2` | `git rev-list --no-merges M^1..M^2` |
| squash | one parent and (PR `commits == 1` or `M`'s subject ends with `(#N)`) | `M^1` | `M` | `[M]` |
| rebase | one parent, `commits = k > 1`, subject does not end with `(#N)` | `M~k` | `M` | `git rev-list M~k..M` |

The diff `base...head` is checked against the PR's own `changed_files`; a mismatch excludes the
PR (reason `diff-mismatch`). For a merge commit `loadDiff` already diffs from the merge-base,
which is GitHub's view of the PR.

### 4.2 Scoring

`scoreDiff({repoDir, base, head, config, llm: null, brief: {}, history, baseHistory, asOf})`
from `dist/`, same as `bench/verify/run.ts`:

- **config**: `defaultConfig()` plus the repo's recorded quirks (`corpus.json` `config`, today
  only fastlane's `history.maxCommits`/`lookbackDays`). No `.opendrs.yml` from the repo itself
  is read, so the six repos are scored the way a new adopter would see them.
- **history**: one `buildHistoryIndex(repoDir, pinnedHead, config)` per repo, shared across its
  PRs, with `asOf = committer time of base + 1 s`. Every history-backed signal and detector
  (`history.*`, `expertise.*`, `coupling.missing`, blame) already filters on `asOf`; this is the
  same reuse `calibrate`/`backtest` do. Caveat recorded in §6: a commit whose committer time is
  before `asOf` but which is not an ancestor of `base` (a branch merged later) leaks in.
- **graph**: built per PR at base and head by `scoreDiff` itself (`layers.*`, `contract.api`
  need it). Not reusable across PRs; this is where the time goes.

The stored output per PR is the `ReviewBrief` JSON (`captain.priority`, `captain.facts`,
`captain.notes`), the score/tier, and the changed-file list with each file's added-line ranges
(for the controls in §5.3).

## 5. Outcome labels

All labels are computed from data that does not depend on opendrs, and are stored in
`bench/outcomes/labels.json` (committed) so §8's eval can re-run without GitHub access.

### 5.1 Reviewer engagement

From `GET /repos/{o}/{r}/pulls/{n}/comments` (review comments; file- and line-anchored) and
`GET /repos/{o}/{r}/pulls/{n}/reviews`:

- a comment counts when its author is not a `Bot` and not the PR author (the author replying
  "done" is not reviewer attention);
- its location is `(path, line ?? original_line)`;
- the PR-level flag `changesRequested` is true when any non-bot review has state
  `CHANGES_REQUESTED` (descriptive only; not a fact label).

A fact's engagement labels:

- **`E_file`**: at least one counted comment on `fact.file`.
- **`E_line`** (facts with a line only): at least one counted comment on `fact.file` with
  `|line − fact.line| ≤ 10`.

### 5.2 Later fix and revert

From the clone, with the same `buildHistoryIndex` at the pinned head:

- **fix commits** of a PR: non-merge commits with `isFix` (the default `history.fixPattern`) or
  `isRevert`, committer time in `(merged_at, merged_at + W]`, whose changed files intersect the
  PR's changed files (a necessary condition for blame to reach the PR);
- each such commit is blamed once with `blameFix(repoDir, sha, config.paths.ignore)`
  (`src/model/label.ts`, SZZ-lite: the lines the fix deleted or modified, blamed at `fix^`),
  giving hits `{sha, path, line}` where `line` is the line number in the blamed commit's version
  of the file;
- a hit **lands on the PR** when `hit.sha` is one of the PR's commits (§4.1).

A fact's fix labels:

- **`F_file`**: a hit on the PR with `hit.path === fact.file`.
- **`F_line`** (facts with a line only): such a hit with `|hit.line − fact.line| ≤ 10`. For a
  squash PR the blamed commit is `head`, so both numbers are in head's coordinates; for a
  merge-commit PR the blamed commit may be an intermediate commit and the ±10 window absorbs the
  small offset.
- **`R`** (PR-level): some commit in the history has `revertsSha` naming one of the PR's commits
  (resolved by prefix), or its subject is `Revert "<subject of M>"`. Applies to every fact of the
  PR.

`coupling.missing` gets one extra descriptive label, **`P_partner`**: a fix commit in the window
touches the partner file named in the fact's text (parsed with the detector's own fixed format
`` `<partner>` changed with `<file>` ``). It is reported, not used in the decision rule, because
a fix to the partner may have nothing to do with this PR.

### 5.3 Controls

A raw rate is meaningless — a PR with twenty review comments engages everything — so each fact
is compared with the PR's own other changed files:

- **expected `E_file`** for a fact = share of the PR's changed, non-ignored files with at least
  one counted comment;
- **expected `F_file`** = share of the PR's changed, non-ignored files with at least one hit on
  the PR;
- **expected `E_line` / `F_line`** = share of the fact file's **added lines** that lie within
  ±10 of a counted comment / hit on that file.

The **lift** of a label for a fact type is `mean(label over its facts) / mean(expected over the
same facts)`. A lift of 1.0 means the fact points no better than a random changed file (or
line) of the same PR.

### 5.4 Captain priority

Per PR: `priority ∈ {careful, standard, quick}` and `fixedOrReverted = R ∨ (any hit on the PR)`.
Reported: the share of fixed-or-reverted PRs per priority tier, the corpus base rate, and the
share of all fixed-or-reverted PRs that were "careful" (recall at careful).

## 6. What the labels do and do not mean

- **Counterfactual.** opendrs did not comment on these PRs. `E_*` measures whether a fact points
  where reviewers already looked without it. High `E` means "a reviewer would recognise this as
  worth attention"; low `E` on a fact type means reviewers did not independently look there,
  which is either noise or exactly the blind spot the brief exists to cover. The two are
  separated by `F_*`: a low-`E`, high-`F` fact type is the brief earning its keep; low on both is
  noise.
- **"Dismissed" is not measurable here.** The orchestrator's brief asked for acted-on /
  dismissed / led-to-a-fix; without opendrs in the loop there is no dismissal event. The third
  bucket reported is **no outcome** (neither `E_file` nor `F_file` nor `R`).
- **Final-head brief vs. mid-review comments.** The brief is computed at the merged head;
  comments were made on earlier pushes. Line numbers are matched through GitHub's `line` (the
  position at the final head) when present, `original_line` otherwise.
- **SZZ-lite.** Blame finds the last toucher of lines a fix deleted or modified; a fix that only
  adds lines blames nothing (`F` undercounts). `paths.ignore` files are skipped.
- **History leakage** under one shared index with `asOf` (§4.2).
- **Six repos, ≤ 360 PRs.** Per-fact-type counts will be small for rare facts (`layers.*`,
  `contract.schema`, `contract.env`); the decision rule has an explicit "insufficient data" arm.

## 7. Decision rule (per fact type; fixed before the run)

Primary labels are the file-level lifts (`E_file`, `F_file`), because every fact has a file and
only some have a line. Line-level lifts are reported alongside.

| Fires (facts) | Condition | Conclusion |
|---|---|---|
| < 30 | — | **insufficient data**: no change proposed; listed with its counts |
| ≥ 30 | `E_file` lift ≥ 1.2 **or** `F_file` lift ≥ 1.2 | **keep** |
| ≥ 30 | neither ≥ 1.2, at least one ≥ 1.0 | **retune**: a proposed detector change is listed, not made |
| ≥ 30 | both < 1.0 | **demote**: a `strong` fact type is proposed `info`; an `info` one is proposed for removal or a narrower trigger |

Fire count is facts, not PRs; one PR can carry several facts of a type. The ApacheJIT lift (where
one exists) is printed next to each conclusion for context but does not enter the rule.

> **Forward amendment 2026-10-23 (after run 2; applies to every later run, not to run 2's
> verdicts, which stand as pre-registered).** The **primary** view of the standing eval is the
> first five facts of each PR in brief order — what the PR comment shows — and the §7 rule is
> applied to it; the per-fire view over every fact of every PR is reported second. Reason: one
> PR (cli/cli#12289) fired 2,628 of run 2's 2,938 `contract.api` facts and 48 of its 72
> `change.concurrency` facts, so the per-fire number was that PR's. The report also lists every
> PR carrying more than 20 % of a fact type's per-fire count (types at or above 30 fires).

**Priority.** The captain priority is called **informative** when the "careful" tier's
fixed-or-reverted rate is ≥ 1.2× the corpus rate on ≥ 30 careful PRs; otherwise it is reported
as **not shown** with the numbers.

**Honesty rule.** Every number in `docs/experiments.md` is copied from `bench/outcomes/results.md`,
which the harness writes; a fact type that fails is recorded as failing. A run that stops on the
§3 stop rule or on a harness bug is recorded as such, and any amendment to this spec is dated and
written before the re-run.

## 8. The standing eval

- **Never `error-path/opendrs`.** The eval's corpus is public, multi-reviewer repos only (§3);
  opendrs's own PRs are not a seed, a fixture or a sanity check for it.
- **Committed inputs:** `bench/outcomes/corpus.jsonl` (repos, pinned heads, PR list with
  `base`/`head`/`mergeSha`/`mergedAt`/shape, exclusions with reasons) and
  `bench/outcomes/labels.jsonl` (per PR: counted comment locations, blame hits on the PR, `R`,
  `changesRequested`, the files the window's fix commits touched). Neither contains opendrs
  output, so they stay valid across code changes. One compact record per line, so a re-fetch
  diffs by PR. `results.json` (every per-fact record) is regenerated by `eval` and not committed;
  `results.md` and `baseline.json` are.
- **`node bench/outcomes/run.ts eval`** ensures the clones, rebuilds every brief at the current
  `dist/`, applies §5–§7 and writes `bench/outcomes/results.md` and `results.json`.
- **Drift.** `bench/outcomes/baseline.json` (committed after the first run) holds per-fact-type
  fires, lifts and conclusions on the primary (shown) view and the per-fire view, plus the
  priority table. `eval` compares the primary view and prints a drift section: each
  fact type whose fire count moved by more than 20 % or whose conclusion changed, and the
  priority table side by side. It is report-only; CI does not run it (it needs the clones and
  ~30+ min).
- **Cache and resumability.** Everything fetched or computed lives under
  `~/.cache/opendrs/outcomes/`: `gh/<slug>/…json` (API responses, one file per request),
  `clones/<slug>`, `briefs/<slug>/<pr>.json`, `blame/<slug>/<sha>.json`. Every step checks the
  cache first; an interrupted run resumes. Clones are deleted at the end unless `--keep-clones`.
- **Rate limits.** `gh api` only (read-only); the harness reads `/rate_limit` before fetching,
  sleeps until reset when fewer than 200 core requests remain, and backs off on 403/429. The
  whole corpus is about 1,200 requests (≈ 3 per PR plus list pages), well under 5,000/hour.
- **Timing.** Each repeatable step (`fetch`, `brief`, `label`, `eval`) runs under
  `scripts/record-run.mjs`; durations go in the ledger. `brief` and `label` run repos in
  parallel (`--repo-concurrency`, default 3) and PRs/blames within a repo in a bounded pool
  (`--pr-concurrency`, default 2; blames 4), since the field test measured 2–111 s per brief and
  a serial run over 360 PRs would take hours.

## 9. Decisions and the alternatives they beat

1. **Public repos' own outcomes, not opendrs's incidents** (the research held Approach C back for
   lack of incident volume). Alternative: measure on `error-path/opendrs` itself — rejected
   outright: a single-maintainer repo's review and outcome data says nothing (worker rule 16),
   and this spec never seeds from or measures on it.
2. **Counterfactual labels from review comments + SZZ, not a live deployment** on the six repos.
   Alternative: install the Action on forks or ask maintainers — rejected, slow, consent-bound
   and tiny.
3. **Per-PR paired controls** (the PR's own other files) instead of corpus-wide rates.
   Alternative: compare fact files' rates with the corpus's rate — rejected, confounds PR size
   and reviewer activity.
4. **File-level lift as the primary metric,** line-level as secondary. Alternative: line-only —
   rejected, `coupling.missing`, `contract.schema`, `contract.instructions` have no line.
5. **Fixed window W = 90 days, ±10 lines.** Same window as the backtest label horizon's spirit;
   ±10 absorbs comment drift between pushes and blame offsets on merge-commit PRs. Not tuned on
   the data.
6. **One shared history index per repo with `asOf`** instead of one per PR. Alternative: exact
   per-PR history — rejected on cost (fastlane's `git log` took 7m47s in the field test); the
   leakage is recorded.
7. **Bot-authored PRs excluded; bot and author comments not counted.**
8. **mockito for Java; vapor dropped.** Alternative: apache/kafka — rejected, its graph build per
   PR on a blobless clone would dominate the runtime.
9. **The decision rule's 1.2× bar** mirrors the ApacheJIT captain-fact bar so the two
   measurements read the same way; 30 fires is the smallest count at which a 1.2× lift is
   distinguishable from 1.0× at all (binomial, rough), so below it nothing is concluded.
10. **No new CLI, Action or MCP surface.** Everything is `bench/outcomes/`.

## 10. The verifier's outcome measurement (designed, not run)

The same labels score `llm.verify`: run `eval` with `llm.verify.enabled: true` (as
`bench/verify/run.ts` does) and, per fact type, compare the verified brief's `keep`/`drop`/
`downgrade` verdicts against `E_file`/`F_file`: a drop on a fact with `F_file` is a wrong drop; a
keep on a no-outcome fact is a kept noise. The report would add "wrong drops / total drops" and
"noise kept / total kept" to the same table. Cost: the verifier's measured $0.0192/PR on the
field-test corpus × up to 360 PRs ≈ **$7, cap $10**, from the ~$55 of credit left. Decision
left to the user; nothing in this branch spends.

## 11. Files

- `bench/outcomes/lib.ts` — pure, unit-tested: merge-shape resolution, label computation
  (§5.1–5.3), lifts, decision rule (§7), drift (§8), partner parsing, rate-limit arithmetic.
- `bench/outcomes/run.ts` — `fetch | brief | label | eval | all` subcommands; imports `dist/`;
  excluded from `tsc --noEmit` like `bench/verify/run.ts`.
- `bench/outcomes/corpus.json`, `labels.json`, `baseline.json`, `results.md`, `results.json`.
- `bench/outcomes/README.md` — how to run, flags, exit codes, cache layout.
- `tests/bench/outcomes-lib.test.ts`.
