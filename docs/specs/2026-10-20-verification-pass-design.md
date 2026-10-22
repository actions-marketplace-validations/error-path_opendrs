# Verification, two phases: pre-PR self-check, then a reviewer-side pass

Status: **approved 2026-10-20** (B+: two phases in one spec, built and shipped separately), after
the research memo's re-check (`docs/research/2026-10-20-code-review-at-anthropic.md`). Supersedes
the single-phase draft of the same filename. The user's answers to §4's open questions are recorded
below, replacing that section's "recommended" framing; an implementation plan for Phase 1 follows in
`docs/superpowers/plans/2026-10-20-pre-pr-self-check.md`.

## 1. Correcting the premise

The first draft said Anthropic's highest-leverage step was "voting before a finding posts," and
called the verification pass "the direct analogue of Anthropic's own highest-leverage change." The
re-check found both wrong (memo §7, "Corrections made"; implication 1). Boris Cherny's "most
important thing for good results" and 2–3× estimate are about **an agent verifying its own work
before a PR exists** — layer 1 of the pipeline, not the voting filter in layer 2. The voting step
was A/B tested with no numbers published; the measured June–September gains are attributed to the
whole system and the convergence work, not to voting alone (memo §1, §4).

So the actual highest-leverage practice — pre-PR self-verification — had no opendrs analogue at
all, while the previous draft's pass is a secondary layer the article spends less space on and
backs with fewer numbers. **Phase 1** is opendrs's analogue of the real highest-leverage step.
**Phase 2** is the previous draft, rewritten against the 15 implications the re-check derived (memo
§5) instead of the one claim it was built on.

## 2. Phase 1 — pre-PR self-verification

### 2.1 Goal and posture

Make the coding agent's own pre-PR check the required step it is for Anthropic's engineers: before
opening a PR, the agent runs the same brief a reviewer would get, disposes of every item in it (fix
or explain), and the PR carries a record of what it did. **Advisory only, never a gate** — nothing
in opendrs computes auto-approve, the score, or captain priority from this record, because the
record is author-written: the same agent whose diff is being checked wrote it, so it is untrusted
exactly where its claims and its own diff could agree for the wrong reason ("explained" because
fixing it was inconvenient). What *is* trustworthy is the comparison: opendrs recomputes the brief
itself and only shows where the record's claims and the fresh facts agree, disagree, or say nothing.

### 2.2 Mechanism

Extend what already exists rather than add a new surface. `skills/opendrs/SKILL.md` already says
"use before opening or updating a pull request"; add: run `review_brief` (MCP) or `opendrs brief`,
then go through every captain fact and `reviewFirst` hunk/`CheckItem` in it — fix the diff, or
write a one-line reason it does not need fixing. `commands/opendrs-review.md` (`/opendrs-review`)
reviews someone *else's* diff and is untouched — Phase 1 is the author's own step, pre-PR.
`docs/llm-reviewers.md` gets a short section pointing coding agents at this flow.

### 2.3 The self-check record, and why it stays honest

The record is a compact JSON array, one entry per captain fact/hunk/check id already defined by
the brief (`ArchitectureFact.id`-shaped, `reviewFirst` hunk id, `CheckItem` id):

```ts
interface SelfCheckEntry {
  id: string;                      // an id the brief already assigned
  verdict: "fixed" | "explained" | "needs-fix";
  note?: string;                   // required when verdict is "explained" or "needs-fix"; <= 140 chars
}
```

(`needs-fix` was added after the skill eval found the agent had no honest verdict for a real,
unresolved problem it could not fix itself — see `skills/opendrs/SKILL.md` and
`evals/skill/RESULTS.md`'s round 7.)

It is written into the **head commit's own message**, not a PR comment or a trailer value (which
git expects single-line), as a marker block the same shape as the Action's existing
`<!-- opendrs -->`/`<!-- opendrs-approval -->` comment markers (`docs/github-action.md`):

