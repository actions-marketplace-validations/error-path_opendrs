# Verifier precision study: results

Run: 2026-10-22T19-16-53-589Z · opendrs 0.4.1 · model claude-sonnet-5
Raw per-PR JSON: /Users/himanshuvachhani/.cache/opendrs/verify-study/2026-10-22T19-16-53-589Z

## Recall (spec §3.7.1)
1 of 14 true+useful facts wrongly dropped (bar: at most 1).

## Precision — coupling.missing (spec §3.7.2, §3.8 amendment)
14 of 18 handled (detector classes A-C: 4; verifier only: 10) — bar: >= 13 of 18 (70%).

## Precision — contract.dependency WRONG fires (spec §3.7.2, §3.8-style amendment 2026-10-23)
2 of 2 handled (eliminated at the detector, no longer fires at all: 2; marked drop/downgrade by the verifier: 0) — bar: both.

## Cost
$0.9419 total over 49 scored PRs; $0.0192/PR (bar: <= $0.02/PR). Model claude-sonnet-5.

## Decision (spec §3.7, applied as written)
recall: PASS · precision: PASS · cost: PASS · overall: ship

## Verifier failures
- black/cache-dir: Anthropic API request timed out after 60 s

## Skipped / aborted PRs

