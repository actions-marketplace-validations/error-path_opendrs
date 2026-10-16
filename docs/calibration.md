# Calibration and backtesting

opendrs ships with hand-set prior weights. They rank obvious cases sensibly (a typo fix scores
low, a large untested change to a widely imported file scores high), but they have never seen your
repository. `opendrs backtest` tells you how well a model ranks your past commits, and
`opendrs calibrate` fits the weights to them.

```sh
npx github:error-path/opendrs backtest                      # default priors on your history
npx github:error-path/opendrs calibrate                     # writes .opendrs/model.json
npx github:error-path/opendrs backtest                      # default vs calibrated
npx github:error-path/opendrs calibrate --since 2025-10-01 --max-commits 5000
```

Commit `.opendrs/model.json`. It is used from then on, and the GitHub Action reads it from the PR's
base commit. Because `.opendrs/**` is a blocked path, a PR that updates the model always gets a
human review.

## Labels: which commits count as incident-linked

Calibration needs to know which past commits caused problems. opendrs labels a commit positive
from three sources, from strongest to weakest:

1. **Incidents you record** in `.opendrs/incidents.jsonl` (below).
2. **Reverts.** A commit named in "This reverts commit <sha>" is positive.
3. **SZZ-lite.** For each commit whose subject matches `history.fixPattern` (by default fix, bug,
   hotfix, regression, incident, sev, revert), opendrs blames the lines that commit deleted or
   modified, at its parent. The commits that last touched those lines are positive.

Every other non-merge commit is negative. These labels are noisy. SZZ blames whoever last touched
a line, which is sometimes a reformat or a rename. A fix pattern that matches "fix typo" adds false
positives, and incidents fixed by config or infrastructure changes are invisible. Recorded
incidents are the best way to reduce the noise.

### Label horizon: the newest commits are left out

A commit's bug is usually found and fixed weeks or months after it lands, so most of the newest
commits are labelled negative only because nobody has fixed them yet. In our benchmarks the
newest 20 % of commits ranked near random (AUC 0.45 to 0.50 on tokio, terraform and eslint) while
the same model scored 0.68 to 0.75 over all commits. `calibrate` and `backtest` therefore leave out
every commit newer than the newest replayed commit's time minus `history.labelHorizonDays`
(default 60). Those commits are neither fitted on nor evaluated, but they stay in the history, so
their fixes still label older commits. Both commands report how many were left out, for example
"120 commits newer than 60 days excluded from evaluation (their bugs may not be found yet)". The
80 / 20 time split then applies to the remaining commits.

Override it for one run with `--label-horizon-days <n>`. Set it to `0` to use every commit, as
earlier versions did. Raise it when your bugs typically surface slowly (for example infrequent releases).

## `.opendrs/incidents.jsonl`

One JSON object per line. Each object names the change that caused an incident, the change that
fixed it, or both:

```jsonl
{"inducing": "3f2a9c1e0b7d4a5e8f1c2b3a4d5e6f708192a3b4", "note": "SEV-1423: checkout 500s after cache key change"}
{"fix": "b81d07aa5c3e2f1d0a9b8c7d6e5f4a3b2c1d0e9f", "note": "SEV-1431: inducing commit unknown, found by blame"}
{"inducing": "9c44e2107a6b5c4d3e2f1a0b9c8d7e6f5a4b3c2d", "fix": "1e0f3b5d2c4a6e8f0b1d3c5e7a9b2d4f6a8c0e1b", "paths": ["services/payments/"], "note": "SEV-1450"}
```

| Field | Meaning |
|---|---|
| `inducing` | sha of the commit that caused the incident. Labelled positive directly. |
| `fix` | sha of the commit that fixed it. Its deleted and modified lines are blamed (SZZ), and the blamed commits are labelled positive. |
| `paths` | files or folders involved. Used by the `history.incident` signal for later PRs that touch them. |
| `note` | free text for people; ignored by opendrs. |

Use full 40-character shas of commits reachable from the default branch. A postmortem template that asks
for "the commit that caused this" makes the file cheap to maintain. `calibrate` and `backtest` warn
about an `inducing` sha that is not in the indexed history or a `fix` sha that does not resolve in
the repository, and do not count it. They also report how many commits they skipped because they
could not be read (for example objects missing from a partial clone).

## Reading the metrics

**captured@X%.** Sort the commits by score, gate the riskiest X %, and count what share of
positive commits fall inside that set. `captured@10% = 35 %` means: if a human had looked only at
the riskiest tenth of commits, they would have seen 35 % of the incident-linked ones. A random
ordering captures X % at X %, so compare against that. This is the metric Meta reports for DRS.

**AUC.** The probability that a randomly chosen positive commit scores higher than a randomly
chosen negative one. 0.5 is random. Published just-in-time defect prediction studies commonly
report 0.7 to 0.8.

**Base rate.** The share of commits labelled positive. With a base rate of 3 %, a model can look
accurate while catching nothing, which is why opendrs reports capture rates instead of accuracy.

**Commits and positives.** With fewer than about 50 positives the numbers move a lot between runs
and windows; read them as rough. `backtest` evaluates the calibrated model only on commits newer
than its training window (`trainedOn.to` in the model file), so it never scores a commit it was
trained on. It also reports the default priors on those same held-out commits; compare those two
rows, not the calibrated row with the all-commits default row. When no replayed commit is newer
than the training window (for example on a checkout older than the one the model was fitted on),
the calibrated model has no held-out rows and `backtest` says so.

**Meta's numbers.** `backtest` prints Meta's published LR baseline (18.7 % / 27.9 % / 84.6 % of
SEVs captured at 5 / 10 / 50 % gated) for orientation. Those come from Meta's own code and SEV
data, which differ from yours in size, labels and practice. They are not a target.

## Choosing thresholds

The `green` threshold decides what can be auto-approved, so choose it from the capture curve rather
than from the score itself. For example, if gating the riskiest 50 % of commits captures 85 % of
positives on your history, a green threshold at the 50th percentile means about 15 % of
incident-linked commits would have been eligible for auto-approval, before the AI review, the size
cap, the hard blocks and sampling stop some of them.

Percentile thresholds make this explicit:

```yaml
thresholds:
  mode: percentile      # needs a calibrated model with score percentiles
  green: 50
  yellow: 90
  red: 95
```

Re-run `calibrate` every few months, or after large changes to the codebase or team, and compare
with `backtest` before you commit the new model.
