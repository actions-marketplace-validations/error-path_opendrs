---
max_turns: 10
allowed_tools: [Read, Grep, Glob, Skill]
tags: [core, brief, verify]
runs: 1
---

I'm on `feat/payment-retry` and about to open the PR against `origin/main`. Can you review the
change? The brief opendrs gave me has some verifier marks on the facts — things like
`[verified · new]`, `[verified · pre-existing]`, `[downgraded by verifier: ...]`, `[unverified]`,
and a note about something being dropped — and I don't know what they're supposed to mean for how
I review this.
