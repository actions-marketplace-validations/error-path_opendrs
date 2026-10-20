---
title: "What Anthropic's code-review write-up means for opendrs"
description: "Brainstorming note on Anthropic's 'Solving code review at Anthropic' blog post: a practice-by-practice map against opendrs's current docs and code, opportunities with cost/risk/measurement, two or three strategic bundles, and open questions for the user."
---

# What Anthropic's code-review write-up means for opendrs

Research note, 2026-10-20. Source:
[claude.dev/blog/solving-code-review-at-anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/),
fetched twice (once for a full pass, once to recheck named tools, numbers and verbatim quotes).
No code changed for this note; it is brainstorming groundwork only.

## 1. Article summary

**The problem.** Claude now writes about 90% of Claude Code's own code, and daily changes in the
monorepo rose from about 2,500 in May to more than 30,000 in September. Line-by-line human review
of that volume is "incredibly difficult if not impossible." Anthropic's stated optimization target
is the minimum human review time that does not raise reverts or incidents — review is reframed from
a gate at the end of the road to something closer to continuous spellcheck.

**Architecture: a seven-layer pipeline.**
1. **Pre-PR verification.** The author's own agent runs tests, build and lint, then a second agent
   reviews the diff in a fresh context before the PR is even opened. Anthropic's Boris Cherny calls
   this "probably the most important" step, estimating it roughly doubles or triples final quality.
2. **Automated code review.** Every PR gets an AI review of the diff against the whole repo and the
   PR's stated intent. Multiple agents hunt for issues in parallel; a finding is posted only after
   enough agents agree it is real. Small PRs mostly "come back clean"; PRs over ~1,000 lines usually
   get findings.
3. **Security review.** A separate automated pass that can block merge on its own.
4. **Required CI.** Lint, type checks, cross-platform tests and build — "dozens of checks" before a
   human looks.
5. **Risk-tiered human approval.** Low risk (docs, copy, additive flagged changes) needs zero human
   approvals once checks are green; medium (ordinary product changes, caching, the auto-updater,
   system prompts) needs one; high (the riskiest paths) needs two. The change sets the tier, not the
   author; an agent can never fill a human approval slot; approval is tied to one exact commit, so a
   new commit needs a fresh approval.
6. **Merge queue.** Re-runs every check against main with the change already applied.
7. **Gradual release.** New behavior ships behind a flag to Anthropic employees first, then to a
   `latest` channel before `stable`; flags turn off without a redeploy; a weekly on-call rotation
   watches for regressions.

**Concrete practices around the pipeline.**
- `CLAUDE.md` states stack, conventions, goals and non-goals; the reviewer flags violations of it.
- `REVIEW.md`, written by code owners, says what failure looks like in their area, caps nits, lists
  paths to skip, and asks for file-and-line evidence.
- Findings are tagged Important, Nit or Pre-existing (so an author is not blamed for an old bug);
  every finding must be answered — fixed, or closed with a stated reason.
- **Convergence controls**, added after an early PR exceeded 50 review rounds in an agent-vs-agent
  loop: a three-round cap (after which the reviewer asks the author to step back), diff-only
  re-review after the first pass, class-level flagging (fix every instance of a bug class, not one
  line), and never repeating a finding. Nightly agents also review existing code, not just new PRs.
- A git-blame analysis of repeated findings found that about 59% of what kept getting flagged was
  code already present since the reviewer's first pass — the reviewer was mostly re-finding a few
  more old bugs each round, not catching new ones.
- **Reviewer-quality loop.** The reviewer is scored daily against an eval set built from real
  incidents (each one becomes an expert-confirmed test case), tracking recall against noise
  (false positives); the stated priority order is "catching real bugs first and cutting review
  rounds second."
- **Context sharing** replaces passive reading: someone who wants to understand a slice of the
  codebase asks Claude for an explainer of exactly that slice, built fresh each time, instead of
  reading old PRs. Work also happens in open Slack channels, which the article credits as part of
  how quality holds up without a gate on every line.
