# Verifier precision study

Measures `llm.verify` (the Phase 2 verification pass,
[`docs/specs/2026-10-20-verification-pass-design.md`](../../docs/specs/2026-10-20-verification-pass-design.md)
§3) against the real captain-fact judgements of the
[2026-10-19 field test](../../docs/research/2026-10-19-field-test.md): does it recall the
field test's true+useful facts, does it correctly drop or downgrade the noisy `coupling.missing`
fires and the two `contract.dependency` WRONG fires, and at what cost per PR. The pre-registration
is [`docs/experiments.md`](../../docs/experiments.md#verifier-precision-study-on-the-field-test-corpus).

## Prerequisites

- **A `dist/` build that includes the verification-pass core branches** (Tasks 1-4 of
  [`docs/superpowers/plans/2026-10-22-verification-pass.md`](../../docs/superpowers/plans/2026-10-22-verification-pass.md)):
  `config.llm.verify`, `ReviewBrief.verification`, `src/llm/verify.ts`, `src/brief/verify.ts`.
  `run.ts` imports `dist/` the same way `bench/apachejit/run.ts` does, so `npm run build` first —
  and `run.ts` itself checks `"verify" in config.llm` and fails with a clear message if it is
  missing (i.e. the build predates Phase 2), rather than silently scoring with the verifier off.
- **`~/.config/opendrs/bench.env`** holding one line, `ANTHROPIC_API_KEY=sk-ant-...`. `run.ts`
  refuses to run a real (non-`--dry-run`) study without it, reads the key from nowhere else
  (never `process.env`, never a CLI flag), and never prints, logs, writes or commits it — every
  error message is scrubbed of the key's literal value before it is printed or written to
  `results.md`.
- Node ≥ 23.6 (native type stripping, like `bench/apachejit/run.ts`) and git.

## Running

```sh
npm run build
node bench/verify/run.ts --dry-run                 # clones + baseline (verify-off) briefs only, no API calls
node bench/verify/run.ts                            # the real study, --max-usd 5.00 by default
node bench/verify/run.ts --repos black,vite --max-usd 1
```

| Flag | Default | Meaning |
|---|---|---|
| `--model <id>` | `claude-sonnet-5` | Anthropic model id (must be a key in `lib.ts`'s `PRICES`, needed for the spend cap) |
| `--max-usd <n>` | `5.00` | Hard cap on total spend. Before every PR, the prompt cost is estimated from the baseline (verify-off) brief's candidate-pool size (chars ÷ 3.5 × input price, plus a 2,000-token output allowance) and reserved from the budget; if that reservation would exceed what's left, the **whole run aborts** before making that call — never just that one PR skipped and the rest continuing. Actual spend is reconciled from `brief.verification.usage` after every real call, and the running total is printed to stderr. |
| `--repos <a,b,...>` | all six | Restrict to these repo slugs (`black`, `cli-cli`, `actix-web`, `vite`, `fastlane`, `vapor`) |
| `--dry-run` | off | No API calls: clones every repo and scores every labelled PR with `llm: null` (verify off) only, to sanity-check the clones and the label-to-fact id matching before spending anything |
| `--keep-clones` | off | Keep the clones under `~/.cache/opendrs/field-test/repos/<slug>` instead of deleting them at the end (worker rule 7 deletes by default) |
| `--out <file>` | `bench/verify/results.md` | Where the report is written |

## What it writes

- `~/.cache/opendrs/field-test/repos/<slug>`: clones, reused across runs. Deleted at the end
  unless `--keep-clones` is passed (rule 7). fastlane is a **full** (non-shallow, non-blobless)
  clone — `labels.json`'s `meta.setupQuirks.fastlane` explains why (its default-config run crashed
  outright in the field test); the other five repos are blobless (`--filter=blob:none`).
- `~/.cache/opendrs/verify-study/<run-id>/<repo>-<pr>.json`: the raw `ReviewBrief` (verified, or
  `.baseline.json` when only the verify-off baseline was built) for every scored PR — the audit
  trail behind `results.md`'s numbers.
- `bench/verify/results.md`: recall, the `coupling.missing` precision breakdown (detector classes
  A-C vs. the verifier — spec §3.8's amendment, so the two are never conflated), the two
  `contract.dependency` WRONG fires, cost per PR and total, and spec §3.7's decision rule applied
  exactly as written.

## Labels

`bench/verify/labels.json` carries every captain fact the six field-test session notes
(`~/.cache/opendrs/field-test/notes/*.md`) judged, labelled `true-useful | noise | wrong |
unclassified`, with each repo's pinned head and each PR's base/head. Its `meta` block records:

- **`expectedTotals` vs. `tracedTotals` and `discrepancy`**: the totals traced from the six notes
  (14 true-useful, 21 noise, 2 wrong, 1 unclassified) reconcile exactly against the field test's
  own summary table **except** one `contract.env` true-useful fire the summary table counts that
  is not traceable in any note or in fastlane's raw JSON dump. `run.ts`'s recall denominator uses
  the traced total (14); see the pre-registration for why this is reported, not papered over.
- **`setupQuirks`**: fastlane's required config overrides and clone mode; cli/cli's commit-range
  stand-ins.
- **`knownCaveats`**: in particular, `ArchitectureFact` has no partner/index field, so several
  labelled instances that share one `id`+`file`+`line` (e.g. vite 77d837351's 10
  `coupling.missing` fires on the same renovate-bumped manifest) collapse to one real `factId` —
  the same collision the live brief itself produces. `lib.ts`'s `groupByFactId` groups the labels
  file the same way, and `run.ts` scores a collapsed group by its one live verdict, same as the
  real system would; this is flagged as an open product question for the lead, not solved here.

## Testing without API calls

`lib.ts` holds everything unit-testable without `dist/` or a network call: `factId`/label
matching/grouping and the cost-cap arithmetic (`estimateCallCostUsd`, `reserveIfAffordable`,
`reconcileActualSpend`) and the decision-rule evaluator (`evaluateDecisionRule`, spec §3.7). Run
with `npx vitest run tests/bench/verify-lib.test.ts`. `run.ts` itself imports `dist/` and is
excluded from the project-wide `npx tsc --noEmit` by the root `tsconfig.json`'s
`bench/**/run.ts` glob (the same exclusion `bench/apachejit/run.ts` already relies on) — it only
type-checks once a build exists.

## Preflight check (fail fast on account-level errors)

Before cloning anything or building any of the (up to) 48 briefs, a real (non-`--dry-run`) run
makes one cheap `provider.verify()` call to confirm the key actually works. This exists because a
previous run's key returned Anthropic's `HTTP 400: This API key is not scoped to a workspace...`
on every one of 48 PRs: `verifyBrief` (src/brief/verify.ts) correctly fails open on any error per
candidate — nothing is dropped, every candidate renders `[unverified]` — so the run completed,
spent $0, and reported a precision **FAIL** that was actually an outage with no real signal.

The preflight call classifies its own error, if any (`lib.ts`'s `classifyProviderError`): 429/5xx/
timeouts are transient and retried with backoff (up to 3 retries) within the budget; any other 4xx
(400/401/403/404/...) is an account-level problem that will not resolve on retry and aborts the
run immediately (exit code 4), before a single clone or brief is built.

As a second, independent safety net, after the run `lib.ts`'s `checkStudyValidity` checks whether
the verifier's fail-open path (`verification.outcome === "failed"`) triggered for most scored
PRs — e.g. if the key stopped working mid-run. If so, `results.md`'s "Decision" section reports
**INVALID**, not a precision FAIL, and no decision rule is applied (exit code 5).

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every labelled PR was scored (or, in `--dry-run`, baselined); `results.md` was written; the decision rule was applied (or this was a dry run) |
| 1 | At least one PR failed for a reason other than the budget cap (clone failure, a provider error, a `dist/` build that predates `llm.verify`) — see `results.md`'s "Skipped / aborted PRs" |
| 2 | Bad flag, unknown `--model`, or a missing/invalid `~/.config/opendrs/bench.env` |
| 3 | The run aborted partway through because the next PR's estimated cost would have crossed `--max-usd`; `results.md` reports partial numbers only |
| 4 | The preflight check failed with an account-level error (or ran out of retries on a transient one); aborted before cloning anything or building any briefs — nothing was scored, `results.md` was not written |
| 5 | The run completed but the verifier failed open for most scored PRs (an outage, not a measurement); `results.md` reports **INVALID**, no decision rule was applied |