```
<!-- opendrs-self-check:v1
[{"id":"coupling.missing:session.ts","verdict":"explained","note":"config-only, no coupled logic"}]
-->
```

**Why this is sha-pinned by construction, not by policy.** A commit's sha is a hash of its tree,
parents, author/committer and message. Putting the record in the message means any later edit to
either the diff or the record changes the sha. There is no separate "pin to this sha" check to get
wrong: the Action/CLI reads whatever record is in the message of the exact head commit it is about
to score, for the exact diff that commit represents. A later push that does not carry the marker
forward simply has no self-check record on its new head — reported as "no self-check," never as a
stale one silently reused. This replaces the cache-keyed-by-sha mechanism the first draft used for
Phase 2's verifier (§3.4); Phase 1 needs no cache because the record lives inside the thing being
scored.

**What the Action does with it, and what it refuses to do.** It never trusts the record's claims
about the *world* (whether a fix is correct, whether an explanation is true) — only compares ids,
against the brief it recomputes fresh as if no record were present. An id **absent** from the
fresh output with verdict `fixed` counts as addressed (flagged, then it stopped firing); an id with
no match on either side is dropped silently (debug log only — most likely stale, not a lie worth
surfacing). An id still **present** with verdict `explained` renders as `(author: <note>)`, fully
visible, never hidden; still present with verdict `fixed` renders as `(self-check claimed fixed,
still present)` — the one case worth calling out, since it is the record contradicting the diff it
describes. An id still **present** with verdict `needs-fix` renders as flagged (the author's own
agent found it and says it is not fixed yet); absent, it is dropped silently, same reasoning as an
absent `explained` entry. `addressed`/`explained`/`flagged` counts for §2.4 come straight out of
this comparison.

### 2.4 Rendering

One advisory line, next to the captain line, never inside the five-fact cap or the gate:

```
author agent self-checked: 4 facts addressed, 1 explained, 1 flagged as still needing a fix · not part of the review decision
```

No record on head → the line is omitted, not shown as zero. Every id unmatched (hallucinated or
stale) → "self-check present but could not be matched to this diff," never a false "0 addressed."

### 2.5 Measurement: does a self-checked PR carry fewer real issues into review?

Both legs are pre-registered in `docs/experiments.md` before any run starts, `docs/experiments.md`'s
own convention; neither is a proxy — the first is a real coding-agent run against a real diff, the
second is this repo's own PRs.

**(a) Replay, PAID, primary.** Take ~20 of the field test's ~50 PRs
(`docs/research/2026-10-19-field-test.md`), stratified over its 15 TRUE+USEFUL facts plus a sample
of NOISE. For each, check out the diff before any review round, build the brief, and run a real
Claude Code agent session on the updated skill (§2.2): read the brief, fix or explain every item,
produce a self-check record. Grade the record and any edits against the field test's own labels —
fixed the true+useful, explained away the noise, waved off nothing real. **Caveat:** the field test
graded captain facts only, not hunks/checks, so that half needs a small fresh grading pass too, not
a blocker to starting. **Cost.** No agent-run benchmark exists yet here to price from — the closest
comparable is the judge's single-call price (~$0.035 standard/commit, Sonnet 5 low,
`docs/experiments.md`), but a multi-turn session with tool use costs more and cannot batch. **Pilot
5 PRs first** (~$1–$3, Sonnet 5 effort medium, interactive) for a real per-PR number; near
$0.20–$0.60/PR, 20 PRs is **≈ $4–$12** — re-estimate and re-approve first if the pilot runs higher.

**(b) Dogfood, FREE, secondary.** Once the skill ships, track this repo's own PRs: the brief's item
count at self-check time against how many of the same items a later AI-review round or the captain
still flags. Descriptive, no control arm, small N — but free, and the long-run signal a one-time
replay cannot give.

### 2.6 Decision rule for shipping

