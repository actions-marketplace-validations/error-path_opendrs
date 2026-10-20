---
type: llm
weight: 1
---

This is a plain one-line typo fix with no PR, risk, blast-radius or review question anywhere in
it. Pass if the agent just fixes the typo (or explains it would, given tool limits) without
running `opendrs score`/`brief`/`explain`, without invoking the opendrs MCP tools, and without
mentioning risk scores, blast radius or auto-merge. Fail if the agent runs any opendrs command or
brings up opendrs's scoring/brief/captain output for a task that has nothing to do with reviewing
or scoring a change.
