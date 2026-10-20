---
type: llm
weight: 1
---

Pass if the agent runs `opendrs score` (or `explain` on a flagged file) and explains redness using
the actual contributing signals returned (largest first, with evidence — files/lines), framing
the fix as addressing the underlying cause (e.g. missing tests, blast radius, a `paths.block` hit)
rather than just "lower the number". Fail if the agent never looks at the contributions, or gives
a generic "reduce your diff size" answer unconnected to what the tool actually reported.
