# Verification pass: checking captain facts and brief findings before they reach a human

Status: draft spec, written 2026-10-20 for the user's review. Nothing is built yet. The user
chose "Approach B — the verification pass" (`docs/research/2026-10-20-code-review-at-anthropic.md`):
before opendrs surfaces anything to a reviewer, an LLM verifier re-checks each candidate finding
against the actual diff and repo context, and every finding is tagged NEW in this PR vs
PRE-EXISTING. Needs approval before an implementation plan is written.

## 1. Goal and success criteria

Anthropic's highest-leverage step, per their write-up, is voting before a finding posts ("a
separate group votes on each finding, and it only gets posted if enough of them agree it's real"),
plus a severity tag ("Important, Nit, or Pre-existing, so a bug the PR didn't introduce doesn't
look like the author's fault"). opendrs has no analogue: `requireSafe` (`docs/llm-judge.md`) gates
on one judge pass's diff-wide risk number, not individual findings; captain facts
(`docs/captain.md`) ship from deterministic detectors with no severity or provenance tag at all.

**The field test already measured the gap.** `docs/research/2026-10-19-field-test.md` hand-graded
every fired captain fact across six repos, ~50 PRs, as TRUE+USEFUL / NOISE / WRONG / MISSED:

| Fact | Fired | True+useful | Noise | Wrong | Precision |
|---|---:|---:|---:|---:|---:|
| `contract.api` | 10 | 8 | 2 | 0 | 80 % |
| `contract.dependency` | 7 | 5 | 0 | 2 | 71 % |
| `contract.env` | 2 | 2 | 0 | 0 | 100 % |
| `coupling.missing` | 18 | 0 | 18 | 0 | **0 %** |
| `layers.edge`/`cycle` | 1 | 0 | 1 | 0 | 0 % |

`coupling.missing` is 18 of 38 fired facts (47 %) and noise every time. That is the verifier's
target: drop its noise and the two `contract.dependency` wrong calls without touching the 15
facts already true+useful.

**Goal.** Raise precision of captain facts and review-brief items (fewer NOISE/WRONG, per the
field test's own taxonomy) without losing TRUE+USEFUL ones.

**Posture.** Opt-in under `llm.verify`, same posture as `llm.requireSafe`: needs `llm.enabled:
true`, off by default. Like the judge and the captain brief, **the verification pass never
approves or blocks a PR on its own** — it only changes what is shown and how it is labelled. The
score, the policy gate and `requireSafe` are untouched by this spec.

**Success criterion.** On the field test's graded PRs, `coupling.missing`'s precision rises from
0 % without a measurable drop in the 15 true+useful facts from the other types (§6).

## 2. What gets verified, and the output schema

Three pools, already built before this pass runs:

1. **Captain facts** (`ArchitectureFact[]`, `src/architecture/index.ts`): `layers.edge/cycle`,
   `contract.dependency/api/schema/env`, `coupling.missing`, `drift.scope`.
2. **Review-first hunks** (`ReviewBrief.reviewFirst`, from `rankHunks`): files/hunks opendrs tells
   a reviewer to read first, with their `reasons`.
3. **Check questions** (`CheckItem[]`, `src/brief/questions.ts`): the fixed-template questions.

Each candidate already carries a file, usually a line, and the evidence behind it. The verifier
adds nothing new to look at: it gets that evidence plus the one relevant hunk's diff text
(reusing `buildDiffText`'s per-hunk excerpting, `src/llm/prompt.ts`, not the whole diff), and is
asked whether the claim holds up.

**Output schema**, one entry per candidate, structured output the same way the judge does
(`src/llm/schema.ts`'s `JUDGEMENT_SCHEMA` pattern):

```ts
interface VerifyVerdict {
  id: string;          // the fact/hunk/check id being judged — trusted, never read from the model
  action: "keep" | "drop" | "downgrade";
  severity: "important" | "nit";
  status: "new" | "pre_existing" | "unknown";
  reason: string;       // <= 200 chars, one line
  confidence: number;   // 0-10
}
```

`action: keep` shows as-is; `drop` hides it from the short view but keeps it auditable (§5);
`downgrade` demotes it (`strong` fact → `info`; hunk drops from the top set; check question is cut
first when the budget trims). `severity` collapses Anthropic's three tags to two, since `status`
already carries what their "Pre-existing" tag means; `nit` is opendrs's analogue of their
style/cleanup findings, kept visible at lower priority rather than deleted (never-silently-drop,
§4). A missing or malformed verdict for an id defaults to `action: keep`, `status: unknown` (§4).

**Prompt-injection rules.** The verifier reads the same untrusted material the judge already does
(diff text, commit subjects, fact text built from author-controlled paths/identifiers), so it
inherits the judge's trust boundary: every untrusted block is wrapped the way `buildMessages`
wraps the diff today (`<untrusted_diff>`, `<untrusted_title>`, a new `<untrusted_fact>` per
candidate), `neutralise()` breaks forged closing tags, and the system prompt states that nothing
in those tags is an instruction — including an attempt to get the verifier to `drop` a real
finding. A candidate that looks like it is trying to talk the verifier into dropping it is itself
grounds to `keep` it at `severity: important`, mirroring the judge's existing rule.

## 3. NEW vs PRE-EXISTING tagging

**Deterministic first.** A captain fact exists only because something changed between base and
head (`layers.edge` on a new edge, `contract.dependency` on a name absent at base,
`contract.schema` on a changed path). By construction every captain fact's `status` is `new`; the
detectors answer this for free and the verifier is not asked to re-derive it. `coupling.missing`
flags a *missing* change, so new/pre-existing does not apply the same way — it is always `new` by
definition, and the verifier's job on it is purely `keep`/`drop`.

**Review-first hunks and check questions need a real check**: the lines are definitely changed,
but what the reviewer is really being asked to worry about can be old logic the diff only moved or
reformatted. Deterministic check, reusing the before/after text already in `ScoringContext.diff`:
every flagged line added (`+`) with no equivalent text in the file at `ctx.diff.base` → `new`;
flagged text (ignoring whitespace) matching text already at base in the same file (a move,
reformat or rename carried it across untouched, via the same `gitMaybe`/`git show <base>:<path>`
access already used for incident lookups in `src/brief/build.ts`) → `pre_existing`. Only when
neither resolves (mixed old/new logic in one hunk, or the file is new) does the candidate go to
the LLM, which sees both versions' text when available; `unknown` is a legitimate LLM answer.
This keeps the LLM out of the deterministic majority, the same split `requireSafe` already uses
(category safety is "decided by opendrs from the category name, not by the model").

## 4. Architecture

**Where it runs.** Inside `buildBrief` (`src/brief/build.ts`), after the detectors and
`rankHunks`/`checkQuestions` build their raw pools, before `fitBudget` and rendering. It consumes
the already-built context, facts, hunks and questions; it produces only verdicts, no new facts.

**Batching.** One LLM call per PR, not per candidate: every captain fact, review-first hunk and
check question goes into a single structured-output request, each with its own small excerpt (the
fact's text, or the one hunk a reason points at) — never the whole diff. A PR with 18
`coupling.missing` facts (vite, black) still costs one call.

**Caching.** Keyed by `(head sha, fact hash)` — a content hash of the candidate's identity
(`id`/`file`/`line`/`text` for a fact; file + hunk range + reasons for a hunk; question text for a
check), the same head-sha-scoped shape the Action's drift detector uses (`docs/captain.md` §4,
`firstHead`/`firstRun`). A rerun on the same head never re-pays for a verdict it already has; a
push invalidates every key because `head` changed. CLI: in-memory for the run. Action: persisted
wherever any other per-PR state would be (naming deferred to the implementation plan).

**Provider reuse.** The exact `LlmProvider` the judge uses (`src/llm/provider.ts`/`anthropic.ts`/
`openai.ts`), same config block, same structured-output mechanism (a new `VERIFY_SCHEMA` beside
`JUDGEMENT_SCHEMA`), same parse-and-clamp discipline as `src/llm/parse.ts`. No second provider.

**Cost/latency budget.** The verifier's input (a handful of fact texts plus one hunk excerpt each)
is far smaller than the judge's full-diff call. Using the Sonnet-5-effort-low batched rate already
measured in `docs/experiments.md` (≈ $0.0175/commit batched for a full-diff call), a call at
roughly a third to a half that input size is estimated at **≈ $0.005–$0.01 per PR, batched**, plus
one extra round-trip of latency (seconds, not the minutes `calibrate`/`backtest` struggle with).

**Failure behaviour.** A failed verifier call (timeout, malformed reply, no key, provider error)
**never silently drops a fact**: every candidate renders exactly as it would with `llm.verify`
off, with a note ("verification unavailable: <reason>") attached, no `status`/`severity` shown.
Mirrors the judge's contract ("the signal is unknown... cannot be auto-approved"), but failing
open here means *showing more*, not blocking.

## 5. Rendering

- **Captain line / PR comment (five-fact cap, `docs/captain.md` §5):** `keep` facts render first,
  sorted as `sortFacts` does today; `downgrade` drops one weight tier (`strong` → `info`) before
  that sort, so it is less likely to make the top five but not hidden outright. `drop`ped facts
  never appear in the captain line, the five-fact cap, or the `captain:*` label.
- **Audit trail:** every `drop`ped fact, hunk or check question is listed in the brief's `notes`
  as `dropped by verifier: <reason>` — visible to an AI reviewer or anyone reading the full brief,
  never in the short PR comment. This turns the field test's `coupling.missing` complaint into an
  answer: the noise stops cluttering the five-line summary without vanishing untraceably.
- **Review-first / Check specifically:** same split — `keep` normal, `downgrade` sorted lower
  (first cut if `fitBudget` trims), `drop` removed and recorded in `notes`, with `status`/
  `severity` rendered as a short suffix, e.g. `(new, important)` / `(pre-existing)`.

## 6. Measurement plan

Pre-registered here; no paid run starts before approval (`docs/experiments.md`'s own convention).

### (a) Precision study — reuse the field test's hand labels, PAID

**Setup.** Re-run `opendrs brief` on the same ~50 PRs across the six field-test repos, once with
`llm.verify: false` (today's output, already on record) and once with `true`. Ground truth: the
field test's own TRUE+USEFUL/NOISE/WRONG/MISSED labels — no new human grading needed for captain
facts. Review-first hunks/checks weren't individually hand-graded there, so ground truth here
covers facts only; a small fresh grading pass for hunks/checks is a caveat, not a blocker.

**Metrics.** Precision of captain facts (keep-only true+useful ÷ keep-only fired, against §1's
table); recall (of the 15 true+useful facts, how many get wrongly `drop`ped); tokens and $ per PR.

**Cost.** ~50 PRs, ~38 fired facts, one batched call per PR: **≈ $0.25–$0.50 total**, Sonnet 5,
effort low, Message Batches API — same model the judge defaults to, reusing its validated
prompt/parse path. A cheaper model is worth trying once these numbers exist, not on the first
run: this is a narrow "does the claim hold up" judgment close to the judge's own
hunk-classification, and the total bill is already small enough that starting cheaper buys little.

### (b) Bug-finding — fold into the paused ApacheJIT experiment, PAID, gated on its own unpause

`docs/experiments.md`'s "LLM plus opendrs vs the LLM alone" is paused pending budget approval
(arms 1–3, ≈ $38.6 of a $43 cap; unrelated to this spec). This adds **arm 4: LLM + opendrs + the
verification pass** — arm 3's decision layer, but every finding is first run through the verifier
and `drop` verdicts are excluded before the commit-level score and `requireSafe` see them.
Different question from (a): not "are captain facts noisy" but "does filtering/tagging the LLM's
own findings change bug-catching precision or the gate's buggy share," on the same 800 test + 400
training commits already seeded.

**Cost.** One more pass over the same 1,200 commits, smaller input than arm 1's findings call
(verifying, not generating): **≈ $7–$9** at Sonnet 5, effort low, batched (roughly half arm 1's
$14.0, scaled for input size) — raising that experiment's total to **≈ $46–$48 of a ≈ $55 cap**.
Additive to, and gated on, the same unpause decision as the existing experiment; not unpaused here.

## 7. Decision rule for shipping

Ship `llm.verify` opt-in when **(a)** clears on its own:

- **Precision:** `coupling.missing` rises from 0 % to ≥ 70 % `keep`-rate correctness on the 18
  field-test fires (≥ 13 of 18 noise fires correctly `drop`ped), **and** both `contract.dependency`
  WRONG fires are marked `drop`/`downgrade`.
- **Recall:** at most 1 of the corpus's 15 true+useful facts wrongly marked `drop`.
- **Cost:** ≤ $0.02 per PR at the chosen model (§6(a) estimates $0.005–$0.01, leaving headroom).

Small, non-random sample (~50 PRs, one hand-grader) — a point-estimate bar, not a
confidence-interval one, the same reading the field test itself got in `docs/experiments.md`.

**(b)**, if and when it runs, ships only if it clears the existing experiment's own H1/H2
confirmatory bars (paired bootstrap 95 % CI above 0, Holm-corrected) with the verifier arm added
as a third comparison, reusing that machinery rather than inventing a new one. Neither blocks the
other: (a) can ship as a brief/captain-only feature on its own evidence; (b) is strictly about
whether verification also helps the LLM-plus-opendrs ranking question, already gated separately.

## 8. Risks and open questions

**Risks.**
- **Added spend/latency on every brief** once on — mitigated by batching (§4) and opt-in default.
- **A second prompt-injection surface** — inherits, must not expand, the judge's trust boundary.
- **Verifier bias toward over-filtering.** Anthropic's own write-up names this risk obliquely
  (their three-round convergence cap exists because repeat rounds mostly re-found old bugs, not
  new ones); a verifier too eager to `drop`/`pre_existing` could suppress real findings. §7's
  recall bar is the direct guard, and `drop`s staying visible in `notes` (§5) is the audit trail
  that would catch it in dogfooding before the paid study runs.
- **No iteration.** A single pass, not a loop — no verifier-of-the-verifier, nothing like
  Anthropic's multi-round convergence machinery, which solves a different problem (an agent and a
  reviewer going back and forth) opendrs doesn't have.

**Open questions**, recommended answer first:

1. **Opt-in or default-on for `llm.verify`?**
   **(a) Opt-in, needs `llm.enabled: true` [recommended: matches `llm.requireSafe`'s precedent]**
   (b) Default-on whenever `llm.enabled: true`
   (c) A separate top-level flag, independent of `llm.enabled`

2. **Which model?**
   **(a) Same as `llm.model` (Sonnet 5 default), no separate setting [recommended: fewer config
   knobs, reuses the validated prompt/parse path; §6(a)'s $0.25–$0.50 total is cheap enough that a
   second model buys little]**
   (b) A new `llm.verify.model`, defaulting cheaper (e.g. Haiku) than the judge
   (c) Run the precision study once on the default model, then decide

3. **A budget cap for `llm.verify`?**
   **(a) No new cap; rides the same `llm.*` posture the judge already has [recommended: no
   existing per-PR LLM cost cap in this codebase to extend]**
   (b) Add `llm.verify.maxUsd`, fail open past it per §4

4. **Block shipping on (a), (b), both, or neither?**
   **(a) Block only on (a); (b) is additive to an already-paused experiment and can run later on
   its own unpause decision [recommended]**
   (b) Block on both before shipping anything
   (c) Ship unconditionally once built, treat (a) as a post-hoc check
