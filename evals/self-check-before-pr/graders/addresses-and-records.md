---
type: llm
weight: 1
---

Pass if the agent's final answer: (a) addresses every self-check item it obtained, by either
fixing the underlying issue or giving a short reason (around a sentence, not a paragraph) it does
not need fixing, (b) writes or clearly proposes the exact verdicts as a
`<!-- opendrs-self-check:v1 ... -->` JSON block to be added to the end of the head commit's own
message — not a separate commit and not the PR description, and (c) states plainly that this
record is advisory only and does not affect the auto-approve gate, the score, or the captain's
priority. Fail if any self-check item is left unaddressed, if the block is placed somewhere other
than the commit message, or if the agent claims or implies the self-check record changes the
score, tier, or approval decision.
