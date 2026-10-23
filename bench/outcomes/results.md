# Outcome labels: results

Built 2026-10-23T11:38:01.071Z. 6 repos, 327 PRs scored, 740 excluded (reasons in corpus.json).

Spec: `docs/specs/2026-10-23-outcome-labels-design.md`. Lift = observed rate ÷ the same PRs' expected rate (§5.3). Decision rule §7: ≥ 30 fires; keep when E_file or F_file lift ≥ 1.2×; retune when neither but one ≥ 1.0×; demote when both < 1.0×.

## Per fact type (file level, primary)

| Fact | Fires | PRs | Strong | E_file | exp | lift | F_file | exp | lift | R | No outcome | Conclusion |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `change.concurrency` | 7 | 6 | 7 | 0.0 % | 5.9 % | 0.00× | 14.3 % | 3.0 % | 4.72× | 0.0 % | 85.7 % | **insufficient** |
| `change.safety_removed` | 10 | 10 | 0 | 10.0 % | 7.8 % | 1.28× | 0.0 % | 0.7 % | 0.00× | 0.0 % | 90.0 % | **insufficient** |
| `contract.api` | 75 | 34 | 42 | 16.0 % | 12.1 % | 1.32× | 0.0 % | 1.5 % | 0.00× | 0.0 % | 84.0 % | **keep** |
| `contract.dependency` | 5 | 3 | 2 | 0.0 % | 0.0 % | — | 0.0 % | 0.0 % | — | 0.0 % | 100.0 % | **insufficient** |
| `contract.env` | 14 | 5 | 14 | 0.0 % | 24.0 % | 0.00× | 71.4 % | 48.9 % | 1.46× | 0.0 % | 28.6 % | **insufficient** |
| `contract.instructions` | 5 | 5 | 5 | 60.0 % | 20.7 % | 2.90× | 0.0 % | 4.4 % | 0.00× | 0.0 % | 40.0 % | **insufficient** |
| `coupling.missing` | 19 | 16 | 14 | 0.0 % | 2.6 % | 0.00× | 0.0 % | 1.7 % | 0.00× | 0.0 % | 100.0 % | **insufficient** |
| `layers.edge` | 2 | 2 | 2 | 100.0 % | 41.7 % | 2.40× | 0.0 % | 0.0 % | — | 0.0 % | 0.0 % | **insufficient** |

## Per fact type (line level, ±10 lines, facts with a line only)

| Fact | With line | E_line | exp | lift | F_line | exp | lift | P_partner |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `change.concurrency` | 7 | 0.0 % | 0.0 % | — | 0.0 % | 5.8 % | 0.00× | — |
| `change.safety_removed` | 10 | 0.0 % | 1.8 % | 0.00× | 0.0 % | 0.0 % | — | — |
| `contract.api` | 75 | 12.0 % | 5.3 % | 2.28× | 0.0 % | 0.0 % | — | — |
| `contract.dependency` | 5 | 0.0 % | 0.0 % | — | 0.0 % | 0.0 % | — | — |
| `contract.env` | 14 | 0.0 % | 0.0 % | — | 0.0 % | 1.0 % | 0.00× | — |
| `contract.instructions` | 0 | — | — | — | — | — | — | — |
| `coupling.missing` | 0 | — | — | — | — | — | — | 57.9 % |
| `layers.edge` | 0 | — | — | — | — | — | — | — |

## Captain priority

Corpus fixed-or-reverted rate: 5.5 %. Recall at careful: 61.1 %. Informative (careful ≥ 1.2× base on ≥ 30 PRs): **yes**.

| Priority | PRs | Fixed or reverted | Rate |
|---|---:|---:|---:|
| careful | 149 | 11 | 7.4 % |
| standard | 78 | 6 | 7.7 % |
| quick | 100 | 1 | 1.0 % |

## Drift vs. baseline.json

No baseline, or nothing moved beyond the tolerance.

## Timings

- build: 3.3 min
- fetch: 5.5 min
- label: 1.6 min
