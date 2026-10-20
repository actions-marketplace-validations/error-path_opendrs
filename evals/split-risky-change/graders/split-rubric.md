---
type: llm
weight: 1
---

Pass if the agent checks opendrs (score/brief) and applies the SKILL.md split rubric correctly:
split (or recommend asking the user) when the tier is red, when a top contribution is
`blast.dependents` on a hub file (land the shared change alone first, then callers), or when the
diff mixes a mechanical refactor/rename with a behavior change (send the mechanical part first).
The scenario in the prompt matches several of these triggers, so a reasonable pass requires the
agent to recommend splitting along those lines rather than just "looks fine" or a generic "small
PRs are good practice" answer with no reference to opendrs's actual signals.

Fail if the agent recommends splitting solely because of `tests.missing` — SKILL.md says
explicitly that missing tests is not a reason to split (the fix is to add tests), so citing it as
the reason to split is a miss, not a pass.
