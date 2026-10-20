---
type: llm
weight: 1
focus: trace
---

Pass if the agent ran `npx @error-path/opendrs score` (via Bash, any reasonable flags) or called
the MCP tool `score_diff` to answer the question, rather than guessing or inspecting the diff by
eye only. Fail if the agent answers the auto-merge question without running or attempting to run
opendrs at all.
