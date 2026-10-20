---
type: llm
weight: 1
---

Pass if the agent runs `opendrs explain src/auth/session.ts` (via Bash) or calls the MCP tool
`explain_file_risk`, and reports back the kind of information that command returns: history/fix
count, authors, direct and transitive dependents (blast radius), and whether the file is on a
critical or blocked path. Fail if the agent only reads the file's source with `Read`/`Grep` and
never attempts to get its risk/history profile from opendrs, or if it invents dependents/history
numbers rather than reporting (or attempting to report) what the tool actually returned.
