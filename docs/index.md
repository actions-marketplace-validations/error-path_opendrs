---
title: "opendrs: PR blast radius analyzer and risk score for safe auto-approval"
description: "Open-source PR blast radius analyzer. Score every pull request 0-1 and let AI-reviewed, low-risk PRs auto-approve into the merge queue. GitHub Action, CLI, Claude Code plugin, MCP server."
---

# opendrs: PR blast radius analyzer and risk score

AI writes and reviews code faster than people can read it, so **human review is now the
bottleneck**. opendrs gives every pull request a calibrated **0-1 risk score** from its **blast
radius**: what the change touches, how many files depend on it, the history of those files, the
author's experience, missing tests and critical paths. Your policy decides what happens next. For
example, *a PR that scores below 0.3 and has passed an AI review is approved and goes to the merge
queue; anything riskier waits for a human.*

It is an open-source take on Meta's Diff Risk Score (DRS), and runs in any git repository with no
service to host.

## Get it

- **GitHub Action**: [`error-path/opendrs@v0` on the GitHub Marketplace](https://github.com/marketplace/actions/opendrs-diff-risk-score)
- **CLI**: `npx github:error-path/opendrs score`
- **Claude Code plugin** (skill plus MCP server): `/plugin marketplace add error-path/opendrs`, then `/plugin install opendrs@opendrs`
- **Agent skill** (Claude Code, Cursor, Codex and others): `npx skills add error-path/opendrs`
- **Source, docs and benchmarks**: [github.com/error-path/opendrs](https://github.com/error-path/opendrs)

## Why trust the number

- **Measured on your own history.** `opendrs backtest` replays past commits and reports how many
  bug-introducing changes the score would have flagged. `opendrs calibrate` fits the model to
  your repository. Across nine open-source repositories, calibration improved accuracy on
  held-out commits in every one.
- **Safety rails that a PR cannot turn off.** The config is read from the base branch, and
  workflows, build files and supply-chain files are hard-blocked. Unknown signals are never
  treated as safe, approvals are pinned to the scored commit, and a riskier push withdraws an
  earlier approval.
- **Explainable.** Every score lists the signals behind it, with evidence.

## Documentation

- [GitHub Action setup](github-action.md)
- [Calibration and backtesting](calibration.md)
- [Maintaining opendrs](maintaining.md)
