---
type: llm
weight: 1
focus: trace
---

Pass if the agent's actions show it tried to get the self-check items before answering — either
running `npx @error-path/opendrs brief --self-check-template` via Bash, or calling the MCP tool
`self_check_items`. Fail if the agent invents or describes a self-check record without ever
attempting either, or jumps straight to a commit message with no grounding in actual tool output.
A failed or errored attempt (e.g. Bash disabled) still passes this grader as long as the agent
tried the right thing and said so, the same way a failed `brief` attempt is treated elsewhere.
