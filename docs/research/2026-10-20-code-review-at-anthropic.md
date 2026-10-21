---
title: "What Anthropic's code-review write-up means for opendrs"
description: "Research note on 'How the Claude Code team does code review' (claude.dev, 2026-10-15): a checked summary, a practice-by-practice map against opendrs's docs and code, opportunities with cost/risk/measurement, three strategic bundles, what the article implies for the chosen verification pass, open questions, and a verification log."
date: 2026-10-20
---

# What Anthropic's code-review write-up means for opendrs

Anthropic's write-up on how the Claude Code team reviews code describes six layers of checks, and
its largest stated gain comes from agents verifying their own work before a pull request exists.
This note maps each practice to what opendrs already does: risk-tiered approval, blocked paths and
the merge queue are in place, and verified, severity-tagged findings are not. It then weighs three
approaches to close the gap.

Re-checked against the source on 2026-10-20. Source: "How the Claude
Code team does code review", by Addy Osmani, Morgan Westlee Lunt and Qing Wang, claude.dev blog,
published 2026-10-15, at
[claude.dev/blog/solving-code-review-at-anthropic](https://claude.dev/blog/solving-code-review-at-anthropic/)
(the URL slug differs from the title). The re-check read the full page text, not a summary; see
the verification log at the end. No code changed for this note; it is brainstorming groundwork.

## 1. Article summary

**The problem.** Claude writes about 90 percent of Claude Code's own code. In Anthropic's
monorepo, changes landing per day went from about 2,500 in May to more than 30,000 in September
2026; Claude Code lives in a separate repository under similar pressure. Line-by-line human review
at that rate is, in the authors' words, close to impossible. The team's stated target, reached
only after it already had high review coverage and deep reviews, is the minimum human review time
that does not raise reverts or incidents. Review moved from a gate at the end (write, open a PR,
wait) to something continuous, like spellcheck: most changes have been reviewed and fixed by
Claude at least once before a human is asked to look.

**How success is measured.** The goal is that most PRs merge with at most one human in the loop,
who can be the author, with no rise in reverts or incidents. Human time is tracked as human
approvals per PR (median and 95th percentile), human comments, and how long a PR waits on a
person. Revert and incident rates are the guardrail: if they rise, time was moved, not saved.

**Architecture: six layers of checks, with rollback under them.** The article's own figure counts
six layers; its prose numbers seven sections.
1. **Verified before the PR exists.** Claude runs tests, build and linter and shows the output,
   then a subagent reviews the diff in a fresh context. Internal skills hunt bugs, simplify the
   diff and check behaviour end to end; UI changes are checked against design guidelines. Boris
   Cherny calls giving Claude a way to verify its own work probably the most important thing for
   good results, estimating a two-to-three-times better final result. Note what that claim is
   about: the agent verifying its own output before a PR, not the reviewer's voting step.
2. **AI review on every PR.** Reads the diff against the whole repo and the PR's stated intent;
   asks whether the change solves its problem, fits the system, or breaks something else; on a
   bug fix, looks for the root cause. Repos are set to Quick, Standard or Deep; Deep where one
   missed bug costs more than the extra review time. Several agents hunt for bugs in parallel;
   a *separate* group votes on each finding, and it is posted only if enough of them agree it is
   real. Findings that are only about style, diagnostics or cleanup are dropped. Those filters
   were A/B tested on the team's own PRs before being kept (no numbers given). Survivors appear
   as inline comments sorted by severity, each tagged Important, Nit or Pre-existing, so a bug
   the PR did not introduce is not pinned on the author. Every finding has to be answered: fix it
   or resolve the thread with a reason; an agent often picks up the fix overnight.
3. **Security review.** A separate automated pass. A PR cannot merge while any finding from
   either review is open; closing a thread with a short reason clears a false positive; a later
   commit that fixes the issue clears the finding on its own.
4. **Required CI.** Lint, types, tests on every platform, build and packaging; dozens of checks
   on a typical CLI PR. The PR template asks how the change was tested and how to undo it; Claude
   can fill that in, but the person who asked for the change signs off.
5. **Human approval, scaled by risk.** Low (docs, copy, internal-only features, additive changes
   behind a flag): no human approval once automated review and security checks are green.
   Medium (ordinary product changes; sensitive areas such as caching, the auto-updater, system
   prompts): one person. High (the highest-risk code plus a small set of paths): two. The change
   sets the tier, not the author: one classifier picks the tier, a second asks whether this
   particular change needs another person anyway. Some paths always need a person: anything
   owners list as sensitive and any CI workflow file. Only authors on the repo's trusted list get
   the lighter paths; everyone else needs a second person. An agent's approval never fills a
   human slot. The person who directed an agent counts as one of the required reviewers. An
   approval covers one commit; a new commit the system cannot vouch for (an agent's push, a
   hand-resolved merge) needs the approval again.
6. **Merge queue, flags, gradual release.** The queue re-runs every check against main with the
   change applied. New behaviour ships behind a flag to Anthropic employees first, then to the
   `latest` channel, with `stable` trailing.
7. **Fast detection, fast rollback.** Flags turn off without a deploy; a weekly on-call rotation;
   incident reviews ask which layer should have caught the issue. Noticing a bad merge still
   depends on the author, on-call and the revert/incident dashboards. There are no circuit
   breakers yet that tighten approval when those numbers move, and engineers want them before
   more code goes to zero-human merges. Slowing down lowers the error rate mostly by doing less
   of everything; the team prefers to get faster at noticing and fixing.

**Instruction files.** When the reviewer keeps flagging the same thing, the fix goes to the
source: a skill, a lint rule, or `CLAUDE.md`/`REVIEW.md`. `CLAUDE.md` says what the project is
(stack, conventions, goals, non-goals), is kept short because every review loads it, and the
reviewer flags both convention breaks and changes that make a line in it stale. `REVIEW.md`,
written by code owners, says what failure looks like in that area (docs: it lies; config: it
misroutes), caps nits, lists paths to skip, demands a file and line as evidence rather than a
guess from a name, and asks for a summary that starts with a count and says plainly when there is
nothing to fix. The team checks separately whether the reviewer actually follows it.

**Making the reviewer better.** Past PRs that caused incidents, with their fix-forwards and
reverts, became an eval set; engineers who know the code confirmed each bug and where it lived;
every change to the reviewer's prompts, tools or model is scored against the whole set daily and
kept only if the score goes up. Noise is measured two ways: every reviewer comment is sorted by
what the person on the PR did with it (fixed it, said it was wrong, said it was intentional, or
decided it did not matter), and the reviewer is run on PRs known to be clean, counting findings
that would have led someone to make a harmful change. The written priority is "catching real bugs
first and cutting review rounds second." Noise costs more when the author is an agent: a person
waves off a nit in seconds, an agent fixes it, adding a commit and another round.

**Convergence.** An agent author and an agent reviewer can keep each other busy indefinitely; one
CLI PR went through more than fifty rounds overnight before its author stopped it. Git blame on
what the reviewer kept flagging showed about 59 percent was code present since the reviewer's
first pass: it was finding a few more old bugs each round, not new ones. The team had made this
worse by running several rounds by default. It now tracks rounds-to-pass alongside recall and
changed re-review: a cap of three rounds, after which the reviewer asks the author to step back
and reconsider the approach; diff-only re-review after the first few passes; flag the class of
bug so the author fixes every instance, not one line; never repeat a finding already posted.
Review agents also run nightly over existing code. Results on internal PRs, before and after:
pass after one review-and-fix round 65 to 78 percent; five or more rounds 8.9 to 1.5 percent;
mean reviews to pass 2.08 to 1.32.

**Where humans stay.** Deciding whether to build it (direction, taste, scope); risky code such as
billing, the auto-updater and CI workflows; architecture that sets a pattern others copy; reading
the evidence (test output, the command and its result, a screenshot, the reviewer's findings),
with the rule that if you cannot say what the checks would miss, ask for a real review rather than
a quick approval; owning the outcome.

**Context sharing.** There is no formal process. Someone who wants to understand a slice of the
codebase asks Claude for an explainer of exactly that slice, built fresh, sometimes as a small
visual artifact; this beats reading trivial diffs line by line. Working in open Slack channels
does the rest.

**Ownership and direction.** The land-it-own-it norm: whoever lands a small or medium change
usually fixes what it breaks, made safe by small changes, cheap reversal, more people and checks
on expensive code, fast telemetry, and incident reviews that look at the system rather than
assign blame. Direction changes happen early in the thread: someone asks why, points at an
earlier decision or suggests a simpler route, and the author closes or reshapes the PR, which is
cheap because the code was cheap to write.

**Numbers reported.** Merged PRs more than doubled from June to September 2026 while the share
reverted fell by more than 40 percent (whole system, no single layer credited); research-preview
launch of the AI reviewer took substantive review comments on internal PRs from 16 to 54 percent;
most PRs over 1,000 lines get findings and most small ones come back clean; the convergence
numbers above; 59 percent of repeat findings were old code; Boris Cherny's two-to-three-times
estimate for verification.

**The adoption checklist** (the article's own, condensed). Before the PR: checks the agent can
run, listed in a short `CLAUDE.md`, plus formatter/linter hooks; a local `/code-review` and
`/security-review` or a fresh-context subagent review; a `REVIEW.md` that absorbs repeated
comments. On every PR: required CI; testing, risk and how-to-revert fields in the PR template; an
AI reviewer on one repo, tuned for a few weeks, then widened; automated security review; every
thread resolved before merge; review effort matched to risk; capped rounds with diff-only
re-review. Approval: written risk tiers set from the change, starting strict and loosening with
evidence; lighter paths only for trusted authors; CODEOWNERS and branch protection so auth,
billing, CI and release workflows and installers always need a person; a bot's approval never
replaces a required human's; approvals dismissed on new commits. After: merge queue, flags,
internal use first, staged releases, one-step rollback; incidents and reverts turned into an eval
set and the reviewer rescored whenever its prompts, tools or model change; human time measured
with revert and incident rates as the guardrail.

**What the article does not claim.** It gives no per-layer attribution for the June-to-September
numbers. It gives no numbers for the voting/filtering step beyond saying it was A/B tested. It does not say
the review product approves PRs: it posts findings, and only Anthropic's own repos let owners
merge low-risk changes on automated checks alone. It closes by asking readers which checks they
have automated, which still need a person, and what the authors have wrong.

## 2. Mapping to opendrs

Checked against the docs and code at `main` (v0.4.1 released; v0.5.0 in integration).

| Anthropic practice | Status | Evidence |
|---|---|---|
| Risk-tiered human approval; the change sets the tier | **Done**, different shape | `docs/policy.md` green/yellow/red from the score; `docs/captain.md` §2 careful/standard/quick for the final human, the direct analogue of Quick/Standard/Deep review effort |
| A second classifier that can demand a person even when the tier says no | **Partly done** | Deterministic: `paths.critical` raises captain priority to careful (`docs/captain.md` §2). Random: `sampleRate` (default 10 %) sends eligible PRs to a human anyway (`docs/policy.md`) |
| Paths that always need a person (owner-listed sensitive paths, CI workflow files) | **Done** | `paths.block` defaults include `.github/**`, CODEOWNERS, migrations, install/build scripts; the self-modification guard covers opendrs's own config, model and Action files (`docs/policy.md`) |
| Lighter paths only for trusted authors; a bot's approval never fills a human slot | **Done**, different shape | Per-source policy (`sources.<human\|bot\|agent>`) with `trackRecord` (default: 10 landed commits in 60 days, at most 5 % reverted), `dailyCap`, stricter green; sources can only tighten (`docs/policy.md`). opendrs approves only what the branch rules let a single approval merge |
| Approval covers one commit; dismissed on new commits | **Done, in code** | `src/action/approval.ts` `reconcileApproval` calls `dismissesStaleApprovals` before every approval: it reads the active ruleset (or classic protection) and refuses with a setup message unless the branch requires at least one approval and dismisses stale ones on push. `docs/auto-approve.md` §3 and the "Stale approvals" rail in `docs/policy.md` describe the same thing. The Action also withdraws its own approval when a later push makes the PR ineligible |
| Merge queue after approval | **Done** | `docs/auto-approve.md` §5, `mergeMethod: queue` |
| AI review must pass before merge; every finding answered | **Partly done** | `autoApprove.requireAiReview.checks` waits for a check run that fails on a blocking finding (`docs/auto-approve.md` §4); opendrs cannot see whether each thread was answered, only whether the check passed |
| Reviewer findings verified by a separate group before posting; style/cleanup dropped; severity-ranked; Important/Nit/Pre-existing tags | **Not done** | Captain facts are deterministic, `strong`/`info`, posted as computed (`docs/captain.md` §4); the judge's `risky_snippets` and hunk categories come from one call (`src/llm/schema.ts`); `requireSafe` gates on one pass's per-hunk confidence (0–10, `docs/llm-judge.md`). The field test graded `coupling.missing` noise on all 18 fires (`docs/research/2026-10-19-field-test.md`). This is what the chosen verification pass addresses (`docs/specs/2026-10-20-verification-pass-design.md`, draft) |
| Pre-existing vs new: git blame to stop blaming the author for old code | **Partly done** | `src/brief/blame.ts` already blames the deleted lines of candidate hunks against the base to find earlier fix/revert commits; nothing yet tags a fact or finding as pre-existing |
| Evidence is a file and a line, never a guess from a name | **Done** | Every captain fact names a file and, where one exists, a line (`docs/captain.md` §4); the brief asks reviewers for file:line evidence (`docs/llm-reviewers.md`) |
| Say what the checks would miss | **Done** | Unknown signals are listed and block auto-approval when they could change the tier (`docs/policy.md`, "Unknown is not safe"); "Needs a human regardless" in the brief |
| `CLAUDE.md` / `REVIEW.md` as reviewer context; fix repeated findings at the source | **Partly done**, inverted | Those files are the user's; opendrs's brief is the adjacent artifact, giving the reviewer context it would not otherwise have (`docs/llm-reviewers.md`); "Check specifically" questions are fixed templates, not owner-written |
| Incident-derived eval set, rescored on every reviewer change | **Partly done** | `.opendrs/incidents.jsonl` via `opendrs feedback` feeds `calibrate`/`backtest` as labels (`docs/calibration.md`), on demand, not in CI; the ApacheJIT benchmark plus pre-registration in `docs/experiments.md` is the rescoring discipline for the score; `bench/apachejit/results-llm.md` records the judge's prompt hash per run |
| Noise measured by what people did with each comment, and by running on known-clean PRs | **Not done** | No per-fact or per-finding feedback channel; `opendrs feedback` is incident-level only. The field test's hand grading (`docs/research/2026-10-19-field-test.md`) is the one-off version |
| Convergence controls (round cap, diff-only re-review, class-level flagging, no repeats) | **Not applicable**, one exception | opendrs scores once per push and updates one comment in place. The exception: a fact the captain dismissed should not come back on the next push; nothing remembers that today. `drift.scope` (`docs/captain.md` §4) measures PR growth, not rounds |
| Nightly review of existing code | **Partly done** | `opendrs hotspots` ranks files by risk at rest, on demand (`docs/cli-and-mcp.md`) |
| Security review as a separate blocking pass | **Not done** | `content.block` and `paths.block` are the nearest rails; `requireAiReview.checks` can point at someone else's security check run |
| Pre-PR verification by the author's own agent | **Not applicable**, adjacent | opendrs sees pushed diffs; the MCP server (`score_diff`, `explain_file_risk`) lets an agent score before opening a PR (`docs/cli-and-mcp.md`) |
| On-demand explainer of a codebase slice | **Partly done**, narrower | `opendrs explain <file>`: history, fixes, authors, dependents, path policy |
| Named, per-domain sensitive areas | **Partly done** | `paths.critical` is one flat glob list; field-test finding #18 shows the default misses domain-specific critical code (fastlane's symlink-escape fix in `resign.sh` scored green/quick; vapor's TLS code by file name) |
| Gradual release, flags, rollback | **Not applicable** | opendrs is not the thing being released; freeze windows and landing delay are the nearest relatives |
| Human-time metrics (approvals per PR, comments, wait time) with revert/incident guardrail | **Partly done** | `docs/auto-approve.md` §1 asks for two to four weeks of comment-only running and a by-hand comparison; nothing computes these numbers |
| Start strict, loosen with evidence | **Done** | Auto-approve off by default; comment-only first; `sampleRate` never zero; backtest before changing thresholds |
| Ownership norm, open channels, early direction changes | **Not applicable** | Organisational |

## 3. Opportunities

Each idea is scoped to something opendrs's docs or experiments already point at.

**O1. A verification pass before anything reaches the captain, with new/pre-existing tagging.**
The article's finding pipeline is: parallel hunters, a separate voting group, drop
style/cleanup, rank by severity, tag Important/Nit/Pre-existing. opendrs's equivalent surface is
the captain facts and the brief's "Review first"/"Check specifically" items (on by default,
noisy per the field test), then the judge's `risky_snippets` (opt-in). The draft spec already
takes this shape. What the article adds beyond the spec is in §5 below.
- **Value:** fewer false facts in front of the captain; a measured precision number per fact type.
- **Cost:** M (reuses the judge's provider, schema and parse code; one batched call per PR).
- **Risk:** a verifier that over-drops silently lowers attention; added spend on every brief.
- **Measurement:** the field test's graded facts as ground truth; the clean-PR fire rate; the
  bug-finding question folded into the paused ApacheJIT experiment (`docs/experiments.md`,
  "Planned: LLM plus opendrs vs the LLM alone", paused until the user approves paid runs).

**O2. Find out why `coupling.missing` was noise 18 times out of 18, then fix the cause.**
The detector already checks that the partner exists at head (`src/architecture/coupling.ts`) and
only counts commits inside `history.lookbackDays` (365), so the noise is not stale partners. The
earlier draft of this note said otherwise; that was wrong. Candidates, untested: the 60 %
confidence floor is met by files that co-change for mechanical reasons (generated files, test
and fixture pairs, changelogs the exclusion list misses); no decay inside the window; one
partner per file with no cap on facts per PR. Read the 18 cases first.
- **Value:** fixes the one fact type with 0 % precision, with or without the verifier.
- **Cost:** S to read the cases; S–M for the fix.
- **Risk:** low; could suppress true positives if a new exclusion is too broad.
- **Measurement:** pre-registered ApacheJIT re-run (lift and fire count), same method as the
  existing coupling experiment, plus the 18 field-test fires as regression fixtures.

**O3. A per-fact feedback record.** The article measures noise by what the person did with each
comment. opendrs cannot measure fact precision outside a hand-graded field test because the
captain has no way to say "wrong", "intentional" or "did not matter" about a fact. A minimal
version: `opendrs feedback --fact <id> --file <path> --verdict wrong|useful|ignored` appending to
`.opendrs/facts.jsonl`, or reading a reaction on the Action's comment.
- **Value:** the standing measurement the verifier (O1) and the detectors need to be tuned on.
- **Cost:** S–M.
- **Risk:** nobody uses it; mitigated by dogfooding on opendrs's own PRs.
- **Measurement:** none; it is the measurement.

**O4. Named, per-domain forced-tier paths.** The article's medium/high examples are domains
(caching, auto-updater, system prompts, billing, CI workflows, installers). `paths.critical` is
one flat list; field-test finding #18 shows the default misses domain-specific critical code.
- **Value:** closes a confirmed gap with real examples.
- **Cost:** S (a label per glob, e.g. `paths.critical: [{glob: "**/auth/**", tier: careful}]`).
- **Risk:** low.
- **Measurement:** the field-test misses as regression fixtures; no benchmark needed, same bar as
  `layers.*`/`contract.*` (`docs/captain.md` §8).

**O5. A standing incident-based regression eval reusing `.opendrs/incidents.jsonl`.** The file
already labels `calibrate`/`backtest`; nothing re-runs it when a signal, weight, prompt or model
changes.
- **Value:** catches a scoring regression on this repository's own history before it ships.
- **Cost:** L; needs incident volume to be stable.
- **Risk:** cold start; infrastructure ahead of data.
- **Measurement:** dogfood on opendrs's own incidents first.

**O6. Review-funnel self-measurement for the onboarding baseline.** Approvals per PR (median,
p95), comments, wait time, revert rate over a date range, so the two-to-four-week comment-only
step becomes a before/after number.
- **Value:** makes the onboarding step concrete.
- **Cost:** L (GitHub API, a new surface).
- **Risk:** scope creep toward PR analytics, which the README's comparison table keeps opendrs
  out of.
- **Measurement:** none to build it; needs a report-only non-goal line.

Dropped from the earlier draft: a "stale-approval ruleset pre-flight". It already exists
(`src/action/approval.ts`, see the mapping table).

## 4. Strategic approaches

**Approach A, tighten what is shipped:** O2 and O4. Both fix a documented gap with field-test
evidence, touch existing code, need no new infrastructure. Trade-off: no new capability.

**Approach B, the verification pass:** O1, with O3 as its measurement input. The direct analogue
of the article's finder-then-verifier pipeline and its tagging. Opt-in, so the blast radius is
small. Trade-off: LLM spend on every brief when on; the article's measured gains came from its
convergence changes and the whole system, not from the voting step alone, so B's value has to be
shown on opendrs's own data rather than borrowed from the article.

**Approach C, close the measurement loop:** O5 and O6. The article's engine is continuous
measurement against real outcomes. Trade-off: the largest cost and the most scope risk; O5 needs
incident volume opendrs does not have yet.

**Recommendation, revised.** The user has chosen B; the draft spec exists. Two adjustments
follow from the re-check. First, B needs O3 (or the field test's hand grading repeated) to be
measurable at all; the article's noise measurement is response-based, and a verifier tuned only
on one hand-graded sample will drift. Second, O2 should run before or alongside B: if the 18
`coupling.missing` fires have a mechanical cause, a detector fix removes them for free and the
verifier's precision target should be set on what remains. O4 is independent, small, and can ship
any time. Hold C until there is incident volume.

## 5. Implications for the verification-pass spec

Design requirements the article implies for approach B, for the spec worker to check against
`docs/specs/2026-10-20-verification-pass-design.md`.

1. **Correct the premise.** The article does not call voting its highest-leverage step; that
   claim is Boris Cherny's and is about an agent verifying its own work before a PR. The voting
   filter was A/B tested with no numbers published. The spec's §1 should say so and justify the
   pass on opendrs's own field-test numbers, which it already has.
2. **Separate finder and verifier.** The article's voters are a different group from the
   hunters, in their own context. The verifier must not be the same call, prompt or context that
   produced the candidate; it gets the claim, the evidence, and the one relevant hunk, and
   answers whether the claim holds.
3. **Verify against evidence, not names.** `REVIEW.md`'s rule: a file and line, not a guess from
   a name. The verifier should be asked to cite the line that supports keep or drop, and a
   verdict without one should count as unverified, not as drop.
4. **Drop by class, not by taste.** The article drops findings that are only style, diagnostics
   or cleanup. The spec should name the classes it drops (for opendrs: facts whose only subject is
   docs, tests, fixtures, generated files, formatting) and leave everything else to keep or
   downgrade.
5. **Severity before the cap.** Survivors are sorted by severity before the five-fact cap, so a
   downgraded fact can still appear when nothing stronger exists.
6. **Pre-existing is a tag, not a drop.** The article keeps Pre-existing findings visible; it
   changes who is blamed, not whether the finding shows. For brief items and judge snippets, use
   `src/brief/blame.ts`'s existing blame of the base to decide new vs pre-existing
   deterministically first, as the spec already proposes, and only ask the model when blame is
   ambiguous.
7. **Decide whether verification may lower priority.** In the article the approval tier comes
   from a classifier that is independent of the findings. In opendrs a `strong` fact raises
   priority (`docs/captain.md` §2), so a downgrade can turn careful into standard. The spec must
   say which it is; the article's structure argues for computing priority from the unverified
   facts and letting verification change only what is shown, or for a verified drop to lower
   priority only when the verifier cited a line.
8. **Recall first, noise second.** The written priority is real bugs first, rounds second. The
   shipping rule should put the recall bar (true facts wrongly dropped) ahead of the precision
   bar, and set it at zero or one on the field-test corpus, as the draft does.
9. **Measure noise two ways.** (a) By response: a per-fact feedback channel (O3) that records
   fixed / wrong / intentional / did not matter. (b) By clean inputs: run the detectors and the
   verifier on PRs known to be clean (ApacheJIT's clean commits, the field test's clean PRs) and
   count what still fires. Both belong in the pre-registered plan.
10. **Incidents are the eval; rescore on every change.** Any change to the verifier's prompt,
    model or schema is scored against the full fixture set before it lands, and the prompt hash
    is recorded, as `results-llm.md` does for the judge. Pre-register in `docs/experiments.md`.
11. **Noise costs more when the reader is an agent.** The brief goes to AI reviewers
    (`docs/llm-reviewers.md`); a wrong "Review first" item makes an agent act on it, adding a
    commit and a round. Verification of brief items matters at least as much as verification of
    captain facts, and the spec's three pools are the right scope.
12. **No repeats across pushes.** The article never re-posts a finding already posted. A fact the
    captain marked wrong or ignored on one push should not reappear on the next; the cache keyed
    by head sha does not give this, so the spec needs a dismissal memory (a reaction, a comment
    marker, or O3's file).
13. **Match verification depth to risk.** Quick/Standard/Deep: a quick-confirm PR with one info
    fact may not be worth a verifier call; a careful PR is. Make depth follow captain priority
    or make the skip explicit.
14. **Fail open, never block, never touch the gate.** Like the judge, the verifier can change
    what is shown and how it is labelled, never the score, the decision or `requireSafe`; on
    failure it shows everything with a note. The draft already says this; keep it.
15. **When the verifier is wrong, ask what it did not have.** The article's fix for a missed
    bug is more context (`CLAUDE.md`, a skill, a check), not another pass. Every wrongly dropped
    fact in the study should produce a detector or prompt fix, logged, before the pass ships.

## 6. Questions for the user

1. Should the verification pass's scope be all three pools (captain facts, review-first hunks,
   check questions) as the draft spec says, or captain facts first?
   **(a) All three, one batched call [recommended: the brief's items reach AI reviewers, where
   noise costs a round]**
   (b) Captain facts only in the first increment
   (c) Judge `risky_snippets` as well, making four pools

2. May a verifier verdict lower the captain priority (careful → standard) by downgrading the
   only strong fact?
   **(a) No; priority stays computed from the unverified facts, verification changes display
   only [recommended: matches the article's independent tier classifier and keeps the label
   deterministic]**
   (b) Yes, when the verifier cited a line
   (c) Yes, always

3. Should O2 (read the 18 `coupling.missing` noise cases) run before the verifier's precision
   study sets its target?
   **(a) Yes, first; it is a day's reading and may remove the noise for free [recommended]**
   (b) No, run the study on today's detector

4. Should the per-fact feedback record (O3) ship with the verifier so its precision can be
   tracked after launch?
   **(a) Yes, the CLI flag form, dogfooded on opendrs's own PRs [recommended]**
   (b) Later; rely on repeated hand grading
   (c) No

5. Ordering: v0.4.1 is released and v0.5.0 (module boundaries, file-level incidents) is in
   integration. Should the verification pass target v0.6.0 after v0.5.0 ships, or join the
   v0.5.0 batch?
   **(a) v0.6.0, after v0.5.0 [recommended: the spec is a draft and its study is unrun]**
   (b) Join v0.5.0

## 7. Verification log

**How the source was checked.** The page was downloaded with curl and converted to plain text
(about 23,000 characters), then read in full twice; a WebFetch summary was used once as a
cross-check on the title, authors, date and numbers. The figures (PNG) could not be viewed, but
their captions and the text inside them are in the page and were read.

**Corrections made** (before → after):
- Title "Solving code review at Anthropic", fetched twice → "How the Claude Code team does code
  review", by Osmani, Lunt and Wang, 2026-10-15, with the slug noted.
- "Seven-layer pipeline" with gradual release as layer 7 → six layers of checks plus rollback;
  gradual release sits with the merge queue and flags, and layer 7 is detection and rollback.
- Boris Cherny's "most important" and 2–3× attributed to the pre-PR step → attributed to giving
  the agent a way to verify its own work, and noted as distinct from the voting step.
- "Anthropic's gain came from multiple agents voting"; approach B as "the direct analogue of
  Anthropic's own highest-leverage change" → the voting filter was A/B tested with no numbers;
  the measured gains are from the convergence work and the system as a whole.
- Voting described as agents agreeing → a separate group votes on each finding; style,
  diagnostics and cleanup findings are dropped; survivors sorted by severity.
- "A new commit needs a fresh approval" → a new commit the system cannot vouch for (an agent's
  push, a hand-resolved merge) needs the approval again.
- Tier set by "the change, not the author" as the whole rule → added the two classifiers, the
  always-a-person paths (owner-listed, CI workflow files), the trusted-author list, and the
  director of an agent counting as a required reviewer.
- "Diff-only re-review after the first pass" → after the first few passes.
- Security review "can block merge on its own" → open findings from either review block; a
  fixing commit clears the finding automatically.
- Reviewer-quality loop "tracking recall against noise" → noise measured by the four-way response
  classification and by runs on known-clean PRs; the team also tracks rounds-to-pass.
- Added what the memo omitted: the human-time metrics, Quick/Standard/Deep, the internal skills,
  the PR template, `REVIEW.md`'s count-first summary and the check that the reviewer follows it,
  the where-humans-stay list, the adoption checklist, the point that slowing down lowers errors
  mostly by doing less, and the explicit non-claims.
- `minConfidence` "1–10" → 0–10.
- O3 "unclear whether the Action actually queries GitHub's ruleset API" → it does
  (`src/action/approval.ts` `dismissesStaleApprovals`, called from `reconcileApproval`); O3
  removed and replaced by the per-fact feedback record.
- O2 "does not check whether the partner file still exists, nor decay by recency", cited to
  `docs/captain.md` §6.1 → the existence check exists (`coupling.ts`, `readHead(pair.partner)`);
  the 365-day window exists; there is no decay inside it; the §6.1 is the captain-brief spec's,
  not `captain.md`'s. O2 rewritten as "find the cause first".
- Mapping rows added: always-a-person paths, trusted authors, evidence as file:line, say what the
  checks would miss, pre-existing via blame, noise measurement, nightly review, start strict.
- Question 5's "v0.3.0, then v0.3.1" queue → v0.4.1 released, v0.5.0 in integration.
- Verbatim quotes reduced to one.

**Still unverifiable.** Whether the claim that most PRs over 1,000 lines get findings is about
internal PRs or all users; the A/B test results for the voting filters (not published); the
figures' exact layer count beyond their captions.