Ship the skill/command changes (§2.2) when, on the replay study (a): **recall first** — at most 1
of the 15 true+useful facts gets a `fixed`/`explained` verdict that is wrong on inspection (the
agent waved off a real issue); **then precision** — at least half the `coupling.missing`-style
noise fires get a defensible (non-vacuous, human-checked) `explained` verdict; **cost ceiling** —
the pilot's $/PR, scaled to 20 PRs, stays under $15, else re-scope before re-running rather than
absorb it. The rendering (§2.3–2.4) ships independently once Phase 2's schema exists, reusing the
same ids — no LLM call or recall bar of its own.

## 3. Phase 2 — the reviewer-side verification pass (`llm.verify`)

The previous draft's design, rewritten against the memo's 15 implications (§5 there). Table first,
so the rewrite is checkable line by line; detail follows only where the previous draft's design
did not already hold up.

| # | Implication | Where this draft answers it |
|---|---|---|
| 1 | Correct the premise | §1, above |
| 2 | Finder ≠ verifier | §3.2: separate call, fresh context, never the call that produced the candidate |
| 3 | Evidence, not names | §3.2: a verdict with no cited line counts as `unknown`, not `drop` |
| 4 | Drop only by a named class | §3.2: the exact classes listed, nothing else is ever auto-dropped |
| 5 | Severity before the cap | §3.5: unchanged from the previous draft, confirmed |
| 6 | Pre-existing is a tag | §3.3: unchanged, `status` is independent of `action` |
| 7 | Priority: decided, not asked | §3.4: **decided** — verification never lowers captain priority |
| 8 | Recall before precision | §3.6: shipping rule orders them explicitly |
| 9 | Noise measured two ways | §3.6: response-based (O3) and clean-PR-based, both required |
| 10 | Rescore on every change | §3.4: prompt-hash discipline, borrowed from `results-llm.md` |
| 11 | Agent-reader noise costs more | §3.1: three pools confirmed, scope decided not just recommended |
| 12 | No repeats across pushes | §3.4: dismissal memory, keyed by content not sha |
| 13 | Depth follows risk | §3.4: quick-confirm PRs with only `info` facts skip the call |
| 14 | Fail open, never gate | §3.4: unchanged from the previous draft, confirmed |
| 15 | Wrong verdict → fix the cause | §3.6: a logged detector/prompt fix required before shipping, not optional |

### 3.1 Goal and scope (confirmed, not just recommended)

Same field-test numbers as before (`coupling.missing` 0 % precision on 18 fires, two
`contract.dependency` WRONG calls, 15 true+useful facts elsewhere) justify the pass on opendrs's
own data, not on Anthropic's. **Scope is decided: all three pools in one batched call** — captain
facts, `reviewFirst` hunks, `CheckItem` questions — because the brief reaches AI reviewers
(`docs/llm-reviewers.md`) where a wrong item costs a full round, not just a human's few seconds
(implication 11). Judge `risky_snippets` stays out for this increment; nothing about it is
field-test-measured yet.

### 3.2 What gets verified, and the schema

Unchanged pools and batching from the previous draft (one call per PR, each candidate with its own
small excerpt via `buildDiffText`'s per-hunk text, never the whole diff; same provider/structured-
output path as the judge, a new `VERIFY_SCHEMA` beside `JUDGEMENT_SCHEMA`). Two changes to the
output contract itself:

```ts
interface VerifyVerdict {
  id: string;                               // trusted; never read from the model
  action: "keep" | "drop" | "downgrade";
  droppedClass?: "docs" | "tests" | "fixtures" | "generated" | "formatting"; // required iff action is "drop"
  status: "new" | "pre_existing" | "unknown";
  citedLine?: string;                       // file:line the verdict rests on
  reason: string;                           // <= 200 chars
  confidence: number;                       // 0-10
}
```

- **`drop` requires `droppedClass`.** These five are opendrs's analogue of the article's "style,
  diagnostics or cleanup": a fact/hunk/question whose *only* subject is docs, tests, fixtures,
  generated files or formatting. Anything else the model wants to drop downgrades instead, visible
  at lower priority — nothing else is ever silently dropped.
