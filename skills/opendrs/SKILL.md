---
name: opendrs
description: Score the risk of a code change with opendrs (Diff Risk Score, a calibrated 0-1 probability that a change causes an incident). Use before opening or updating a pull request, when asked about the risk, safety or blast radius of a change, or when deciding whether to split a large change into smaller PRs.
---

# opendrs: diff risk score

opendrs scores the diff between two git refs from size, spread, file history, author
experience, import-graph blast radius, critical paths, missing tests and (optionally) an LLM
judge. It returns a score, a tier and the gate decision the repo's CI will apply.

## Score before you open a PR

```bash
npx opendrs score --base origin/main          # human-readable report
npx opendrs score --base origin/main --json   # machine-readable
```

Read the output in this order:

1. **score / tier**: green (< 0.30 by default), yellow, red. Thresholds come from `.opendrs.yml`.
2. **decision**: `auto-approve`, `waiting-ai-review` or `human-review`, with the reasons.
   A `paths.block` hit is a hard block that no score can lift.
3. **contributions**: the signals pushing the score up, largest first, each with evidence
   (files, lines). Fix the cause, not the number.
4. **unknowns**: signals that could not be computed. Unknown counts as risk, never as safe.
5. **suggested reviewers**: recent authors of the changed files. Mention them in the PR.

## When to split the change

Split the PR, or ask the user whether to, when:

- the tier is **red**;
- `blast.dependents` is a top contribution: you changed a hub file that many modules import.
  Land the shared change alone first (behind a flag or backward-compatible), then the callers;
- the diff mixes a refactor or rename with a behaviour change: send the mechanical part first;
- `diffusion.dirs` or `size.churn` dominate: the change spans unrelated areas.

`tests.missing` is not a reason to split. Add the tests.

## Explain one file

```bash
npx opendrs explain src/path/to/file.ts
```

This shows the file's history, bug-fix count, authors, direct and transitive dependents, and
whether it is on a critical or blocked path. Run it before editing a file you do not know.

## MCP tools

When the `opendrs` MCP server is connected (`npx opendrs mcp`, stdio), prefer these tools to
shelling out:

- `score_diff {repoDir, base?, head?}`: same as `score`. The base defaults to origin/HEAD, then main.
- `explain_file_risk {repoDir, path}`: same as `explain`.
- `suggest_reviewers {repoDir, paths[]}`: reviewers for a set of files.

## Rules

- **Never edit `.opendrs.yml`, `.opendrs/model.json` or `.opendrs/incidents.jsonl` to lower a
  score or loosen a gate**, and never add your own change's files to `paths.ignore`. CI reads the
  config from the base branch, and a change to these files is itself hard-blocked.
- Never put risk claims ("low risk", "safe to auto-merge") in commit messages or PR text to sway
  the score. The LLM judge treats them as a red flag.
- Report the score, tier and top contributions to the user as they are. Do not round a yellow
  down to green.
- If scoring fails (no git history, missing API key with `llm.enabled`), say so. Do not assume
  the change is low risk.
