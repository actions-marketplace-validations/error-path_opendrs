---
type: regex
weight: 1
pattern: "(?=[\\s\\S]*(?:early[- ]return|in-flight guard|retryIdempotencyKey))(?=[\\s\\S]*charge\\.ts(?:(?!\\n\\n)[\\s\\S]){0,300}?(?:\\bI\\b[\\s\\S]{0,60}\\b(?:check|read|verify|confirm|review|look)\\b|(?:check|read|verify|confirm|review|look)[\\s\\S]{0,60}\\bmyself\\b|\\b(?:still need to|haven't (?:yet )?(?:been )?verified|not (?:yet )?confirmed|requires (?:a|my own) (?:check|read|look))\\b))"
flags: "i"
match: contains
---

The mocked brief's `src/payments/charge.ts` fact — dropping the in-flight guard's early-return
when `opts.retryIdempotencyKey` is set — carries `[unverified]`: the verifier never reached it, so
it is exactly an ordinary, unverified brief item, not a cleared one. Pass when the response names
that fact and says, in its own voice and within the same stretch of text as `charge.ts`, that it
still needs to be read/checked/verified itself (a first-person checking phrase close to the
subject, not one borrowed from an unrelated sentence elsewhere in the answer), rather than
treating the `[unverified]` tag as having already answered the question.

Negative control: a response that just reprints the brief's markdown shows the `[unverified]` tag
next to the fact but adds no first-person verification language — it fails here, since quoting the
tag is not the same as doing the check the tag says is still outstanding.