- **`citedLine` absent → `unknown`, not the verdict given.** A `drop` with no cited line is
  re-labelled `downgrade` before rendering (implication 3); a `keep` needs no citation, since it
  changes nothing about what was already going to be shown.

Prompt-injection handling is unchanged: untrusted material wrapped as `buildMessages` wraps the
diff today; a candidate arguing for its own dismissal is grounds to `keep` it, never drop it.

### 3.3 NEW vs PRE-EXISTING

Unchanged from the previous draft: deterministic first (captain facts are `new` by construction;
`coupling.missing` has no new/pre-existing axis), a text-match check against `ctx.diff.base` for
hunks/questions, the LLM only for what neither resolves. `status` and `action` stay independent —
a `pre_existing` fact can still be `keep`, same as the article keeps Pre-existing findings visible
and only changes who is blamed (implication 6).

### 3.4 Architecture

**Where it runs, caching, provider, cost, failure behaviour:** unchanged (inside `buildBrief`,
before `fitBudget`; keyed by `(head sha, candidate hash)`; the judge's provider/parse path;
≈ $0.005–$0.01/PR batched; failing open shows everything, unlabeled, with a note). Four additions:

- **Priority is decided, not asked (implication 7).** Captain priority (`docs/captain.md` §2) is
  computed from the **unverified** facts, exactly as it is today; `llm.verify` changes what is
  shown and how, never `strong`/`info`, so it can never turn careful into standard. Ships without a
  flag: the article's own tier classifier is independent of its finding pipeline for the same
  reason, and a verifier able to soften a priority is one call away from suppressing the thing the
  captain brief exists to guarantee. Reversing this needs its own spec and evidence, not a flag here.
- **Depth follows risk (implication 13).** Skipped entirely — no call, no charge — on a PR whose
  unverified priority is quick-confirm *and* whose only candidates are `info` facts with no
  `reviewFirst`/`CheckItem` pool. Everything careful or standard, or with anything in those two
  pools, is verified.
- **Dismissal memory, not sha-keyed (implication 12).** The verifier's cache above is keyed by head
  sha and would forget a dismissal on the next push. Separately, a wrong/intentional/doesn't-matter
  verdict (O3, below) writes `.opendrs/facts.jsonl` keyed by a **content hash** (detector id + file +
  normalized text), not sha; every run checks it first, so a fact dismissed once renders
  `downgrade`d even after the diff moves and the sha-keyed cache misses.
- **Rescoring discipline (implication 10).** Any prompt, schema or model change is scored against
  the full fixture set (the ~50-PR corpus plus the clean-PR set, §3.6) before it ships, prompt hash
  recorded the way `results-llm.md` already does for the judge — a process rule, not new code.

### 3.5 Rendering

Unchanged: `keep` sorts normally; `downgrade` drops one weight tier before `sortFacts`, so it can
still appear when nothing stronger exists (severity before the cap, implication 5); `drop`ped
items never appear in the five-fact cap or short comment, but are listed in the brief's `notes` as
`dropped by verifier (<class>): <reason>` — an audit trail, not a disappearance.

### 3.6 Measurement plan

**(a) Precision study, PAID — reuse the field test's labels, as before.** ~50 PRs, once with
`llm.verify: false` (on record already) and once `true`; ground truth is the field test's TRUE+
USEFUL/NOISE/WRONG table for captain facts (a fresh small grading pass still needed for hunks/
checks). **≈ $0.25–$0.50 total**, Sonnet 5, effort low, Message Batches API.

**(b) Noise on known-clean PRs, PAID — the missing half of implication 9.** The field test's clean
PRs (no incident, no TRUE+USEFUL fact) are the free half, already labeled — just a different cut of
(a)'s run. The paid half folds into the paused ApacheJIT arm (`docs/experiments.md`, "Planned: LLM
plus opendrs vs the LLM alone," unrelated to this spec): **arm 4, verifier on arm 3's findings**,
same 1,200 commits, same bug-catching question plus a new one — on commits ApacheJIT did **not**
label buggy, how many facts/findings the verifier still keeps. **≈ $7–$9**, Sonnet 5, effort low,
batched, raising that experiment's total to **≈ $46–$48 of a ≈ $55 cap** — additive to, and gated
on, that experiment's own unpause decision, not unpaused here.

