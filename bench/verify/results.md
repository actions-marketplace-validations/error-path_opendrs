# Verifier precision study: results

Run: 2026-10-22T17-30-07-530Z · opendrs 0.4.1 · model claude-sonnet-5
Raw per-PR JSON: /Users/himanshuvachhani/.cache/opendrs/verify-study/2026-10-22T17-30-07-530Z

## Recall (spec §3.7.1)
1 of 14 true+useful facts wrongly dropped (bar: at most 1).

## Precision — coupling.missing (spec §3.7.2, §3.8 amendment)
15 of 18 handled (detector classes A-C: 4; verifier only: 11) — bar: >= 13 of 18 (70%).

## Precision — contract.dependency WRONG fires (spec §3.7.2)
0 of 2 marked drop/downgrade (bar: both).

## Cost
$1.0271 total over 49 scored PRs; $0.0210/PR (bar: <= $0.02/PR). Model claude-sonnet-5.

## Decision (spec §3.7, applied as written)
recall: PASS · precision: FAIL · cost: FAIL · overall: precision-fail

## Skipped / aborted PRs

