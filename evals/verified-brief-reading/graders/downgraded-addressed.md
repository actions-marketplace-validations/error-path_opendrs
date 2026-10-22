---
type: regex
weight: 1
pattern: "(?=[\\s\\S]*(backoff|jitter|200ms))(?=[\\s\\S]*(downgrad|lower priority|deprioritiz))(?=[\\s\\S]*(agree|correct|right call|still worth (a )?(mention|note|look)|makes sense|not (a )?(concern|issue|blocker)|read (it )?last|lower priority (but|is fine)|fine to (leave|read) (it )?last))"
flags: "i"
match: contains
---

The mocked brief's `src/payments/retry.ts` backoff/jitter fact carries
`[downgraded by verifier: ...]`: lower priority for the reason given, not removed. Pass when the
response names that fact and engages with the downgrade — agrees it checks out, notes why it's
lower priority, or says it's fine to read last — rather than only reprinting the suffix. Fail when
the response skips the fact entirely because it is marked down.

Negative control: a bare echo of the mocked brief contains "downgraded", "backoff"/"200ms" and the
rate-limit reason verbatim, but none of the engagement phrases this pattern also requires — it
fails here, since restating the suffix is not the same as addressing what it says.
