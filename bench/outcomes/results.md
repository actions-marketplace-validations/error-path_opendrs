# Outcome labels: results

Built 2026-10-23T12:47:12.012Z. 6 repos, 1010 PRs scored, 1304 excluded (reasons in corpus.json).

Spec: `docs/specs/2026-10-23-outcome-labels-design.md`. Lift = observed rate ÷ the same PRs' expected rate (§5.3). Decision rule §7: ≥ 30 fires; keep when E_file or F_file lift ≥ 1.2×; retune when neither but one ≥ 1.0×; demote when both < 1.0×.

## Per fact type (file level, primary)

| Fact | Fires | PRs | Strong | E_file | exp | lift | F_file | exp | lift | R | No outcome | Conclusion |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `change.concurrency` | 72 | 21 | 72 | 4.2 % | 2.6 % | 1.63× | 2.8 % | 1.3 % | 2.08× | 0.0 % | 93.1 % | **keep** |
| `change.safety_removed` | 42 | 42 | 0 | 11.9 % | 7.3 % | 1.62× | 0.0 % | 1.0 % | 0.00× | 0.0 % | 88.1 % | **keep** |
| `contract.api` | 2938 | 114 | 2830 | 1.1 % | 0.9 % | 1.23× | 0.3 % | 0.4 % | 0.63× | 0.0 % | 98.7 % | **keep** |
| `contract.dependency` | 43 | 22 | 20 | 9.3 % | 7.0 % | 1.32× | 23.3 % | 5.0 % | 4.62× | 0.0 % | 67.4 % | **keep** |
| `contract.env` | 26 | 12 | 26 | 3.8 % | 16.5 % | 0.23× | 38.5 % | 26.6 % | 1.44× | 0.0 % | 57.7 % | **insufficient** |
| `contract.instructions` | 10 | 9 | 10 | 60.0 % | 43.4 % | 1.38× | 0.0 % | 2.2 % | 0.00× | 0.0 % | 40.0 % | **insufficient** |
| `contract.schema` | 3 | 1 | 3 | 0.0 % | 0.0 % | — | 0.0 % | 0.1 % | 0.00× | 0.0 % | 100.0 % | **insufficient** |
| `coupling.missing` | 45 | 36 | 25 | 0.0 % | 4.3 % | 0.00× | 4.4 % | 4.8 % | 0.92× | 0.0 % | 95.6 % | **demote** |
| `layers.edge` | 18 | 16 | 18 | 33.3 % | 17.6 % | 1.89× | 0.0 % | 2.1 % | 0.00× | 0.0 % | 66.7 % | **insufficient** |

## Per fact type (line level, ±10 lines, facts with a line only)

| Fact | With line | E_line | exp | lift | F_line | exp | lift | P_partner |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `change.concurrency` | 72 | 1.4 % | 2.1 % | 0.67× | 0.0 % | 0.6 % | 0.00× | — |
| `change.safety_removed` | 42 | 4.8 % | 5.3 % | 0.90× | 0.0 % | 0.0 % | — | — |
| `contract.api` | 2938 | 0.4 % | 0.3 % | 1.31× | 0.1 % | 0.1 % | 0.80× | — |
| `contract.dependency` | 43 | 9.3 % | 6.4 % | 1.45× | 14.0 % | 16.7 % | 0.84× | — |
| `contract.env` | 26 | 0.0 % | 0.0 % | — | 0.0 % | 0.5 % | 0.00× | — |
| `contract.instructions` | 0 | — | — | — | — | — | — | — |
| `contract.schema` | 0 | — | — | — | — | — | — | — |
| `coupling.missing` | 0 | — | — | — | — | — | — | 44.4 % |
| `layers.edge` | 1 | 0.0 % | 0.0 % | — | 0.0 % | 0.0 % | — | — |

## Post-hoc: the five facts the PR comment shows (first five per PR, brief order)

Not part of the pre-registered rule; added after run 2 because one PR carried 2,628 `contract.api` facts and dominated the per-fact numbers above. The conclusion column applies the same §7 rule to this view.

| Fact | Fires | PRs | E_file | exp | lift | F_file | exp | lift | No outcome | Rule on this view |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `change.concurrency` | 22 | 19 | 13.6 % | 8.4 % | 1.63× | 4.5 % | 3.8 % | 1.19× | 81.8 % | insufficient |
| `change.safety_removed` | 34 | 34 | 11.8 % | 7.9 % | 1.49× | 0.0 % | 0.4 % | 0.00× | 88.2 % | keep |
| `contract.api` | 202 | 112 | 15.8 % | 12.2 % | 1.30× | 3.5 % | 3.2 % | 1.08× | 81.7 % | keep |
| `contract.dependency` | 35 | 21 | 11.4 % | 8.6 % | 1.32× | 22.9 % | 6.2 % | 3.70× | 65.7 % | keep |
| `contract.env` | 21 | 12 | 4.8 % | 12.4 % | 0.38× | 23.8 % | 17.1 % | 1.39× | 71.4 % | insufficient |
| `contract.instructions` | 10 | 9 | 60.0 % | 43.4 % | 1.38× | 0.0 % | 2.2 % | 0.00× | 40.0 % | insufficient |
| `coupling.missing` | 43 | 34 | 0.0 % | 4.5 % | 0.00× | 4.7 % | 5.1 % | 0.92× | 95.3 % | demote |
| `layers.edge` | 18 | 16 | 33.3 % | 17.6 % | 1.89× | 0.0 % | 2.1 % | 0.00× | 66.7 % | insufficient |

## Captain priority

Corpus fixed-or-reverted rate: 9.8 %. Recall at careful: 65.7 %. Informative (careful ≥ 1.2× base on ≥ 30 PRs): **yes**.

| Priority | PRs | Fixed or reverted | Rate |
|---|---:|---:|---:|
| careful | 438 | 65 | 14.8 % |
| standard | 278 | 29 | 10.4 % |
| quick | 294 | 5 | 1.7 % |

## Drift vs. baseline.json

No baseline, or nothing moved beyond the tolerance.

## Timings

- build: 7.0 min
- fetch: 0.2 min
- label: 0.3 min
- eval: 0.0 min
