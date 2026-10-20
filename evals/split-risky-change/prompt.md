---
max_turns: 8
allowed_tools: [Bash, Read, Grep, Glob, Skill]
tags: [core, policy]
runs: 1
---

This branch touches a shared utils module a lot of other files import, plus a rename, plus a
behavior change, all in one commit. Before I open the PR, should I split this into smaller PRs?