- **Ownership.** "You land it, you own it": the person who directed the change (not necessarily
  wrote it) is responsible for fixing it if something breaks, enabled by small reversible changes,
  cheap rollback, and telemetry that surfaces regressions quickly. Riskier code gets more people and
  more checks, not more trust.
- **Direction changes** happen early and cheaply: someone in the channel questions a PR, points at
  a past decision, or suggests a simpler route, and the author reshapes or closes it — closing a PR
  is normalized since the agent's time to redo the work is cheap.

**Numbers reported.** Merged PRs more than doubled June–September; reverts fell more than 40% over
the same period; PRs passing after one review-and-fix round rose from 65% to 78%; PRs needing five
or more rounds fell from 8.9% to 1.5%; mean review rounds to pass fell from 2.08 to 1.32; in an
earlier research-preview launch, the share of PRs getting a substantive AI review comment rose from
16% to 54%.

**What worked, per the article:** pre-PR verification, multi-agent review with voting, risk-tiered
approval, the incident-derived eval loop, the three-round convergence cap, staged/flagged releases,
and on-demand context explainers.

**What was tried and changed:** unlimited review rounds (replaced by the three-round cap and
diff-only re-review after the first pass), line-by-line findings (replaced by class-level flagging
so one comment fixes every instance), and repeated findings across rounds (eliminated outright).
Anthropic is explicit that automatic circuit breakers which would tighten approval when error rates
rise are "not yet" built, and that noticing a bad merge "still depends on the author and on-call" —
not solved. The article ends by asking readers which checks they have automated, which still need a
person, and what Anthropic has wrong.

## 2. Mapping to opendrs

