---
type: regex
weight: 1
pattern: "(?=[\\s\\S]*(backoff|jitter|200ms))(?=[\\s\\S]*(downgrad|low(?:er)? priority|deprioritiz))(?=[\\s\\S]*(agree|correct|right call|still worth (a )?(mention|note|look)|makes sense|not (a )?(concern|issue|blocker)|read (it )?last|low(?:er)? priority (but|is fine)|fine to (leave|read) (it )?last|probably fine|check (?:the (?:stated )?reason|it) yourself|leave it(?: out of (?:this )?(?:scope|pr))?|out of scope|no (?:further )?action|that checks out|sounds (?:right|fine)))"
flags: "i"
match: contains
---

The mocked brief's `src/payments/retry.ts` backoff/jitter fact carries
`[downgraded by verifier: ...]`: lower priority for the reason given, not removed. Pass when the
response names that fact and engages with the downgrade — agrees it checks out, notes why it's
lower priority, says it's probably fine / low priority / out of scope, or tells the reader to
check the stated reason themselves — rather than only reprinting the suffix. Fail when the
response skips the fact entirely because it is marked down.

Negative control: a bare echo of the mocked brief contains "downgraded", "backoff"/"200ms" and the
rate-limit reason verbatim, but none of the engagement phrases this pattern also requires — it
fails here, since restating the suffix is not the same as addressing what it says.
