# Deferred review and landing delay — spec and plan

Status: approved in chat 2026-10-16 (roadmap target 3; delivered under a 90-minute limit).

## 1. Goal

Two RADAR outcomes opendrs lacks (arXiv 2605.30208):

1. **Deferred review.** A PR that is almost green lands now, and a human reviews it after merge.
2. **Landing delay.** An approved bot diff lands only after a configurable delay, during which a
   human can still reject it.

Both are opt-in. With the defaults (`deferredReview.enabled: false`, `landingDelayMinutes: 0`),
decisions and Action behaviour are unchanged.

## 2. Contract (committed)

- `Decision` gains `"deferred-review"`.
- `PolicyOutcome.landingDelayMinutes: number` (effective delay for this PR).
- Config `autoApprove.landingDelayMinutes` (int ≥ 0, default 0);
  `autoApprove.deferredReview { enabled = false, below?, sources = ["human"] }` (`below` must be
  above `thresholds.green` and at most `thresholds.yellow` when enabled);
  `sources.<kind>.landingDelayMinutes?` (int ≥ 0).

## 3. Policy (`src/policy/gate.ts`) — Task A

- **Deferred band.** `deferredBelow` = `below` (absolute) or the percentile score from the model (no
  percentiles → no deferral). A PR is *deferrable* when `deferredReview.enabled`, the score is in
  `[green, deferredBelow)` (so the tier is not green), and every source kind in
  `[source.floor ?? "human", source.kind]` is in `deferredReview.sources` (no source input → treat as
  `["human"]`).
- The tier rule (rule 4, "tier is not green") does not fire for a deferrable PR. Every other rule
  still applies in order. If no rule fires, the decision is `deferred-review` instead of
  `auto-approve`, with the reason
  `deferred review: score 0.34 is in the deferred band (0.30–0.45); lands now, reviewed after merge`.
  Sampling, freezes, AI-review, draft and change-request rules keep their decisions.
- `landingDelayMinutes` = max(`autoApprove.landingDelayMinutes`, the `landingDelayMinutes` of every
  kind in `[floor, kind]` that sets one).
- Reports: `src/report/markdown.ts` `DECISION_TEXT["deferred-review"] = "deferred review (lands now, reviewed after merge)"`;
  when `landingDelayMinutes > 0` and the decision is auto-approve or deferred-review, the comment says
  `Landing delay: 30 min after the head commit becomes eligible`.
- Exhaustive switches over `Decision` elsewhere (CLI exit codes, MCP, `action.yml` output docs): a
  deferred PR is not auto-approved for `--fail-above` purposes; treat like auto-approve only where
  the code means "eligible to land".
- Tests: gate (band edges, percentile mode, other rules still win, source floor gating, delay max),
  markdown, config validation (`below` missing / ≤ green / > yellow; defaults unchanged).

## 4. Action approval (`src/action/approval.ts`, `src/action/github.ts`) — Task B

- `blockers()`: `deferred-review` is eligible like `auto-approve` (all other rails unchanged).
- Landing delay, pure helpers exported from `approval.ts`:
  - `ELIGIBLE_MARKER = "opendrs-eligible"`; `eligibleMarker(head, since: Date)` →
    `<!-- opendrs-eligible: <head sha> <ISO time> -->`;
  - `readEligibleSince(body: string | undefined, head: string): Date | undefined` — only a marker for
    this exact head counts (a push restarts the clock).
- `ApprovalInput` gains `now: Date` and `eligibleSince?: Date` (from opendrs's own comment, read by
  run.ts) and `labels: string[]` (the PR's current labels).
- `reconcileApproval` returns `{ approved, status, eligibleSince?: Date, pendingUntil?: Date }`:
  - not eligible → as today (withdraw own approvals), no `eligibleSince`;
  - eligible and PR has label `opendrs:hold` → not approved, status `on hold (opendrs:hold label)`,
    withdraw own approvals; `eligibleSince` kept;
  - eligible, `landingDelayMinutes > 0`, and `now < since + delay` (since = `eligibleSince ?? now`) →
    not approved, `eligibleSince: since`, `pendingUntil: since + delay`, status
    `approves at 14:30 UTC unless someone requests changes, pushes, or adds opendrs:hold`;
  - otherwise approve as today, plus for `deferred-review`: approval body says it is a deferred
    review; request reviews from `result.policy.suggestedReviewers` (GitHub logins only — the
    suggestions are emails, so skip this when none map; best-effort, 403/422 → warning) and add label
    `opendrs:review-after-merge` (best-effort). Status `approved by opendrs (deferred review: …)`.
- New client methods in `github.ts` if needed: `requestReviewers(pr, logins)`.
- Tests in `tests/action/` (approval unit tests with the fake GitHub client).

## 5. Action run and sweep (`src/action/run.ts`, `src/action/workflow.ts`, `action.yml`, docs) — Task C

- Before approval, find opendrs's own comment (as the comment step does today) and pass
  `eligibleSince = readEligibleSince(comment.body, pr.head.sha)`, `now = new Date()`, `labels`.
- Write `eligibleMarker(head, eligibleSince)` into the comment body when returned.
- Label `opendrs:landing` while `pendingUntil` is set; remove it otherwise (best-effort, like risk labels).
- **Sweep mode:** on a `schedule` or `workflow_dispatch` event, list open PRs with label
  `opendrs:landing` (GitHub API), and for each: fetch `refs/pull/<n>/head` into the checkout, then run
  the same per-PR flow. Errors on one PR are logged and the sweep continues; the job fails if any PR
  failed. `fetch-depth: 0` checkout of the default branch is required (documented).
- `docs/github-action.md`: the schedule trigger (`cron: "*/15 * * * *"`), labels, veto options;
  `action.yml` decision output lists `deferred-review`.
- Tests in `tests/action/` for sweep (fake client: two labelled PRs, one fails, the other still runs)
  and for marker/label plumbing.

## 6. Invariants

- Defaults change nothing.
- Deferral never applies to hard blocks, unread files, size cap, LLM failure/requireSafe, unknowns,
  freezes, drafts, change requests, missing AI review, samples, or per-source rules — only the tier rule
  is relaxed, and only inside the band.
- The landing delay only postpones; a push, a change request or `opendrs:hold` stops it.
- Only opendrs's own comment (by marker and account) can carry the eligibility marker.
