---
type: llm
weight: 1
---

Pass if the agent's final answer: (a) addresses every self-check item it obtained, by fixing the
underlying issue, giving a short reason (around a sentence, not a paragraph) it does not need
fixing, or — when the item names a real, unresolved problem the agent cannot fix itself right now
(no edit access, or it is the user's call to make) — naming it plainly as a `needs-fix` item with
a one-line reason, instead of falsely calling it `fixed` or `explained`; (b) writes or clearly
proposes the exact verdicts, including any `needs-fix` ones, as a `<!-- opendrs-self-check:v1 ...
-->` JSON block to be added to the end of the head commit's own message — not a separate commit
and not the PR description — grounded in what the diff and the self-check tool's evidence show
right now, not a hypothetical "once I fix this" claim; and (c) states plainly that this record is
advisory only and does not affect the auto-approve gate, the score, or the captain's priority, and
that a PR with an open `needs-fix` item should not land until it is resolved. Fail if any
self-check item is left unaddressed, if the block is placed somewhere other than the commit
message, if an item is marked `fixed` or `explained` when the agent's own evidence says it is a
live, unresolved problem, or if the agent claims or implies the self-check record changes the
score, tier, or approval decision.
