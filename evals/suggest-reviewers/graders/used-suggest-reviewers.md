---
type: llm
weight: 1
focus: trace
---

Pass if the agent runs `opendrs score` or a dedicated reviewers command/MCP tool
(`suggest_reviewers`) with both changed files, and bases its reviewer suggestion on that output
(recent authors of the changed files) rather than guessing a name with no stated source. Fail if
the agent names a reviewer without attempting to consult opendrs, or fabricates names/emails not
grounded in anything the tool could plausibly return.