| Anthropic practice | Status | Evidence |
|---|---|---|
| Risk-tiered human approval (0/1/2 approvers by change risk; the change sets the tier, not the author) | **Already done**, different shape | `docs/policy.md` tiers (green/yellow/red); `docs/captain.md` §2 priority table (careful/standard/quick) is almost the same three-level idea applied to the *final* human; `docs/auto-approve.md`'s per-source policy (human/bot/agent get their own thresholds) is the "who authored it" half of Anthropic's rule |
| Approval tied to one exact commit; a new commit needs a fresh approval | **Already done** | `docs/auto-approve.md` §3: "a ruleset ... dismisses stale approvals on push ... so a later push can never merge on an earlier approval"; opendrs checks for the ruleset before approving |
| Merge queue after approval | **Already done** | `docs/auto-approve.md` §5, `mergeMethod: queue` |
| An AI review must pass before merge-worthy | **Already done** | `docs/auto-approve.md` §4, `autoApprove.requireAiReview.checks`; `docs/llm-reviewers.md` wires the brief into Claude Code, claude-code-action, Bugbot, CodeRabbit, Copilot, Codex |
| Reviewer-quality loop scored against an incident-derived eval set, tracked over time | **Partly done** | `opendrs calibrate`/`backtest` (`docs/calibration.md`) and the ApacheJIT benchmark (`docs/results.md`, `docs/experiments.md`) play this role for the *score*, not a reviewer; `opendrs feedback` records real incidents to `.opendrs/incidents.jsonl` (`docs/calibration.md`) but nothing re-runs that file as a standing eval on every change — it is "run on demand," not daily |
| Confidence-gated, multi-pass finding verification before posting | **Partly done** | `docs/llm-judge.md`'s `requireSafe` gate uses a `minConfidence` threshold (1–10) on a single judge pass; there is no multi-agent voting step and no Important/Nit/Pre-existing tagging |
| Convergence controls (round cap, diff-only re-review, class-level flagging, no repeat findings) | **Not applicable** | opendrs does not loop with the author across review rounds — it scores a diff once per push. `drift.scope` (`docs/captain.md` §4) tracks a different thing: what a PR grew into since opendrs first scored it, not review-round convergence |
| Security review as a separate pass that can block merge | **Not done** | No opendrs-native security scan; `docs/policy.md`'s `content.block` regex and `paths.block` are the closest analogues, and `requireAiReview.checks` can point at someone else's security-review check run, but opendrs does not run one itself |
| Pre-PR verification (author's own agent tests/builds/lints, then a fresh-context self-review) | **Not applicable** | Author-side tooling before a PR exists; opendrs only sees pushed diffs |
| `CLAUDE.md` / `REVIEW.md` as reviewer context | **Not applicable** | Those are instructions to an LLM reviewer, not opendrs's job; `docs/llm-reviewers.md` is the adjacent artifact — it is the recipe for getting opendrs's *own* brief in front of those same reviewers |
| On-demand context explainer for a codebase slice | **Partly done**, different content | `opendrs explain <file>` (README, `docs/cli-and-mcp.md`) gives a file's history, fixes, authors, dependents and path policy on demand — same "ask instead of read" shape, narrower content (risk facts, not a prose explainer) |
| Domain-specific forced-review categories (billing, auto-updater, system prompts always need 1–2 approvers) | **Partly done** | `paths.critical` (`docs/policy.md`) raises captain priority to careful (`docs/captain.md` §2) for matching files, but it is a single global glob list, not named per-domain tiers; field test finding #18 (`docs/research/2026-10-19-field-test.md`) confirms the default misses domain-specific critical code (a symlink-escape fix in fastlane scored green/quick) |
| Gradual release, feature flags, fast rollback | **Not applicable** | opendrs is a scoring tool, not the thing being released; `freeze windows` (README features table) is the nearest relative — it suspends auto-approval on a schedule, not a rollback mechanism |
| Tracking review-funnel metrics over time (median approvals, PR wait time, mean rounds, revert/incident rate) | **Partly done** | `docs/auto-approve.md` §1 asks a team to "compare the scores with what reviewers found and what was reverted" for two to four weeks by hand; opendrs itself does not compute or report these numbers as a standing output |
| "You land it, you own it" / ownership culture | **Not applicable** | Organizational norm, not a tool opendrs can enforce |

## 3. Opportunities

Each idea is scoped to something opendrs's own docs or experiments already point at, not a fresh
feature area.

**O1. Multi-pass verification and a severity taxonomy for the LLM judge.**
Right now `requireSafe` gates on one judge pass's confidence score. Anthropic's gain came from
*multiple* agents voting before a finding posts, plus tagging (Important/Nit/Pre-existing) so an
author isn't blamed for old bugs. Applied to opendrs: re-run the judge (or a cheaper second model)
on hunks the first pass calls risky, and tag a captain-brief fact as "pre-existing" when git blame
shows the flagged line predates the PR.
- **Value:** fewer false positives reaching the captain; a more defensible `requireSafe` gate.
- **Cost:** M (reuses the existing judge prompt/schema; adds a second pass, a blame lookup).
- **Risk:** more LLM spend and latency for an already opt-in, already-paused-pending-budget feature
  (`docs/experiments.md`'s "Planned: LLM plus opendrs vs the LLM alone").
- **Measurement:** free simulation first, on the cached 800-commit Sonnet judgements already in
  `bench/apachejit/results-llm.md`, before any new paid run — same pattern as the existing paused
  experiment.

**O2. Decay and existence-check `coupling.missing`.**
The field test found `coupling.missing` fired 18 times across six repos and was judged noise all
18 times (`docs/research/2026-10-19-field-test.md`, captain-fact table). `docs/captain.md` §6.1
already notes the gap: it does not check whether the partner file still exists, nor decay by recency.
Anthropic's finding that 59% of repeat findings were old, already-seen code is the same shape of
problem — a stale signal kept firing.
- **Value:** directly fixes a confirmed, documented false-positive source.
- **Cost:** S–M (one more git lookup plus a recency weight in `src/architecture/coupling.ts`).
- **Risk:** low; could suppress a few true positives if the decay window is too aggressive.
- **Measurement:** pre-registered ApacheJIT re-run (lift and fire count with vs without the fix),
  same method as the existing coupling experiment, plus a field-test spot check on the 18 noisy
  fires.

**O3. Pre-flight check for the stale-approval ruleset before `autoApprove` runs.**
Anthropic ties approval to one exact commit as a hard rule. `docs/auto-approve.md` §3 documents the
same requirement for opendrs ("opendrs checks for it before every approval") but as prose guidance
for the user to turn on, not a verified precondition in code (unclear whether the Action actually
queries GitHub's ruleset API before approving, or only in docs).
- **Value:** closes a safety gap Anthropic treats as non-negotiable.
- **Cost:** S (one GitHub API check, fail-closed with a clear message if missing).
- **Risk:** low; could be a no-op if the check already exists in code and only the doc needs
  clarifying.
- **Measurement:** unit test plus a dogfood run against a repo with the ruleset off.

**O4. Named, per-domain forced-tier paths.**
Anthropic's medium/high examples are named domains (caching, the auto-updater, system prompts), not
one glob list. opendrs's `paths.critical` is a single flat list; field-test finding #18 shows the
default misses domain-specific critical code (fastlane's symlink-escape fix, vapor's TLS code)
across every repo tested.
- **Value:** closes a confirmed gap with real examples from the field test.
- **Cost:** S (schema: a path glob plus a label, e.g. `paths.critical: [{glob: "**/auth/**", tier: careful}]`).
- **Risk:** low; mostly a config-shape change plus docs.
- **Measurement:** no benchmark needed — this is a decision captains sign off on, same bar
  `docs/captain.md` §8 already applies to `layers.*`/`contract.*`; validate with the field-test
  repos' known misses as regression fixtures.

**O5. A standing incident-based regression eval, reusing `.opendrs/incidents.jsonl`.**
Anthropic's reviewer-quality loop runs daily against an eval set built from real incidents. opendrs
already records incidents via `opendrs feedback`, but nothing re-runs that file as a check when a
signal or weight changes — `docs/experiments.md`'s own ApacheJIT-only experiments are the closest
thing, and they are external-benchmark, not this-repo's-own-incidents.
- **Value:** catches a scoring regression on *this repository's own* history before it ships, the
  gap Anthropic's loop is built to close.
- **Cost:** L (needs real incident volume to be useful; a harness to replay `.opendrs/incidents.jsonl`
  against any model change).
- **Risk:** cold start — most adopters, including opendrs's own repo, likely have too few recorded
  incidents yet for the eval to be stable; risk of building infrastructure ahead of data.
- **Measurement:** dogfood on opendrs's own `.opendrs/incidents.jsonl` first; defer a general feature
  until that file has enough rows to be noisy-but-usable.

**O6. Review-funnel self-measurement for the onboarding baseline.**
`docs/auto-approve.md` §1 tells a team to compare scores against "what reviewers found and what was
reverted" for two to four weeks, by hand. Anthropic's headline numbers (mean rounds, PR wait time,
pass rate) are exactly the metrics that step is informally asking a team to notice.
- **Value:** makes the existing onboarding step's "look at it for a few weeks" concrete and
  comparable before/after turning on auto-approve.
- **Cost:** L (GitHub API integration to compute rounds, approvals, wait time, revert rate over a
  date range — a different surface than today's git-only signals).
- **Risk:** scope creep toward an analytics product; the README's own comparison table already
  distances opendrs from being a general PR-analytics tool ("A risk gate ... with no service to
  host" vs. other categories).
- **Measurement:** none needed to build it, but needs a clear non-goal line (report-only, no new
  policy decisions) to avoid mission creep.

## 4. Strategic approaches

**Approach A — Tighten what's already shipped.** Bundle O2 (coupling decay), O3 (stale-approval
pre-flight) and O4 (named forced-tier paths). All three fix a documented gap with existing docs or
field-test evidence behind them, touch code that already exists, need no new infrastructure, and
carry low risk. Trade-off: it does not address the two things Anthropic credits most for its actual
measured gains — multi-pass verification and the incident eval loop — so it is a maintenance pass,
not a leap in capability.

**Approach B — Make the optional judge and facts smarter.** Bundle O1 (multi-pass judge
verification and pre-existing/new tagging). This is the direct analogue of Anthropic's own
highest-leverage change (voting before posting a finding), but it only touches the already-opt-in
LLM judge path, so the blast radius is small. Trade-off: more LLM spend on a feature that's already
paused pending budget approval (`docs/experiments.md`), and it answers Anthropic's practice most
literally but on the part of opendrs fewest users have turned on.

**Approach C — Close the measurement loop.** Bundle O5 (incident regression eval) and O6
(review-funnel stats). This is what Anthropic's write-up frames as the actual engine behind their
numbers — not the layers themselves, but continuously measuring the layers against real outcomes.
Trade-off: the largest cost and the most scope-expansion risk (O6 edges toward a PR-analytics
product opendrs's own README argues against being), and O5 needs incident volume opendrs likely
does not have yet, even on its own repository.

**Recommendation.** Ship Approach A first: three independent, low-risk fixes against gaps the
project's own field test and docs already named, deliverable without new infrastructure or a
pre-registered experiment budget. Treat Approach B as the next increment specifically because the
judge path is opt-in and already has a paused, budgeted experiment waiting — O1 slots into that
experiment's own "free simulation first" pattern rather than opening a new one. Hold Approach C
until there is real incident volume (dogfood the question in O5 before committing to the harness in
O6); building a measurement loop ahead of the data to measure is the same ordering mistake YAGNI
warns about, and the README already draws a line against opendrs becoming an analytics tool.

## 5. Questions for the user

1. Which bundle should the next design note scope out first?
   **(a) Approach A — tighten coupling decay, the stale-approval pre-flight check, and named
   forced-tier paths [recommended: cheapest, evidence already in hand, no new experiment budget
   needed]**
   (b) Approach B — multi-pass judge verification and pre-existing/new fact tagging
   (c) Approach C — incident regression eval and review-funnel stats
   (d) something not listed here

2. For O1 (multi-pass judge verification), should it first be checked as a free simulation on the
   cached 800-commit Sonnet judgements already in `bench/apachejit/results-llm.md`, the same way the
   paused "LLM plus opendrs" experiment plans to?
   **(a) Yes — simulate on cached judgements before any new paid run [recommended: no API spend,
   reuses data already paid for]**
   (b) No — design and pre-register a fresh paid run instead
   (c) Not worth pursuing right now

3. For O4 (named forced-tier paths), where should the new shape live?
   **(a) Extend `paths.critical` to accept an optional tier label per glob [recommended: smallest
   schema change, reuses an existing, already-documented key]**
   (b) A new top-level `riskTiers` config key, separate from `paths.critical`
   (c) Leave it as a documented per-repo convention only, with no schema change

4. For O3 (the stale-approval ruleset pre-flight), should a missing ruleset hard-fail `autoApprove`
   or only warn and proceed?
   **(a) Hard-fail [recommended: matches the existing "opendrs checks for it before every approval"
   language in `docs/auto-approve.md` §3, which already reads as a hard requirement]**
   (b) Soft-warn: comment on the PR but still approve

5. Should O5 (the incident regression eval) start now, or wait?
   **(a) Wait — the pending-queue memory already lists v0.3.0, then the v0.3.1 threshold-display
   fix, then the paused LLM experiment ahead of this; O5 needs incident volume opendrs likely does
   not have yet [recommended]**
   (b) Start a small pilot now, in parallel with the queued work
