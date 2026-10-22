---
type: regex
weight: 1
pattern: "(?=[\\s\\S]*(?:429|gateway\\.ts)(?:(?!this (?:pr|change|branch) (?:adds|introduces|newly adds|added|introduced))[\\s\\S]){0,220}?(?:pre-existing|pre existing|already (?:the case|present|there)|before this (?:pr|change|branch)|not (?:introduced|added|new) by this (?:pr|change)))"
flags: "i"
match: contains
---

The mocked brief's `src/payments/gateway.ts` fact carries `[verified · pre-existing]`: it is real,
but it was already true before this PR touched the file. Pass when the response mentions that fact
(the 429-as-retryable behaviour in `gateway.ts`) using pre-existing framing — "already the case",
"before this PR/change", "not introduced/added by this PR" — within the same stretch of text (up
to ~220 chars after naming the fact) without first saying this PR itself "adds"/"introduces"/
"newly adds" that behaviour, which would misattribute a pre-existing fact to the PR under review.
The window is local to that fact's own sentence so a correct "this PR introduces <the new fact>"
said elsewhere, about the `[verified · new]` fact, does not trip this grader.

Negative control: the mocked brief's own text does not use the forbidden phrasing, so a bare echo
passes this grader — the point of this item is that the skill must say "pre-existing" accurately,
not that it must add anything the echo lacks; the other three graders carry that burden.
