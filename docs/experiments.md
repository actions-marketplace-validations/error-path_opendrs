---
title: "Experiments: what we tried and what did not work"
description: "The opendrs experiment log: every benchmark and model experiment with its question, setup, real numbers and verdict, including the negative results, so nobody repeats a dead end."
---

# Experiments

This is opendrs's experiment log. It records every experiment, the ones that did not work
included, so that nobody repeats a dead end. Newest first. All numbers are copied from the files
named under **Where**.

Unless stated otherwise, ApacheJIT numbers are on the dataset's official split: train 2003–2016,
test 2017–2019. They are pooled over the held-out test commits, excluding `apache/hadoop`, which
has no positive labels: 24,686 commits, 5,818 positive. "Recall@X %" is the share of buggy
commits in the riskiest X % of commits. How to read the metrics is in
[Calibration and backtesting](calibration.html#reading-the-metrics).

| Date | Question | Result | Verdict | Details |
|---|---|---|---|---|
| Planned (pre-registered 2026-10-20) | Do re-centred default weights reduce out-of-the-box saturation on mature repositories? | — | Planned, not run | [details](#planned-re-centred-default-weights-and-saturation) |
| 2026-10-20 (pre-registered 2026-10-19) | Does excluding Conventional-Commit housekeeping from `history.fixPattern`, and matching `history.incident` at file level instead of folder level, reduce default-prior score saturation on mature repos without hurting calibrated AUC? | On ApacheJIT: red share falls 0.9 % (fixPattern), 7.4 % (incident), 8.3 % (both) — all short of the 25 % bar; calibrated AUC never drops (+0.0002 to +0.0010, every CI non-negative) | Rejected per threshold; file-level incident matching recommended anyway | [details](#score-saturation-fixpattern-and-incident-granularity-on-apachejit) |
| 2026-10-19 | Do `contract.dependency`, `contract.api`, `contract.schema` and `layers.edge` predict ApacheJIT bugs enough to ship as captain facts (spec §10.2)? Do the rejected review signals (`change.concurrency`, `change.safety_removed`, `tests.weakened`) qualify as captain facts on the full test split, even though they did not help the score? | 6 of 7 qualify (lift ≥ 1.2× and ≥ 50 fires): `contract.dependency` 1.467×, `contract.api` 1.718×, `contract.schema` 2.388×, `change.concurrency` 2.036×, `change.safety_removed` 1.788×, `tests.weakened` 1.202×. `layers.edge` does not: 1.117× on 19 fires of a 2,000-commit sample | Merged (facts only; review signals still excluded from the score) | [details](#captain-fact-lift-on-apachejit) |
| 2026-10-19 | Does historical change coupling (`coupling.missing`) predict ApacheJIT bugs enough to ship, and should it also enter the score? | Yes to shipping: test lift 1.931× at the tuned `minSupport: 8`/`minConfidence: 0.6`. No to the score: AUC 0.823 → 0.823, 95 % CI -0.0003 to -0.0001 (significant, but negative) | Merged (brief-only) | [details](#change-coupling-on-apachejit) |
| Planned (pre-registered 2026-10-18, amended 2026-10-18) | Does an LLM reviewer plus opendrs beat the LLM alone, by enough to justify the tokens? | Free simulation on cached judgements: with opendrs as the decision layer, AUC 0.772–0.789 → 0.824 at no extra LLM tokens. At a 10 % review budget, 60 bugs caught against 47–51, false-positive rate 3.4 % against 4.9–5.5 % | Planned, paused (no paid runs yet) | [details](#planned-llm-plus-opendrs-vs-the-llm-alone) |
| 2026-10-18 | Does `calibrate`'s fit, not its features, explain the gap to the Kamei LR? | Yes. The saved weights never saw the newest 20 % of history. Refitting on all of it: AUC 0.819 → 0.823 (Kamei 0.821) | Merged | [details](#fit-experiment-and-the-calibrate-refit) |
| 2026-10-18 | Do reviewer-checklist signals (concurrency, removed safety code, weakened tests) add ranking signal? | No. AUC 0.782 with and without, on 5 projects | Rejected (archived as a patch) | [details](#review-heuristic-signals) |
| 2026-10-18 | Do the missing Kamei features (ent, age, nuc, sexp) close the gap? | No. AUC 0.819 → 0.817 | Rejected (archived as a patch) | [details](#kamei-features) |
| 2026-10-16 | Do structured outputs fix the judge's malformed replies? | Judge failures 36 → 0 of 1,600 | Merged | [details](#structured-outputs-for-the-llm-judge) |
| 2026-10-16 | Does a prompted LLM judge improve ranking, and is its `requireSafe` gate useful? | Ranking +0.015 to +0.022 AUC (within noise). Gate passes 28.5 % of commits at 5.3 % buggy (base rate 25.5 %) | Merged (opt-in) | [details](#structured-llm-judge-on-sampled-apachejit) |
| 2026-10-16 | How do default and calibrated opendrs compare with the classic JIT metrics on a public benchmark? | Calibrated 0.819 vs Kamei 0.821 vs DRS-OSS 0.895 (published, other split) | Merged | [details](#apachejit-benchmark-baseline) |
| 2026-10-15 and 2026-10-16 | Does the score rank later-fixed commits on real open-source repositories, untuned and calibrated? | Better than chance almost everywhere. Calibration helped in 9 of 9, then in 11 of 18 | Kept as evidence | [details](#public-repository-backtests) |

## Score saturation: fixPattern and incident granularity on ApacheJIT

**Status.** Pre-registered 2026-10-19, before any run; run completed 2026-10-20. The question,
setup and decision rule below are unchanged from the pre-registration. Motivated by the field test
on six new
repositories ([research note](research/2026-10-19-field-test.md)): on mature, active repos (black,
vite) most non-trivial PRs scored red (0.80–0.96) regardless of size, and two causes were named
specifically: `history.fixPattern`'s broad regex counts Conventional-Commit housekeeping commits
(`fix(deps): update dependencies`, `chore(deps)`, `fix(ci)`, `fix(docs)`, `fix: typo`) as prior bug
fixes, and `history.incident`'s revert matching fires at the containing-folder level, so one old
revert in a monorepo directory flags hundreds of files it never touched.

**Question.** Do either or both changes reduce default-prior score saturation on ApacheJIT's test
split enough to recommend as new `src/` defaults, without a significant loss of calibrated ranking
quality?

**Variants**, applied to the existing full row cache (build `08355066ee67`, the same 15-project
replay behind the 0.823 pooled calibrated AUC quoted throughout this log), with every signal but
the two below held at its real, shipped value:

- **V0 (current).** Unchanged: `history.fixPattern` is the shipped default
  `\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\d?|revert)\b`; `history.incident` matches a
  changed file against a past revert or incident by exact file path, or by the dirname of any file
  the revert/incident touched (folder level).
- **V1 (fixPattern excludes housekeeping scopes).** `history.fixPattern` becomes:

  ```
  ^(?!(?:deps?|dependencies|ci|docs?|build|chore|style|tests?)(?:\([^)]*\))?:)(?!\w+\((?:deps?|dependencies|ci|docs?|build|chore|style|tests?)\):)(?!fix:\s*typo\b).*\b(fix(es|ed)?|bug|hotfix|regression|incident|sev\d?|revert)\b
  ```

  i.e. the same keyword match, unless the subject opens with a Conventional-Commit header whose
  type or scope is `deps[/dependencies]`, `ci`, `docs`, `build`, `chore`, `style` or `test[s]`, or
  is the literal `fix: typo`. `history.incident` unchanged from V0.
- **V2 (incident at file level).** `history.incident` drops the folder-level branch: a changed file
  only counts as touched by a past revert/incident when the revert/incident's own file list
  contains that exact path (or an `.opendrs/incidents.jsonl` `paths` prefix, unaffected by this
  change). `history.fixPattern` unchanged from V0.
- **V3.** V1 and V2 together.

Implemented bench-only (`bench/apachejit/score-saturation-experiment.ts`): a bench-local
reimplementation of the two signal computations, run over one blobless clone and one `git log
--name-only --no-renames --format=...` spawn per project (sha, time, subject, body, files — same
shape as `src/git/history.ts`'s own log, minus the `-M` rename flag, which is what made earlier
history-replay attempts time out on the larger histories). `src/` is not touched. No LLM calls, no
API spend.

**Metrics**, on the dataset's official split, pooled excluding `apache/hadoop`:

- Calibrated AUC (`fitModel`, as shipped) and recall@10 %/30 % on the test split, with a paired
  bootstrap (2,000 resamples, test commits resampled together, same method as the change-coupling
  experiment) against V0 for each of V1/V2/V3.
- **Saturation**, scored with `DEFAULT_WEIGHTS` (uncalibrated, as a repo sees out of the box before
  running `calibrate`): the share of test commits at or above `thresholds.red` (0.8) and at or above
  `thresholds.green` (0.3, the yellow-or-red boundary — `src/policy/gate.ts`'s three-tier rule), plus
  the score distribution's standard deviation and interquartile range as a spread measure.
- **Field-repo fixPattern counts (secondary, descriptive).** ApacheJIT is Java and mostly pre-dates
  Conventional Commits; V1's effect there may understate its effect on a TypeScript/Python repo that
  uses them. One `git log --format=%s` per repo on fresh blobless clones of vitejs/vite, psf/black
  and cli/cli (the field test's two most-saturated repos and a third for contrast), counting commits
  matched by the V0 and V1 regexes, reported as a count and share, not an AUC.

**Decision rule**, applied the same way for each variant independently:

- **Adopt** a variant as the new `src/` default when its default-prior red-share drops by at least
  **25 % relative** to V0 (e.g. 40 % red → 30 % red or lower) **and** its calibrated-AUC paired
  bootstrap 95 % CI against V0 includes 0 or is entirely positive (no significant loss).
- Otherwise: **reject**, or **ship conditionally** (e.g. only the sub-variant that clears the bar,
  if V1 and V2 disagree) with the reasoning recorded against the specific numbers.

**Result.** 66,653 row-cache commits (train 41,967 of 41,969, test 24,686 of 24,690 — the same
coverage as every other ApacheJIT row in this log); every one also resolved to its own cloned
history, so no row kept a stale value by fallback.

| Variant | Calibrated AUC | AUC gain vs V0 (95 % CI) | Recall@10 % | Recall@30 % | Default-prior red share (≥ 0.8) | Default-prior yellow+red share (≥ 0.3) | Red share, relative change |
|---|---:|---|---:|---:|---:|---:|---:|
| V0 (current) | 0.823 | — | 29.7 % | 66.8 % | 25.6 % | 60.8 % | — |
| V1 (fixPattern) | 0.823 | +0.0002 (0.0001 to 0.0002) | 29.8 % | 66.8 % | 25.3 % | 60.6 % | −0.9 % |
| V2 (incident, file level) | 0.824 | +0.0009 (0.0005 to 0.0014) | 29.8 % | 66.9 % | 23.7 % | 57.9 % | −7.4 % |
| V3 (both) | 0.824 | +0.0010 (0.0006 to 0.0015) | 29.8 % | 67.0 % | 23.5 % | 57.6 % | −8.3 % |

Every variant's AUC-gain 95 % CI is non-negative (no loss), but none reaches the 25 % relative
red-share reduction the decision rule requires: **V1 −0.9 %, V2 −7.4 %, V3 −8.3 %**, all short of
the bar. V2 and V3 move the whole default-prior score distribution down slightly (mean 0.476 →
0.454/0.451), not just the red tier; spread (SD, IQR) is essentially unchanged across all four
variants, so neither change fixes saturation by widening the distribution, only by shifting it.

**Field-repo fixPattern counts** (descriptive; one `git log --format=%s` per repo, fresh blobless
clone, default branch HEAD):

| Repo | Commits | V0 matches (share) | V1 matches (share) | Relative drop |
|---|---:|---:|---:|---:|
| vite | 9,799 | 3,754 (38.3 %) | 2,945 (30.1 %) | 21.6 % |
| black | 2,401 | 472 (19.7 %) | 458 (19.1 %) | 3.0 % |
| cli | 12,367 | 1,588 (12.8 %) | 1,537 (12.4 %) | 3.2 % |

V1's share of matched commits drops by 21.6 % on vite (just under the 25 % bar on its own, and far
more than the 0.9 % seen pooled on ApacheJIT) but only 3 % on black and cli. This explains the
pooled ApacheJIT result: ApacheJIT is 15 mature Java projects that mostly pre-date Conventional
Commits, so V1 has little to exclude there, while vite is a heavy, current adopter of the
convention V1 targets. ApacheJIT alone understates V1's likely effect on a repo like vite.

**Decision (per variant, the pre-registered rule applied exactly).**
- **V1.** Red-share relative reduction 0.9 % < 25 % → **reject** as a global default on this
  evidence. Its much larger effect on vite (21.6 %) suggests it is a real fix for Conventional-
  Commit-heavy repos specifically, not for ApacheJIT's Java corpus — a case for a documented,
  project-specific `history.fixPattern` override rather than a changed global default.
- **V2.** Red-share relative reduction 7.4 % < 25 % → **reject** by the letter of the rule. But its
  AUC-gain CI is strictly positive (0.0005 to 0.0014, the only variant whose CI excludes 0 in the
  positive direction) and it directly fixes a *demonstrated* bug, not just a suspected one: the
  field test confirmed one 8-file revert flagging `history.incident = 1` on hundreds of unrelated
  files under `packages/vite/src/node/` on 5 of 8 sampled PRs. A signal that never costs AUC and
  measurably shrinks saturation, fixing a concretely observed false-positive mechanism, is worth
  shipping even short of the saturation bar.
- **V3.** Red-share relative reduction 8.3 % < 25 % → **reject** by the letter of the rule; carries
  V2's case plus V1's (weaker, Java-corpus-specific) one.

**Recommendation for `src/` defaults (for the orchestrator to implement separately).**
1. **Ship V2: match `history.incident` at file level only** (drop the folder-level branch in
   `src/signals/history.ts`'s `matchEvent`). Non-negative on every metric measured, the only
   variant with a strictly positive AUC-gain CI, and it fixes the one false-positive mechanism this
   experiment and the field test agree on.
2. **Do not change the global `history.fixPattern` default** on this evidence — the ApacheJIT
   saturation effect is too small (0.9 %) to justify a behavior change that also narrows what the
   regex excludes everywhere. Instead, document a `history.fixPattern` override excluding
   Conventional-Commit housekeeping scopes (the V1 regex above, or a simpler equivalent) as a
   suggested project-level config for repos that use the convention heavily — worth a one-line
   mention in the config docs, not a default flip.
3. Neither change alone resolves the field test's saturation finding (theme 1, theme 14): the
   larger share of it is diffusion/history signals being raw, un-normalized counts on an old, busy
   repo, which this experiment did not touch and the field test already flagged as a separate, larger
   fix (rank 14 in its fix list).

**Caveats.**
- **No rename detection.** The per-commit file lists come from `git log --name-only --no-renames`
  (not the shipped detector's `-M`), so a rename shows as a delete and an add rather than one path,
  for both the current commit's own changed files and the historical file-touch index. This
  understates `history.prior_fixes`'s true lookback count and can miss a file-level
  `history.incident` match across a rename, in V0's reproduction and every variant equally — it does
  not favor one variant over another, but it means every number here is a slight underestimate of
  the true signal's reach.
- **The AUC-gain decision rule's CI reading** treats a CI that is non-negative (includes 0, or is
  entirely positive) as "no significant loss," the same reading used in the change-coupling
  experiment; only V2's CI is the stronger "significant, positive" case.
- **ApacheJIT is Java and mostly pre-dates Conventional Commits**, which is exactly why V1 reads as
  a near-no-op pooled here despite the real, larger effect the field-repo count shows on vite.

**Where.** `bench/apachejit/score-saturation-experiment.ts`; results in
[`bench/apachejit/score-saturation-experiment.md`](../bench/apachejit/score-saturation-experiment.md).
No LLM calls, no API spend. The 15 ApacheJIT clones and the 3 field-repo clones were deleted after
the run.

**Outcome.** Rejected as a saturation fix per the pre-registered rule: none of V1/V2/V3 reached the
25 % relative red-share reduction the decision rule required. V2 (`history.incident` at file level)
was adopted separately as a correctness fix, not a saturation fix: folder-level matching flagged
unrelated files (confirmed on vite, where one old revert flagged hundreds of files under
`packages/vite/src/node/`), and the change carries no accuracy cost (AUC +0.0009, CI 0.0005 to
0.0014). V1 (the Conventional-Commits `fixPattern` exclusion) is documented as a per-repo override
in [`docs/configuration.md`](configuration.html#repositories-that-use-conventional-commits) rather
than shipped as a new default.

## Planned: re-centred default weights and saturation

**Status.** Planned, not run. Pre-registered 2026-10-20, before any replay.

**Question.** Do re-centred default weights reduce out-of-the-box saturation on mature
repositories? The [score-saturation experiment](#score-saturation-fixpattern-and-incident-granularity-on-apachejit)
rejected both `history.fixPattern` exclusion and file-level `history.incident` matching as
saturation fixes: neither moved the default-prior score distribution's spread, only its position,
and both fell short of the 25 % red-share-reduction bar. That experiment's own recommendation
(point 3) names the likely larger cause: diffusion and history signals are raw, un-normalized
counts that run high on an old, busy repository regardless of a specific PR's risk, which neither
variant touched. This asks whether changing where the score's default weights are centred, rather
than which signals fire, addresses that directly.

**Setup.**
- **Baseline.** ApacheJIT's default-prior (uncalibrated `DEFAULT_WEIGHTS`) red share (≥
  `thresholds.red`, 0.8) and yellow-or-red share (≥ `thresholds.green`, 0.3), and calibrated AUC,
  pooled on the test split exactly as reported in the score-saturation experiment above (red 25.6 %,
  yellow+red 60.8 %, AUC 0.823) — the same row cache, no new replay needed.
- **Field-test repositories, if feasible.** The six repositories from the [2026-10-19 field
  test](research/2026-10-19-field-test.md) (vite, black and the others), each re-scored with the
  candidate approach on fresh clones, to check whether a change tuned on ApacheJIT's distribution
  also helps the mature, actively-developed repositories the field test flagged as saturated. Not a
  hard requirement if cloning or scoring all six is too slow for the bench budget; ApacheJIT alone
  still answers the question, descriptively weaker.
- **Candidate approach(es).** Not chosen yet; at least one of:
  - Re-centre the model's intercept (or, equivalently, the default priors as a group) so the
    median commit lands mid-yellow instead of near red, without changing any individual signal's
    relative weight.
  - Scale `history.*` and `expertise.*` priors by a repo-age or repo-size factor (for example,
    divide by `log1p(repo age in days)` or `log1p(total commits)`), so an old repository's raw
    counts do not dominate the score the way they do today.
- **Metrics.** Same as the score-saturation experiment: default-prior red share and yellow-or-red
  share, score distribution SD/IQR, and calibrated AUC with a paired bootstrap against the current
  defaults.

**Decision rule.** Adopt a candidate as the new `src/` default when its default-prior red-share
drops by at least 25 % relative to the current defaults **and** its calibrated-AUC paired bootstrap
95 % CI against the current defaults includes 0 or is entirely positive (no significant loss) —
the same bar the score-saturation experiment used, so the two results are comparable. Otherwise:
reject, or ship conditionally with the reasoning recorded against the specific numbers.

**Where.** Not yet run; no bench script exists for this experiment.

## Captain-fact lift on ApacheJIT

**Question.** Pre-registered 2026-10-19, before any run; the question, setup and decision rule
below are unchanged from the pre-registration. No LLM calls; no API spend. Spec §10.2 of
[`docs/specs/2026-10-19-captain-brief-design.md`](https://github.com/error-path/opendrs/blob/main/docs/specs/2026-10-19-captain-brief-design.md)
asks whether the captain brief's architecture facts predict ApacheJIT bugs enough to claim it in the
docs (they ship regardless, as decisions to sign off on, but the docs may only call a fact a bug
predictor if it clears the bar below):

1. On the ApacheJIT test split (2017–2019), what is the bug lift (buggy rate when the fact fires ÷
   base rate) of `contract.dependency` (a new Maven `pom.xml` or Gradle dependency; ApacheJIT is
   Java-only), `contract.api` (a public Java declaration removed or changed in a file with
   dependents), `contract.schema` (the default globs) and `layers.edge` (a new module→module import
   edge, `moduleDepth: 2`)?
2. The three signals [rejected as score features](#review-heuristic-signals) (`change.concurrency`,
   `change.safety_removed`, `tests.weakened`) separated buggy from clean commits on their own, on a
   5-project subset, before the model absorbed it. Do they clear the captain-fact bar on the full
   test split?

**Decision rule**, applied per fact type: a fact qualifies as a captain fact predictive of bugs when
its test-split lift is **≥ 1.2×** and it fires on **≥ 50 test commits**; otherwise it is logged as
such, with its measured lift and fire count. `contract.*` and `layers.edge` ship regardless (spec
§10.2: they are decisions to sign off on, not just bug predictors), but the docs may only claim bug
prediction for a fact that clears the bar. The three review signals are not currently wired as
facts; this result decides whether to add them.

**Setup.**
- Data: the dataset's official test split (2017–2019), pooled excluding `apache/hadoop` (no
  positive labels) — the same 24,686-commit pool as every other ApacheJIT row in this log.
- **`contract.dependency`, `contract.api`, `contract.schema`, `change.concurrency`,
  `change.safety_removed`, `tests.weakened`** are computed on the **full pooled test split**, from
  one `git log --no-walk --stdin -p --no-renames -U0` stream per repository (shas fed over stdin,
  `--ignore-missing` so an absent sha is skipped rather than failing the spawn), restricted to the
  split's own shas: one spawn per repository, never one per commit. `apache/hadoop` is still cloned
  and queried as the fallback repo for `hadoop-hdfs`/`hadoop-mapreduce` commits not found in their
  own (pre-2011) mirror, as the coupling experiment does.
  - `contract.api` and `change.*` reuse the shipped parser (`parseUnifiedDiff`,
    `changedLines`, `isPublicDeclaration`) on each commit's own diff, so the only new code is
    assembling that diff from the stream instead of `git diff`.
  - `contract.api`'s dependents (spec §6.3: a removed/changed declaration only counts with a
    dependent) are **approximated**, not read from the real import graph: one `git grep` pass per
    repository, at the project's pinned 2019 head, collects every `import` line once; a changed
    file's dependents are the distinct importers of its derived fully-qualified name (Maven/Gradle
    layout: `src/(main|test)/(java|kotlin)/...` with slashes turned to dots), or, when that layout
    is not matched, of its bare class name (a cruder fallback, flagged separately if it changes the
    result materially). This is a single-snapshot approximation (2019 imports for a 2003 commit),
    the same kind the benchmark's own caveats already use for the real import graph.
  - `contract.schema` and `contract.dependency` need no approximation: `contract.schema` is a path
    glob match on the diff's changed files (`src/architecture/contracts.ts`'s `DEFAULT_SCHEMA_GLOBS`
    plus the default empty `captain.contracts.paths`); `contract.dependency` reuses
    `addedPackages` (`src/architecture/manifests.ts`) exactly, reading the full before/after text of
    only the manifest files the diff stream shows changed (`git show <sha>^:path` /
    `git show <sha>:path`, a handful of spawns rather than one per commit, since most commits never
    touch a manifest).
  - `change.concurrency`, `change.safety_removed`, `tests.weakened` use the exact regexes archived in
    [`bench/apachejit/archive/2026-10-18-review-signals.patch`](https://github.com/error-path/opendrs/blob/main/bench/apachejit/archive/2026-10-18-review-signals.patch),
    copied into the bench script since that code is not on `main`.
- **`layers.edge`** needs a real dependency graph at base and head, which is too slow to build for
  every test commit (spec §10.2 allows this): a **fixed random sample of 2,000 test commits**,
  drawn with `mulberry32`, seed recorded in the script and the result. `buildDependencyGraph`
  (`src/graph/graph.ts`) runs unmodified, at `captain.moduleDepth: 2`, on the commit's own repo
  clone (same fallback rule as above).
- No tuning: unlike the coupling experiment, none of these facts has a free parameter to choose on
  train, so only the test split is touched.

**Result.**

- Coverage: all 24,690 pooled test commits resolved to a diff (every project except
  `apache/hadoop`; 4 more than the 24,686 this log's other ApacheJIT rows quote, because the
  coupling experiment's separate history-walk missed those 4 shas in its own clones — this
  experiment's `git log --stdin -p --ignore-missing` stream found them).
- `layers.edge` sample: 2,000 of the 24,690 (seed `20261019`), 0 skipped (every graph pair built).

| Fact | Fires on (test commits) | Buggy when fires | Base rate | Lift | Qualifies (≥ 1.2×, ≥ 50 fires)? |
|---|---:|---:|---:|---:|---|
| `contract.dependency` | 992/24,690 | 34.6 % | 23.6 % | **1.467×** | Yes |
| `contract.api` (approximate dependents) | 8,595/24,690 | 40.5 % | 23.6 % | **1.718×** | Yes |
| `contract.schema` | 279/24,690 | 56.3 % | 23.6 % | **2.388×** | Yes |
| `layers.edge` (2,000-commit sample) | 19/2,000 | 26.3 % | 23.5 % | 1.117× | No |
| `change.concurrency` | 3,196/24,690 | 48.0 % | 23.6 % | **2.036×** | Yes |
| `change.safety_removed` | 5,127/24,690 | 42.1 % | 23.6 % | **1.788×** | Yes |
| `tests.weakened` | 1,508/24,690 | 28.3 % | 23.6 % | **1.202×** | Yes |

**Decision (spec §10.2's bar, applied exactly).**

- **6 of 7 qualify** as bug-predicting captain facts: `contract.dependency`, `contract.api`,
  `contract.schema`, `change.concurrency`, `change.safety_removed` and `tests.weakened` all clear
  1.2× lift on at least 50 firing test commits. `tests.weakened` clears it narrowly (1.202×).
- **`layers.edge` does not**: 1.117× lift on only 19 fires in the 2,000-commit sample, below both
  bars. It still ships (spec §10.2: a layering decision to sign off on, not just a bug predictor),
  but the docs may not claim it predicts bugs.
- The three review signals clearing the captain-fact bar does **not** reopen their
  [rejection as score features](#review-heuristic-signals): that was about whether they add ranking
  signal once size, history and the rest of the model already see the commit, a different and
  harder bar than "this subset of commits is buggier than average." They are not wired as captain
  facts yet; this result is the basis for doing so.

**Caveats.** `contract.api`'s dependents are a single-snapshot `git grep` approximation (2019
imports standing in for a point-in-time import graph), not the real per-commit graph; no rename
detection (`--no-renames`); merge commits show no diff under `git log -p`'s default, so they count
as resolved-but-non-firing rather than skipped. Full detail, including the bare-class-name fallback
for non-Maven/Gradle layouts, is in `bench/apachejit/captain-lift-experiment.md`.

**Verdict.** `contract.dependency`, `contract.api`, `contract.schema`, `change.concurrency`,
`change.safety_removed` and `tests.weakened` qualify as bug-predicting captain facts and the docs
may say so; `layers.edge` ships as a layering decision only, with no bug-prediction claim. The three
review signals remain out of the calibrated score (unchanged from their 2026-10-18 rejection) but
are now a candidate for the captain brief as informational facts — not yet wired into
`src/architecture/`.

**Where.** `bench/apachejit/captain-lift-experiment.ts` and
[`bench/apachejit/captain-lift-experiment.md`](../bench/apachejit/captain-lift-experiment.md). No
LLM calls; no API spend. The 15 full clones were deleted after the run.

## Change coupling on ApacheJIT

**Question.** Does `coupling.missing` (spec §6.1 of
[`docs/specs/2026-10-19-captain-brief-design.md`](https://github.com/error-path/opendrs/blob/main/docs/specs/2026-10-19-captain-brief-design.md):
files that historically change together, where a PR changed only one of them) predict ApacheJIT
bugs enough to ship as a captain-brief fact with specific thresholds, and does it also add ranking
signal to the calibrated score? Pre-registered 2026-10-19, before any run; the question, setup and
decision rule below are unchanged from the pre-registration.

**Setup.**
- Data: the dataset's official split (train 2003–2016, test 2017–2019), pooled excluding
  `apache/hadoop` (no positive labels) — the same commits as every other ApacheJIT row in this
  log: 41,969 train, 24,686 of 24,690 test (4 commits' shas were not found in any of the 15
  cloned histories).
- Compute `coupling.missing` per commit from the history strictly before it (the commit's own
  parent stands in for "the PR's base"), with `couplingPairs` (`src/architecture/coupling.ts`):
  the exact pure function the detector calls, so the experiment measures the shipped code, not a
  re-implementation of it. Per-commit file lists come from one blobless clone
  (`git clone --filter=blob:none --no-checkout`) and one `git log --name-only --no-renames` spawn
  per project (15 clones total, apache/hadoop included for the hadoop-hdfs/hadoop-mapreduce
  fallback); never one spawn per commit.
- Tuned `minSupport` ∈ {3, 5, 8} × `minConfidence` ∈ {0.5, 0.6, 0.75} (9 combinations) on the train
  split only (by train lift), then reported the test split once, at the combination chosen on
  train.
- **Lift:** the buggy rate of test commits where the fact fires, against the test split's base
  rate.
- **Score:** the calibrated model (the existing row cache's signals, no re-replay needed) with and
  without a `coupling.missing` signal (count of firing files, log1p), compared on test AUC with a
  paired bootstrap (2,000 resamples, test commits resampled together).

**Result.**

| minSupport | minConfidence | Fires (train) | Train lift |
|---:|---:|---:|---:|
| 3 | 0.5 | 16,051/41,969 | 1.144 |
| 3 | 0.6 | 12,651/41,969 | 1.170 |
| 3 | 0.75 | 8,715/41,969 | 1.188 |
| 5 | 0.5 | 9,531/41,969 | 1.189 |
| 5 | 0.6 | 6,850/41,969 | 1.203 |
| 5 | 0.75 | 3,647/41,969 | 1.195 |
| 8 | 0.5 | 5,156/41,969 | 1.219 |
| **8** | **0.6** | **3,415/41,969** | **1.221 (chosen)** |
| 8 | 0.75 | 1,546/41,969 | 1.196 |

At `minSupport: 8`, `minConfidence: 0.6` on the test split: fires on 1,800 of 24,686 commits
(7.3 %), 819 of them buggy (45.5 %), against a 23.6 % base rate — **lift 1.931×**. Calibrated test
AUC: 0.823 without `coupling.missing`, 0.823 with it (count of firing files, log1p); paired
bootstrap mean -0.0002, 95 % CI -0.0003 to -0.0001 — significant, but negative.

**Decision rule (spec §10.1), applied exactly.**
- Lift 1.931× ≥ 1.2× → **the fact ships**, with `minSupport: 8`, `minConfidence: 0.6` as the new
  defaults (`src/domain/config.ts`; `captain.coupling.enabled` stays `true`).
- AUC-gain 95 % CI -0.0003 to -0.0001 excludes 0, but in the negative direction: the rule asks for
  a significant *positive* gain, and this is a significant (if tiny) negative one → **it stays
  brief-only**. No signal or model-weight change.

**Caveats.** The per-commit file lists skip rename detection (`--no-renames`, for speed on the
larger histories; the shipped detector itself still uses `-M`), and the backtest never checks
whether a partner file still exists afterward (the shipped detector drops a fact when it does
not) — both make this backtest's firing count a slight overcount of what the real detector would
show on the same history. Full detail, including the "stays brief-only" wording's reasoning, is in
`bench/apachejit/coupling-experiment.md`.

**Verdict.** Merged, brief-only. `coupling.missing` ships as a captain-brief fact at its tuned
thresholds; it does not enter the calibrated score.

**Where.** `bench/apachejit/coupling-experiment.ts` and
[`bench/apachejit/coupling-experiment.md`](../bench/apachejit/coupling-experiment.md). No LLM
calls; no API spend. The 15 blobless clones were deleted after the run.

## Planned: LLM plus opendrs vs the LLM alone

**Status.** Pre-registered on 2026-10-18, revised the same day, then amended the same day again
before any spend (see Amendments, below). No API spend yet: paid LLM tests are paused until the
user approves Phase 1. The bench wiring for arm 2 (spec §13 phase 4) is **deferred by decision**:
it is not built until the user approves the paid experiment. The full plan, with the prompt
drafts, the context block, the literature and the power analysis, is in
[the research note, Part 5](research/2026-10-18-review-risk-heuristics.html#part-5-pre-registered-plan-for-the-next-llm-judge-experiment).

**Question.** Does an LLM reviewer plus opendrs beat the same LLM alone, by enough to justify any
extra tokens? It is not opendrs against the LLM. The three headline arms run on the same commits:
1. **The LLM alone:** a `/code-review`-style reviewer reporting findings with a severity.
2. **The LLM given opendrs's context:** the product's review brief, `renderBriefMarkdown(buildBrief(...))`
   (amended 2026-10-18; see Amendments, below) — score, top signals, history, blast radius, prior
   fixes and incidents, and the hunks to focus on.
3. **The LLM with opendrs as the decision layer:** its findings combined with opendrs's signals in
   the calibrated model, plus the `requireSafe` gate.

Routing the LLM to opendrs's riskiest commits is a secondary arm.

**Already measured, for free.** `bench/apachejit/judge-sim.ts` replays the cached Sonnet 5
judgements of the [LLM judge run](#structured-llm-judge-on-sampled-apachejit): 800 test commits,
204 buggy. Each ranking sends its riskiest 10 % of commits to review.

| Ranking | AUC | Bugs caught (of 204) | Precision | False-positive rate | LLM tokens per bug |
|---|---:|---:|---:|---:|---:|
| LLM alone (snippet count, then its risk) | 0.789 | 51 | 63.7 % | 4.9 % | 126 k |
| LLM alone (fitted on its own outputs) | 0.772 | 47 | 58.8 % | 5.5 % | 137 k |
| **LLM + opendrs as the decision layer** | **0.824** | **60** | **75.0 %** | **3.4 %** | **107 k** |
| opendrs alone, for reference | 0.817 | 56 | 70.0 % | 4.0 % | 0 |

- **The decision layer adds +0.035 to +0.052 AUC at no extra LLM tokens.** The paired bootstrap
  95 % CI against the fitted LLM-alone model is +0.026 to +0.077.
- **At a 30 % review budget the gain is small and not significant.** LLM + opendrs catches 131
  bugs against 122–125.
- **The gate.** With opendrs's score added to `requireSafe`, the buggy share of auto-approved
  commits falls from 5.3 % (12 of 228) to 3.5 % (7 of 198).
- **Routing at equal spend** flags 34–43 % more buggy commits than a random subset.
- **Caveat.** These numbers were measured on the same test commits used to look for them, so they
  are exploratory.

**Setup.**
- **Commits.** The same 800 seeded test commits, so every comparison is paired, plus 400 seeded
  training commits judged by arm 1 to fit arm 3.
- **Model.** Sonnet 5 at effort `low`, the same as the cached run.
- **Prompt.** The findings prompt: findings with P0–P3 priority, a trigger and a confidence; no
  findings is a valid answer.
- **Arm 2** adds the product's brief, `renderBriefMarkdown(buildBrief(...))`, at the product
  default `maxTokens: 2,500` (amended 2026-10-18; was a hand-designed block capped at 2,500
  characters). Mean input tokens may grow by at most 30 % (amended 2026-10-18; was 15 %).

**Hypotheses.** H1 and H2 are confirmatory, Holm-corrected; everything else is descriptive.
- **H1.** AUC(arm 3) − AUC(arm 1) has a paired bootstrap 95 % CI above 0, and a point estimate of
  at least +0.02.
- **H2.** AUC(arm 2, the LLM + the brief) − AUC(arm 1) has a CI above 0, and arm 2's LLM tokens
  per bug caught at a 30 % budget — including the brief's own tokens — are no higher than arm
  1's.
- **Descriptive:** recall, precision and false-positive rate at 10 % and 30 % budgets; tokens per
  bug; the gate with Wilson intervals; and whether the context makes the LLM copy opendrs
  (Spearman correlation with opendrs's score).
- **Power.** At n = 800, a +0.02 AUC gain is detectable at 80 % power. A +5-point recall gain at a
  30 % budget is not, so AUC is primary.

**Budget.** The Message Batches API is assumed throughout (half price). Recomputed 2026-10-18 for
arm 2's new +30 % input cap: arm 1 (L) Sonnet 5 findings ≈ $0.035 standard / $0.0175 batched a
commit; arm 2 adds +30 % input on ~6,000 input tokens ≈ +1,800 tokens × $2/M ≈ +$0.0036 standard
→ ≈ $0.0386 standard / $0.0193 batched.

| Item | Arithmetic | Estimate | Cap |
|---|---|---:|---:|
| Pilot (30 commits, L and O, standard API) | 30 × ($0.035 + $0.0386) | $2.2 | $3 |
| Arm 1 | 800 × $0.0175 | $14.0 | $15 |
| Arm 2 | 800 × $0.0193 | $15.4 | $17 |
| Arm 1 on 400 training commits | 400 × $0.0175 | $7.0 | $8 |
| **Total** | | **$38.6** | **$43** |

If the pilot's measured costs push the projected total above $43, drop "Arm 1 on 400 training
commits" first — arm 3 then cannot be fitted on fresh findings, only checked against the stale
cached fit — then shrink arm 2 to 600 test commits.

Out of budget, for later: the verify pass and verified-finding gate (R2, R3), and a cheap Haiku
review of every commit.

**Stop rules.**
- **Pilot first.** Stop if more than 1 of 30 replies fails the schema, if arm 1 costs more than
  $0.045 a commit, if arm 2's input is more than 35 % above arm 1's (amended 2026-10-18; was
  20 %), if more than 85 % of commits get a finding, or if more than 5 % of findings cite a
  missing hunk.
- **Caps.** Each arm has a `--max-usd` cap. A batch whose first 200 results show more than 2 %
  failures is cancelled.
- **No tuning on the test commits.** Any change after test results is a new, logged experiment.

**Amendments.**
- **2026-10-18, before any spend.** Arm 2 becomes "LLM + the opendrs review brief": its context
  block is `renderBriefMarkdown(buildBrief(...))` at the product default `maxTokens: 2,500`,
  replacing the plan's hand-designed block. Arm 2's input cap rises from +15 % to +30 % of arm
  1's mean input tokens, and the pilot stop rule from +20 % to +35 %. The budget is recomputed to
  ≈ $38.6 of ≤ $43. Reason: the product decided its default brief size; the experiment must
  measure the product as shipped. Full detail in
  [the research note, Amendments](research/2026-10-18-review-risk-heuristics.html#amendments).

**Where.** The plan is in [the research note, Part 5](research/2026-10-18-review-risk-heuristics.html#part-5-pre-registered-plan-for-the-next-llm-judge-experiment).
The free simulation is `bench/apachejit/judge-sim.ts`. The cached judgements are those of the
[LLM judge run](#structured-llm-judge-on-sampled-apachejit).

## Fit experiment and the calibrate refit

**Question.** Calibrated opendrs trailed the Kamei logistic regression on ApacheJIT (0.819 vs
0.821), and adding the Kamei features did not help ([Kamei features](#kamei-features)). Is the fit the
problem? The hypothesis was that `calibrate` pulls weights toward the default priors too hard.

**Setup.**
- Data: the cached replay rows of the ApacheJIT run. No new replay or clones were needed.
- Train: 41,967 replayed commits, 22,420 positive. Test: 24,686 commits, 5,818 positive.
- Variants refitted:
  - (a) `calibrate` as it was;
  - (b) no pull toward the priors, at each L2 in 10, 1, 0.1, 0.01;
  - (c) no negative resampling;
  - (d) exactly what `fitModel` did internally.
- Only an inner validation split of the training commits picks a row; test is never used to
  choose. No API cost.

**Result.**

| Variant | Chosen L2 | Test AUC | Recall@10 % | Recall@30 % |
|---|---:|---:|---:|---:|
| (a) `calibrate` as it was | 0.01 | 0.819 | 29.1 % | 66.1 % |
| (b) priors pull off | 0.1 | 0.817 | 29.7 % | 65.7 % |
| (b) priors pull off, at L2 0.01 | — | 0.822 | 29.5 % | 66.6 % |
| (d') same choice as (a), refitted on every training commit | 0.01 | **0.823** | **29.7 %** | **66.8 %** |
| Kamei LR (dataset metrics) | — | 0.821 | 29.6 % | 66.2 % |

- **The priors pull is not the gap.** At L2 0.01, priors on and off are within 0.001 AUC, and the
  strong penalties are never chosen.
- **Resampling is a no-op here.** ApacheJIT's training split is about half positive, so 5:1
  resampling keeps every negative.
- **The real gap.** `fitModel` held out the newest 20 % of the rows it was given for its reported
  metrics, and saved the fit on the oldest 80 % only. Variant (d) reproduces (a) exactly.

After the fix, the regenerated benchmark:

| Pooled, excluding `apache/hadoop` | AUC | Recall@10 % | Recall@30 % | F1 |
|---|---:|---:|---:|---:|
| opendrs, calibrated, before | 0.819 | 29.1 % | 66.1 % | 0.559 |
| opendrs, calibrated, after the refit | 0.823 | 29.7 % | 66.8 % | 0.568 |
| Kamei LR | 0.821 | 29.6 % | 66.2 % | 0.554 |

Per project, the refit is mixed:
- Most projects rose or held level, for example hadoop-hdfs 0.851 → 0.882 and hadoop-mapreduce
  0.867 → 0.888.
- groovy fell 0.692 → 0.609 and activemq 0.863 → 0.843.
- opendrs still leads the Kamei LR in 4 of 14 projects.

**Verdict.** Merged. `calibrate` now picks its penalty, decides whether to keep the priors, and
measures its held-out metrics on the 80 / 20 split. It then refits the chosen setting on every
labelled commit. `backtest` shows the recorded held-out metrics when there are no newer commits.
Pooled, opendrs now matches the Kamei LR within noise. It does not beat it.

**Where.** Commits `c14da1c` (fit experiment), `ad0d368` (fix), `35862bc` (regenerated benchmark).
- [`bench/apachejit/fit-experiment.md`](../bench/apachejit/fit-experiment.md) and `bench/apachejit/fit-experiment.ts`.
- [`bench/apachejit/results.md`](../bench/apachejit/results.md).
- [Calibration and backtesting](calibration.html#what-calibrate-fits-on).

## Review-heuristic signals

**Question.** AI code reviewers check for concurrency changes, removed error handling or guards,
and weakened tests. Do these, computed deterministically from the diff, add ranking signal? The
background is in the
[research note on how AI code reviewers judge PR risk](research/2026-10-18-review-risk-heuristics.html),
recommendations R4–R6.

**Setup.**
- Three new signals:
  - `change.concurrency`: 1 when a changed non-test code line uses a concurrency primitive;
  - `change.safety_removed`: log1p of deleted error-handling and guard lines, net per hunk;
  - `tests.weakened`: more assertion lines deleted than added, or a skip marker added.
- Replayed on 5 ApacheJIT projects (zookeeper, groovy, kafka, spark, zeppelin): 9,708 labelled
  commits, 44.6 % buggy. Calibrated per project and pooled, with and without the three signals on
  the same rows.

**Result.**

| Signal | Fires on | Buggy when it fires | Buggy otherwise | Fitted weight sign (5 projects) |
|---|---:|---:|---:|---|
| `change.concurrency` | 10.3 % | 68.7 % | 41.8 % | positive in all 5 |
| `change.safety_removed` | 15.4 % | 60.2 % | 41.7 % | near zero or negative in 4 |
| `tests.weakened` | 3.3 % | 48.1 % | 44.4 % | negative in all 5 |

| Calibrated test AUC | With the signals | Without |
|---|---:|---:|
| Pooled, 5 projects | 0.782 | 0.782 |
| zookeeper | 0.645 | 0.637 |
| groovy | 0.690 | 0.692 |
| kafka | 0.820 | 0.822 |
| spark | 0.756 | 0.756 |
| zeppelin | 0.672 | 0.671 |

**Verdict.** Rejected as score signals. They separate buggy from clean commits on their own, but
gave no improvement once size, history and the other signals were in the model: pooled calibrated
AUC was 0.782 with and without them, and per project the change ranged from −0.002 to +0.008.
`tests.weakened` was fitted a negative weight in all five projects. Whether they work as hard gate
rules or as review hints was not tested.

**Configuration.** So the experiment can be repeated exactly or deliberately varied:

- **Code.** opendrs 0.2.0 at commit `36a36c7` (bench build `d6ef98ecfa7a`), on top of `main` at
  `0699a9c`. The implementation is archived as
  [`bench/apachejit/archive/2026-10-18-review-signals.patch`](https://github.com/error-path/opendrs/blob/main/bench/apachejit/archive/2026-10-18-review-signals.patch)
  (`src/` and `tests/` only), and the full benchmark report as
  [`2026-10-18-review-signals-results.md`](https://github.com/error-path/opendrs/blob/main/bench/apachejit/archive/2026-10-18-review-signals-results.md).
  On `main` as of 2026-10-19, `git apply -3` applies it with one conflict in
  `src/signals/tests.ts`, which has since gained the exported `isTestPath`.
- **Signals.** Each reads only the diff's changed, non-comment lines in code files, outside test
  files unless stated:

  | Signal | Value | Default weight | Range |
  |---|---|---:|---|
  | `change.concurrency` | 1 when a changed line uses a concurrency primitive: Java's `synchronized`, `volatile`, locks, executors, atomics and concurrent collections, `wait`/`notify`/`lock`/`unlock` calls, `new Thread`, Go's `go func`, `Mutex`/`RwLock`/`WaitGroup`, Python's `threading`/`multiprocessing` | 0.2 | 0 or 1 |
  | `change.safety_removed` | `log1p` of deleted error-handling and guard lines, net of added ones per hunk: `catch`/`except`/`rescue`/`finally`, `throw`/`raise`, `assert`, null and `None` comparisons, Guava `check*` and `requireNonNull`, `Validate.*` | 0.2 | 0 to `log1p(10)` |
  | `tests.weakened` | 1 when test files lose more assertion lines than they gain (`assert*`, `expect(`, `verify(`, `.should`), or a skip marker is added (`@Ignore`, `@Disabled`, `pytest.mark.skip`, `xit`, `it.skip`, `t.Skip` and similar) | 0.3 | 0 or 1 |

- **Model.** The 0.2.0 `calibrate`: L2 logistic regression fitted on the oldest 80 % of labelled
  commits, with the newest 20 % held out to choose the penalty and whether to keep the priors.
- **Data.** A 5-project ApacheJIT subset (zookeeper, groovy, kafka, spark, zeppelin) on the
  official split, train 2003–2016 and test 2017–2019, chosen to keep the replay short. 9,708
  labelled commits, 44.6 % buggy; 4,299 test commits. No LLM judge.

**When to revisit.** Re-run with the archived patch if any of these change:

- **As captain facts rather than score signals.** The captain brief ships a fact when commits
  showing it are buggy at ≥ 1.2× the base rate. On this subset `change.concurrency` reached 1.54×
  (68.7 % against 44.6 %) and `change.safety_removed` 1.35×; `tests.weakened` only 1.08×. That rule
  did not exist when this ran, so a lift test on the full test split is the obvious next step.
- **As hard gate rules.** "Never auto-approve a PR that disables a test" is a policy, not a
  ranking question. This benchmark cannot test it.
- **The model.** These signals overlap size and churn. A model that handles correlated or
  non-linear features might use them where an L2 logistic regression could not.
- **The data.** The patterns are mostly Java-centric, and ApacheJIT is Java only. Repositories in
  other languages, or AI-written changes, may behave differently.
- **The baseline.** Compare against the current `calibrate` refit, not the 0.2.0 fit used here.

## Kamei features

**Question.** The Kamei LR uses four features opendrs lacked: entropy of the change across files
(ent), time since the files last changed (age), number of unique prior changes (nuc) and subsystem
experience (sexp). Does adding them close the gap?

**Setup.** The four features were added as opendrs signals, computed from git. All 15 ApacheJIT
projects were replayed and calibrated on the official split.

**Result.**

| Pooled, excluding `apache/hadoop` | AUC | Recall@10 % | Recall@30 % | F1 |
|---|---:|---:|---:|---:|
| opendrs, calibrated, without the four signals | 0.819 | 29.1 % | 66.1 % | 0.559 |
| opendrs, calibrated, with the four signals | 0.817 | 29.4 % | 65.4 % | 0.566 |
| Kamei LR | 0.821 | 29.6 % | 66.2 % | 0.554 |

opendrs led the Kamei LR in the same 4 of 14 projects as before: activemq, hadoop-mapreduce,
kafka and zeppelin.

**Verdict.** Rejected. The four features gave no significant improvement: pooled AUC moved from
0.819 to 0.817, recall@10 % from 29.1 % to 29.4 % and recall@30 % from 66.1 % to 65.4 %, all within
noise, while every replay paid for the extra history queries. The gap to the Kamei LR came from
how `calibrate` fitted its weights, not from missing features, which the
[fit experiment](#fit-experiment-and-the-calibrate-refit) then confirmed.

**Configuration.** So the experiment can be repeated exactly or deliberately varied:

- **Code.** opendrs 0.2.0 at commit `7af1abc` (bench build `5e4218379fda`), on top of `main` at
  `0699a9c`. The implementation is archived as
  [`bench/apachejit/archive/2026-10-18-kamei-features.patch`](https://github.com/error-path/opendrs/blob/main/bench/apachejit/archive/2026-10-18-kamei-features.patch)
  (`src/` and `tests/` only). It still applied cleanly to `main` on 2026-10-19:
  `git apply bench/apachejit/archive/2026-10-18-kamei-features.patch`.
- **Signals**, each point-in-time (only history before the commit), `unknown` with no prior
  history or a shallow clone:

  | Kamei metric | Signal | Value | Default weight | Range |
  |---|---|---|---:|---|
  | ent | `diffusion.entropy` | Shannon entropy of changed lines over the files that have any, divided by `log2(n)`; 0 for one file | 0.2 | 0 to 1 |
  | age | `history.file_age` | `log1p` of the mean days since each pre-existing changed file last changed; 0 when only new files changed | 0 (sign left to calibration) | 0 to `log1p(3650)` |
  | nuc | `history.unique_changes` | `log1p` of distinct prior commits touching any changed file, over all history (no lookback window) | 0.05 | 0 to `log1p(1000)` |
  | sexp | `expertise.subsystem` | `log1p` of the author's prior non-merge commits touching a top-level directory this change touches (root files count as one directory) | −0.1 | 0 to `log1p(1000)` |

- **Model.** The 0.2.0 `calibrate`: L2 logistic regression fitted on the oldest 80 % of labelled
  commits, with the newest 20 % held out to choose the penalty and whether to keep the priors.
  This is the fit that 0.3.0 later replaced.
- **Data.** ApacheJIT, official split: train 2003–2016, test 2017–2019. All 15 projects replayed,
  pooled over 24,686 test commits (5,818 buggy), excluding `apache/hadoop`, which has no positive
  labels. Repository heads as listed in `bench/apachejit/results.md` at that commit; default
  `history` and `graph` settings; no LLM judge.

**When to revisit.** Re-run with the archived patch if any of these change, because each could
let the features add signal they could not add here:

- **The model.** These features overlap `diffusion.files`, `history.churn` and
  `expertise.author_commits`. A model that handles correlated or non-linear features
  (interactions, gradient-boosted trees) might use them where an L2 logistic regression could not.
- **The baseline.** Since 0.3.0, `calibrate` refits on all labelled commits (calibrated AUC 0.823).
  Compare against that refit, not against the 0.819 baseline used here.
- **The data.** ApacheJIT is large, mature Java projects. Smaller repositories, other languages,
  or AI-era histories with different change patterns may behave differently.
- **Per-project calibration.** Pooled numbers hide projects; check the ones where opendrs trails
  the Kamei LR.

## Structured outputs for the LLM judge

**Question.** In the first judged run ([LLM judge](#structured-llm-judge-on-sampled-apachejit)), the
judge's reply was malformed for 36 of 1,600 commits (2.3 %). Does constraining the reply to the
judge's JSON schema fix that?

**Setup.** The Anthropic provider sends the judge's JSON schema as a structured output. The 36
failed commits were judged again with the same model and prompt.

**Result.**

| | Judge failures |
|---|---:|
| Without structured outputs | 36 of 1,600 (2.3 %) |
| With structured outputs | 0 of 36 re-judged; 0 of 1,600 in the final run |

**Verdict.** Merged. The LLM-judge tables use the re-judged replies.

**Where.** Commit `a9f4882` (structured outputs), `59e07e3` (results);
[`bench/apachejit/results-llm.md`](../bench/apachejit/results-llm.md);
[Calibration and backtesting](calibration.html#with-the-structured-llm-judge).

## Structured LLM judge on sampled ApacheJIT

**Question.** Does opendrs's prompted LLM judge improve ranking? Is its `requireSafe` gate,
which auto-approves only when every hunk is classified safe, a useful filter?

**Setup.**
- Data: a seeded sample of 800 training commits (455 positive) and 800 test commits (204
  positive), excluding `apache/hadoop`.
- Judge: Claude Sonnet 5 with opendrs's judge prompt (prompt hash `678a59d397a9`), diffs cut to
  60,000 characters.
- Models compared with and without the `llm.*` signals.
- Cost: about $55 in API calls.

**Result.**

| Model (800 test commits) | AUC | Recall@10 % | Recall@30 % | F1 |
|---|---:|---:|---:|---:|
| opendrs, default priors | 0.776 | 23.5 % | 60.3 % | 0.518 |
| opendrs, default priors + LLM signals | 0.798 | 26.0 % | 63.2 % | 0.545 |
| opendrs, calibrated | 0.790 | 27.5 % | 56.9 % | 0.550 |
| opendrs, calibrated + LLM signals | 0.805 | 28.4 % | 60.8 % | 0.561 |
| Kamei LR (same commits) | 0.814 | 26.0 % | 63.7 % | 0.588 |

| `requireSafe` at `minConfidence` | Commits passing | Buggy among them |
|---:|---:|---:|
| 6 | 31.9 % | 5.9 % |
| 8 (default) | 28.5 % | 5.3 % |
| 9 | 22.4 % | 2.8 % |

The test sample's base rate is 25.5 % buggy.

| Risk category | Test commits flagged | Buggy among them |
|---|---:|---:|
| `logic_bug` | 393 | 38.9 % |
| `security` | 18 | 44.4 % |
| `performance` | 8 | 12.5 % |
| `structural` | 406 | 37.4 % |
| `complex` | 76 | 51.3 % |

**Verdict.** Merged, as an opt-in judge and gate.
- The gate is the win: the commits it passes are buggy at a fifth of the base rate.
- The ranking gain (about +0.02 AUC) is within noise on 800 commits.
- `logic_bug` and `structural` each flag about half the commits, which is why the categories rank
  poorly. The [research note](research/2026-10-18-review-risk-heuristics.html) proposes prompt
  changes to fix that.
- This sample was fitted before the refit in [fit experiment](#fit-experiment-and-the-calibrate-refit) and
  has not been re-run.

**Where.** Commits `2c9e452` and `59e07e3`;
[`bench/apachejit/results-llm.md`](../bench/apachejit/results-llm.md);
[LLM judge](llm-judge.html).

## ApacheJIT benchmark baseline

**Question.** How do default and calibrated opendrs compare with a logistic regression on the
classic Kamei JIT metrics, on a public benchmark with someone else's labels and split?

**Setup.**
- Data: [ApacheJIT](https://zenodo.org/records/5907002) (Keshavarz and Nagappan, MSR 2022),
  106,674 commits from 15 Apache Java projects, SZZ labels.
- Every labelled commit was replayed with opendrs's signals, computed from git alone.
- Models: default priors, `calibrate`'s fit on the training years, and a Kamei LR on the
  dataset's metrics.
- DRS-OSS is quoted from [its paper](https://arxiv.org/abs/2511.21964): a fine-tuned LLM on a
  different split.

**Result.**

| Model | AUC | Recall@5 % | Recall@10 % | Recall@30 % | Recall@50 % | F1 |
|---|---:|---:|---:|---:|---:|---:|
| opendrs, default priors | 0.771 | 13.6 % | 24.9 % | 59.6 % | 80.0 % | 0.473 |
| opendrs, calibrated | 0.819 | 15.5 % | 29.1 % | 66.1 % | 85.3 % | 0.559 |
| Kamei LR (dataset metrics) | 0.821 | 15.8 % | 29.6 % | 66.2 % | 85.4 % | 0.554 |
| DRS-OSS (published, other split) | 0.895 | 31.5 % | 50.3 % | 86.4 % | — | 0.641 |

Calibration raised AUC in 13 of 14 projects; hadoop-hdfs was the exception. opendrs led the
Kamei LR in 4 of 14 projects.

**Verdict.** Merged, as the project's benchmark. The calibrated row was later raised to 0.823 by
the refit ([fit experiment](#fit-experiment-and-the-calibrate-refit)). The gap to DRS-OSS is what LLM signals
would have to close.

**Where.** Commit `50060c5`; `bench/apachejit/run.ts`;
[`bench/apachejit/results.md`](../bench/apachejit/results.md);
[Calibration and backtesting](calibration.html#results-on-apachejit).

## Public-repository backtests

**Question.** Does the score rank later-fixed commits on real open-source repositories, with the
default priors and after `calibrate`, with nothing configured?

**Setup.**
- Runs: `opendrs calibrate`, then `opendrs backtest`, with opendrs 0.1.x, before the label horizon
  existed.
- Labels: reverts and SZZ blame on fix commits.
- Nine repositories (2026-10-15), up to 4,000 commits each.
- 18 more (2026-10-16), the newest 1,200–1,500 commits each.
- Held-out AUC is on commits newer than the calibration window.

**Result.**

| Run | Untuned: better than chance | Untuned AUC, all commits | Calibration vs default priors, held-out |
|---|---|---|---|
| 9 repositories | 9 of 9 | 0.58–0.70 | better in 9 of 9; median gain +0.04 |
| 18 repositories | 17 of 18 (serde 0.51) | median 0.71 | better in 11, flat in 1, worse in 6 |

**Verdict.** Kept as evidence. It led to two changes:
- `calibrate` keeps the default priors when the fit does not beat them on a validation slice.
- The label horizon: the newest commits' held-out AUC was near random (0.45–0.50 on tokio,
  terraform and eslint) because their bugs had not been found yet.

**Where.** Commits `1e557cd` (nine repositories) and `5442193` (18 repositories);
[Benchmark results](results.html).