**(c) Per-fact feedback (O3), ships with the verifier.** `opendrs feedback --fact <id> --file
<path> --verdict wrong|useful|intentional|ignored`, appending to `.opendrs/facts.jsonl` — the file
§3.4's dismissal memory reads. The response-based half of implication 9, and the only way precision
gets tracked after launch instead of re-measured by hand. Ships with Phase 2, not deferred, since
the dismissal memory already needs the file to exist.

### 3.7 Decision rule for shipping

**Recall first, precision second (implication 8) — precision is not checked until recall clears:**
1. **Recall.** At most 1 of the 15 true+useful facts wrongly `drop`ped; any failure here stops the
   study and goes to implication 15 below before anything else.
2. **Precision.** `coupling.missing` 0 % → ≥ 70 % correctly `drop`/`downgrade`d (≥ 13 of 18); both
   `contract.dependency` WRONG fires marked `drop`/`downgrade`.
3. **Cost.** ≤ $0.02/PR at the chosen model (estimate $0.005–$0.01, headroom intact).

**Every recall miss, and every fact the study shows was wrongly dropped, produces a logged detector
or prompt fix before the pass ships (implication 15)** — the article's fix for a missed bug is more
context, not another pass, and opendrs has no convergence machinery to fall back on here. (b) ships
independently, gated on the existing experiment's own H1/H2 bars with the verifier as a third arm —
it neither blocks nor is blocked by (a).

## 4. Open questions, recommended first

1. **O2 (read the 18 `coupling.missing` noise cases) before Phase 2's precision study sets its
   target? (a) Yes, first — a day's reading that may remove the noise for free [recommended]
   (b) No, run the study on today's detector**
2. **Phase 1's pilot size before the full replay? (a) 5 PRs, re-estimate before going to 20
   [recommended: no agent-run cost data exists yet] (b) Go straight to 20**
3. **Release train** (v0.4.1 shipped, v0.5.0 in integration): **(a) Phase 1 joins v0.5.0, Phase 2
   targets v0.6.0 after its study [recommended: Phase 1 only changes docs/skill text] (b) both wait
   for v0.6.0**
4. **Model for Phase 2's verifier? (a) Same as `llm.model`, no new setting [recommended: §3.6(a)'s
   total is cheap enough that a second model buys little] (b) a cheaper `llm.verify.model`**
5. **Budget cap for `llm.verify`? (a) No new cap, rides the existing `llm.*` posture [recommended]
   (b) add `llm.verify.maxUsd`, fail open past it**

### 4.1 Decisions (approved 2026-10-20)

1. **O2.** Read the 18 noisy `coupling.missing` cases before Phase 2's precision study sets its
   target — free, do it first.
