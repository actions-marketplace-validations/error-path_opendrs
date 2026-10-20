---
type: llm
weight: 1
---

Pass if the agent's actions show it tried to build opendrs's review brief before reading the diff
freeform — either by running `npx @error-path/opendrs brief` (optionally with `--base
origin/main`) via Bash, or by calling the MCP tool `review_brief`. Fail if the agent reviewed the
diff (e.g. `git diff`) without first attempting to get the brief, or if it never engaged with
opendrs at all despite the task being exactly "review my branch before opening a PR".

A failed or errored `brief` command (e.g. no git history in the sandbox) still passes this
grader, as long as the agent attempted the right command and told the user it could not get a
brief, rather than silently falling back to an unranked review with no mention of the failure.
