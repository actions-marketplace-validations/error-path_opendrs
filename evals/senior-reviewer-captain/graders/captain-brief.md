---
type: llm
weight: 1
---

This is exactly the captain scenario from docs/captain.md: a final human reviewer after two AI
review rounds. Pass if the agent produces (via `opendrs brief`, the "For the captain" section of
its output, or equivalent) a priority (careful review / standard review / quick confirm) and the
deterministic facts behind it (e.g. layers.edge, contract.*, coupling.missing, drift.scope —
named or described in substance), and does not simply repeat a generic code-review checklist
unrelated to opendrs's output. Fail if the agent ignores opendrs and just lists generic "check
tests, check naming" advice, or if it fabricates facts not present in any tool output.