2. **Phase 1 pilot.** 5 PRs first; go to the full 20-PR replay only if the pilot looks sound
   (§2.5's cost/quality read, not a fixed rule).
3. **Release train (superseded 2026-10-20, same day, by §4.3 below).**~~v0.5.0 releases now,
   unchanged by this spec. Phase 1 (skill/command + self-check plumbing) ships in v0.6.0. Phase 2
   (`llm.verify`) ships in v0.7.0, after its own studies (§3.7) pass.~~
4. **Verifier model.** Sonnet 5.
5. **Budget cap.** A hard cap of **$60 across all paid studies** (Phase 1's replay, Phase 2's
   precision and noise studies), plus a per-PR token cap set in config. **All paid studies wait on
   the user's API key — not provided yet. Do not run any paid study without it.**

### 4.2 Revision (2026-10-20, same day): the user has ~$57 of API credit, usable once

Supersedes §2.5's and §3.6's cost framing, not their study designs:

- **No paid study runs now.** Nothing in this spec authorizes spending the credit yet.
- **Phase 1's pilot (§2.5a, 5 PRs) and the full replay (20 PRs) run on the user's Claude
  subscription via the logged-in `claude` CLI** — the user runs the agent-under-test from their own
  terminal, the same way the skill-eval worker runs its hill-climb — **not the API**. Zero API
  spend for Phase 1. The $/PR estimates in §2.5 no longer apply to Phase 1; they were priced for an
  API-billed run that is not how Phase 1 is now measured.
- **Phase 2's precision study (§3.6a, ≈ $0.25–$0.50) is the only planned API spend**, and only
  after Phase 2 is built — the one item the $57 is for.
- **Phase 2's noise-on-known-clean-PRs study (§3.6b, the ApacheJIT arm 4, ≈ $7–$9) is deferred.**
  Run it only if a headline benchmark claim later needs it, and only on the user's explicit
  decision at that time — not scheduled by this spec.
- **The $60 hard cap (§4.1.5) stays the outer bound** on whatever paid study work does end up
  running, unchanged by this revision.

### 4.3 Revision (2026-10-20, same day): no routine release — supersedes §4.1's item 3

**v0.5.0 will not be cut now.** The merged v0.5.0 batch stays unreleased on `main`. There is no
release until Phase 2 ships and its studies (§3.7) give measured improvements worth claiming;
**Phase 1 and Phase 2 then ship together in that one release**, not separately. Until then,
CHANGELOG entries for both phases stay under `## Unreleased`. This replaces §4.1 item 3's
v0.5.0-now / v0.6.0 / v0.7.0 train; nothing else in §4.1 or §4.2 changes.

### 3.8 Noise classes: the 18 `coupling.missing` field-test fires (O2, read 2026-10-22)

Every one of the 18 fires (`docs/research/2026-10-19-field-test.md`; session notes in
`~/.cache/opendrs/field-test/notes/`) was re-read against its diff. They fall into four classes.
Three are decidable from the diff and the partner file alone, so they are fixed **in the detector**
(implication 15: a wrong verdict is fixed at its cause, not papered over by another pass). Only the
fourth needs the verifier.

| Class | Rule (deterministic unless noted) | Field-test fires | Detector action |
|---|---|---|---|
| **A. Retired file** | The firing file is *deleted* in this PR. A file that is going away has no partner left to update; the historical pairing is stale by construction. | black d078e8e: 5 facts (`post_release.yml`, `publish_binaries.yml` and their `diff_shades*.yml`/`fuzz.yml` partners, during a wholesale pipeline rewrite) | **not emitted** |
| **B. Partner lacks the subject** | Every hunk in the firing file removes lines (a modification, not a pure addition), and *no* identifier on those removed lines (`[A-Za-z_][\w.@/-]{2,}`) occurs anywhere in the partner at base. A pure addition is exempt: the partner may need the same addition, which is exactly the case the fact exists for. | vite 77d837351: 10 facts (renovate bumped `oxlint` in one template; the partner templates carry no `oxlint` at all); likely actix 3bb00075 (`experimental-io-uring` removed from `ci.yml`; `ci-post-merge.yml` never had the entry) | **downgraded** to `info`, text ends `Downgraded: the lines changed in `<file>` mention nothing `<partner>` contains.` |
| **C. Test fired on its source** | The firing file matches `paths.tests` and the partner does not. A test that changed without its source is a test-only addition, not a forgotten co-change. | black 27c6fd0: 1 fact (`tests/test_black.py` without `src/black/__init__.py`, a focused regression test for a perf fix elsewhere) | **downgraded** to `info`, text ends `Downgraded: a changed test without its source partner is a test-only change.` |
| **D. Added subject has no counterpart** (semantic) | The PR *adds* something to the firing file (a CLI option, a schema key) whose kind of thing the partner does not model. Needs reading both files. | black 1ed66a8: 1 fact (`black.schema.json` gained `--cache-dir`, a path option; `Mode` in `mode.py` has no field for it) | left to `llm.verify` (§3.2), which sees the fact, the hunk and the partner excerpt |

Classes A–C cover 16–17 of 18 fires for free; the verifier's own target (§3.7 item 2) is therefore
measured on the whole pipeline, detector classes included, and reported separately for the facts
that reach the LLM. A detector downgrade changes `weight`, so it *can* lower captain priority (a
yellow PR with only an `info` coupling fact is "standard", not "careful") — that is a detector fix
and is meant to; the verifier's own `downgrade` never does (§3.4).

### 3.9 Build decisions (2026-10-22)

- **No sha-keyed verifier cache.** §3.4 inherited a `(head sha, candidate hash)` cache from the
  first draft; it is not built. The batched call costs about a cent, the Action is ephemeral, and
  the dismissal memory (content-keyed, below) is what stops repeats across pushes. Reconsider only if
  measured spend says otherwise.
- **Ids.** Candidates reuse Phase 1's ids (`src/brief/selfcheck.ts`: `factId`, `hunkId`, `checkId`),
  so a self-check entry, a verifier verdict and a `feedback --fact` dismissal all name the same thing.
- **Pre-existing, deterministically.** Captain facts are `new`, except `coupling.missing` which is
  `unknown` (no new/pre-existing axis). A `reviewFirst` hunk or a check is `pre_existing` when every
  non-blank added line of its hunk already occurs verbatim in the file at base, else `new`. The
  model fills `status` only where that leaves `unknown`.
- **Downgrade for hunks and checks.** A fact drops one weight tier (`strong` → `info`) and re-sorts.
  A hunk moves to the end of its file's list and stops counting toward the file's score (so the file
  re-sorts too); a check moves to the end of the checks list. All three keep their text and gain a
  visible `[downgraded by verifier: <reason>]` suffix.
- **Dismissal memory** is `.opendrs/facts.jsonl`, read from the **base** commit like
  `.opendrs/incidents.jsonl` (a PR cannot dismiss its own facts), written by
  `opendrs feedback --fact <factId> --verdict wrong|useful|intentional|ignored [--note]`. The key is
  `sha256(id + "\0" + file + "\0" + normalizedText)` where `normalizedText` replaces every digit run
  with `#` and collapses whitespace (so "14 of 17 commits" and "15 of 18 commits" match). `wrong`,
  `intentional` and `ignored` downgrade the fact without an LLM call (`[downgraded: dismissed earlier
  as <verdict>]`); `useful` pins it — a verifier `drop` or `downgrade` on a pinned fact is turned into
  `keep`.
- **Fail open.** Any verifier error (provider, parse, schema, token cap) leaves every candidate
  `[unverified]` and adds one note, `verifier failed: <reason>; everything below is unverified`.
  Nothing is dropped or downgraded on an error.
- **Rescoring metadata.** The brief records `verification.model` and `verification.promptHash`
  (first 12 hex of sha256 over the system prompt and the output schema) plus token usage; the
  precision study records them beside its numbers, the way `results-llm.md` does for the judge.
- **Per-PR token cap.** `llm.verify.maxTokens` (default 40 000) bounds the estimated prompt size
  (`src/brief/budget.ts`'s chars ÷ 3.5); a larger prompt skips the call and fails open with the note
  `verifier skipped: prompt of N tokens exceeds llm.verify.maxTokens (40000)`.

## 5. Risks

- **Phase 1's agent-replay cost is a genuine unknown** until the 5-PR pilot runs; §2.5 prices a
  range on purpose, not a number.
- **Phase 1's record is self-reported.** §2.3 catches only the checkable case (claimed-fixed-but-
  still-present), not a plausible-sounding wrong explanation — why it stays advisory text, never a
  reason to skip anything.
- **Phase 2's dismissal memory (§3.4) is new persistent state**, the same class of risk
  `.opendrs/incidents.jsonl` already carries: dogfood on this repo's own PRs first.
- **No iteration in either phase** — one agent pass, one verifier pass, no loop. Neither builds
  Anthropic's convergence machinery, which solves a different problem opendrs does not have.
