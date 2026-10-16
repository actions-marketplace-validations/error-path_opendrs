# Learnings from Meta's DRS and RADAR papers

Four ideas opendrs did not yet apply: two from the DRS paper (arXiv 2410.06351) and two from RADAR,
Meta's production auto-review funnel (arXiv 2605.30208).

## 1. `size.comment_only`

**Paper:** "a comment only change to a file on a risky path has no risk" (§II-B). The path- and
history-based features cannot see this, so such a diff scores like a code change.

**Signal.** `size.comment_only` is 1 when the diff has at least one counted (not ignored), non-binary
file and every added or deleted line in counted files is blank or a comment. Otherwise it is 0. Status
`observed`, never `unknown`.

- A line counts as a comment only in the file's own syntax: `//` and one-line `/* … */` (and `*`
  continuation lines) in C-like languages, `#` in Python, Ruby, shell and config files, and `--` in
  SQL. Other languages, CSS and docs included, have no trusted comment syntax.
- A lone `/*` or `*/` is code, because adding or deleting one switches a block of code on or off.
  Directive comments are code too (`//go:build`, `//go:embed`, `// @ts-nocheck`,
  `/* eslint-disable */`, `# type: ignore`, `#!` shebangs). SZZ labelling keeps its looser
  comment test, where a false "comment" costs little.
- The test is conservative. Docstrings and multi-line block comments without a leading `*` count as
  code, so they give 0 (no discount), never a false 1.
- Commenting code out, or uncommenting it, always gives 0: one side of the edit is a code line.

**Prior weight** -2.0 (strongly lowers risk, like `size.new_files_only`). Hard-block paths, the size
cap and the other policy rules still apply. A calibrated model that predates this signal has no weight
for it (0) until `calibrate` runs again.

## 2. Freeze windows (`freezes`)

**Paper:** Meta gates more diffs when fewer engineers are available or when traffic peaks: a weekend
zone, and a Black Friday "code chill" (§I, §II-B). The gating level is the knob.

**Config.**

```yaml
freezes:
  - name: weekend
    timezone: America/New_York   # IANA name; default UTC
    days: [sat, sun]
  - name: black-friday
    from: "2026-11-26"           # inclusive, local date in `timezone`
    to: "2026-11-30"             # inclusive
    green: 0.15                  # optional: stricter green threshold while active
```

- A window is active when the current local date in its timezone matches every condition it sets:
  `days` (weekday), `from` (date ≥), and `to` (date ≤). It must set at least one of them.
- Without `green`, an active window suspends auto-approval: every PR goes to a human. With `green`
  (same units as `thresholds.mode`, a score or a percentile), a PR is auto-approved only if its score
  is below that stricter threshold. `green` must be less than `thresholds.green`.
- Tiers and `risk:*` labels do not change during a freeze. A freeze only adds a `human-review` rule,
  so its reason sits next to the others.
- The time comes from `GateInput.now` (epoch ms). The engine passes `Date.now()` unless `ScoreOptions.now`
  is set, so `decide` stays deterministic in tests.

## 3. PR-state gate (RADAR)

**Paper:** RADAR never auto-lands a diff that is work in progress or previously rejected (§2.7.3).

A draft PR, or a PR where any reviewer's latest decisive review (approved, changes requested,
dismissed) is "changes requested", goes to a human. The Action fills `GateInput.pr.draft` and
`pr.changesRequestedBy`. Local CLI and MCP runs leave them unset, so the rule has no effect there.

## 4. Content blocklist (RADAR)

**Paper:** RADAR rejects diffs that contain blocklisted code phrases (§2.7.3, §2.9).

`content.block` is a list of JS regular expressions, checked against every added line. Each pattern
that matches adds a `human-review` reason naming up to three `file:line` locations. The config is read
from the base branch, so a PR cannot change its own blocklist.

## Deferred

These need state across runs or a different kind of LLM judge: blocking a bot by its own revert
history, daily volume caps, a landing delay, a safe/risk category classifier with a confidence bar,
and separate thresholds per author or source.

## Testing

- `size.comment_only`: comment-only edit gives 1. Mixed code and comment gives 0. Commenting code out
  gives 0. An ignored file plus a comment-only change gives 1. A binary-only or empty diff gives 0.
- Shared comment helper: SZZ label tests still pass unchanged.
- `freezes`: schema rejects an empty window, a bad timezone, a malformed date, and `green` ≥ `thresholds.green`.
  `decide` checks the weekday in the window's timezone (a UTC Friday-night instant is Saturday in
  Asia/Tokyo), inclusive date bounds, suspension versus a stricter green, an inactive window changing
  nothing, and percentile mode.
- PR state: a draft goes to a human. Every reviewer whose latest decisive review requests changes is
  named. A later approval or dismissal clears the request, and opendrs's own approvals never clear
  one. A reviews-fetch failure fails closed.
- `content.block`: new-side line numbers across hunks, context lines and `\ No newline` markers. No
  match on deleted or context lines. At most 3 locations per reason. One reason per pattern. Binary
  files are skipped.
